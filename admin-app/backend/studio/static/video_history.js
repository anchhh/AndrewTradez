/*
 * Past renders, for Create Video.
 *
 * Scenery files each run as a project, so it has somewhere to browse back to.
 * Video has no such thing -- a render lives on its job row and nowhere else --
 * so leaving the render page lost the way back to a clip that cost real money.
 * This is that way back: the same button-and-picker Scenery uses, reading the
 * job table instead of projects.
 *
 * Self-contained on purpose. It is included by two pages with different
 * scripts already loaded, so it declares nothing at the top level that either
 * of them might also declare.
 */
(function () {
  const byId = (id) => document.getElementById(id);

  let renders = [];

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function when(seconds) {
    if (!seconds) return "";
    const then = new Date(seconds * 1000);
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  const MOVE_NAMES = {
    push_in: "Push in", pull_out: "Pull out", pan_left: "Pan left",
    pan_right: "Pan right", orbit_left: "Orbit left", orbit_right: "Orbit right",
    rise: "Rise", tilt_up: "Tilt up", static: "Hold",
  };

  function matches(render, query) {
    if (!query) return true;
    const hay = [
      render.address,
      ...(render.clips || []).map((c) => MOVE_NAMES[c.move] || c.move),
      ...(render.clips || []).map((c) => c.resolution),
    ].filter(Boolean).join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).every((bit) => hay.includes(bit));
  }

  /* ---------- grouping ----------

     One row per HOME, not per render. Three runs on one listing were three
     near-identical rows differing only by cost, which is the hardest kind of
     list to scan. The home is what someone is looking for; which attempt is
     a detail inside it.

     Keyed on lead_id where there is one, because the address string is not
     reliable -- the same listing reached by a pasted link and by a lead can
     be spelled differently. Renders with no lead fall back to the address. */
  function groupRenders(list) {
    const groups = new Map();
    list.forEach((r) => {
      const key = r.lead_id != null ? "lead:" + r.lead_id : "addr:" + (r.address || "?");
      if (!groups.has(key)) {
        groups.set(key, { key, address: r.address, runs: [] });
      }
      groups.get(key).runs.push(r);
    });

    return [...groups.values()].map((g) => {
      g.runs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      g.newest = g.runs[0];
      g.running = g.runs.filter((r) => r.running).length;
      g.clips = g.runs.reduce((n, r) => n + (r.clips || []).length, 0);
      // The recomputed per-render cost, falling back to the stored estimate
      // for a row written before that field existed.
      g.cost = g.runs.reduce(
        (n, r) => n + (r.cost != null ? r.cost : (r.estimated_cost || 0)), 0);
      return g;
    }).sort((a, b) => (b.newest.created_at || 0) - (a.newest.created_at || 0));
  }

  /* Which homes are open. Groups of one never expand -- there would be a
     single row inside repeating the header -- so opening those goes straight
     to the clips. */
  const expanded = new Set();

  function runSummary(r) {
    const seconds = (r.clips || []).reduce((n, c) => n + (c.duration || 0), 0);
    if (r.running) {
      const done = r.clips_done || 0;
      const total = r.clips_total || 1;
      return `Rendering — ${done} of ${total} clip${total === 1 ? "" : "s"} done`
           + ` · started ${esc(when(r.created_at))}`;
    }
    const cost = r.cost != null ? r.cost : r.estimated_cost;
    return `${r.clips.length} clip${r.clips.length === 1 ? "" : "s"} · ${seconds}s`
         + ` · ${esc((r.clips[0] || {}).resolution || "")} · ${esc(when(r.created_at))}`
         + (cost != null ? " · $" + cost.toFixed(2) : "");
  }

  function thumbsFor(runs) {
    const clips = runs.flatMap((r) => r.clips || []).slice(0, 3);
    return clips.map((c) => `
      <video src="${esc(c.video_url)}#t=0.5" preload="metadata" muted></video>`).join("");
  }

  function renderList() {
    const list = byId("vh-list");
    const total = byId("vh-total");
    const empty = byId("vh-empty");
    if (!list) return;

    const query = (byId("vh-search").value || "").trim();
    const shown = renders.filter((r) => matches(r, query));
    const groups = groupRenders(shown);

    total.textContent = query
      ? `${groups.length} home${groups.length === 1 ? "" : "s"}, ${shown.length} render${shown.length === 1 ? "" : "s"}`
      : `${groups.length} home${groups.length === 1 ? "" : "s"} · ${renders.length} render${renders.length === 1 ? "" : "s"}`;
    empty.classList.toggle("hidden", shown.length > 0);

    list.innerHTML = groups.map((g) => {
      const single = g.runs.length === 1;
      // A search is a request to see the matches, so it opens what it found.
      const open = single ? false : (expanded.has(g.key) || !!query);
      const sub = single
        ? runSummary(g.runs[0])
        : `${g.runs.length} renders · ${g.clips} clip${g.clips === 1 ? "" : "s"}`
          + ` · $${g.cost.toFixed(2)} · latest ${esc(when(g.newest.created_at))}`;

      return `
        <div class="vh-group${open ? " is-open" : ""}" data-key="${esc(g.key)}">
          <button type="button"
                  class="vh-render vh-head${g.running ? " is-running" : ""}"
                  data-key="${esc(g.key)}"
                  ${single ? `data-id="${g.runs[0].id}"` : 'data-toggle="1"'}>
            ${g.running
              ? '<span class="vh-spin" aria-hidden="true"></span>'
              : `<span class="vh-thumbs">${thumbsFor(g.runs)}</span>`}
            <span class="vh-meta">
              <span class="vh-name">${esc(g.address)}</span>
              <span class="vh-sub">${sub}</span>
            </span>
            ${single ? "" : `
              <span class="vh-chev" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
                        stroke-width="1.6" stroke-linecap="round"
                        stroke-linejoin="round"/></svg>
              </span>`}
          </button>

          ${single ? "" : `
            <div class="vh-runs" ${open ? "" : "hidden"}>
              ${g.runs.map((r, i) => `
                <button type="button" class="vh-run${r.running ? " is-running" : ""}"
                        data-id="${r.id}">
                  <span class="vh-run-n">${g.runs.length - i}</span>
                  <span class="vh-meta">
                    <span class="vh-sub">${runSummary(r)}</span>
                  </span>
                </button>`).join("")}
            </div>`}
        </div>`;
    }).join("");

    // Straight to the results view on the render page, the way Scenery opens a
    // saved run on its own last step. Carrying the project when there is one
    // keeps "Render again" able to start a fresh run.
    function openRender(id) {
      const project = (window.__PROJECT__ || {}).id;
      const params = new URLSearchParams({ job: id });
      if (project) params.set("project", project);
      window.location.href = "/studio/create/render?" + params.toString();
    }

    list.querySelectorAll(".vh-head").forEach((head) => {
      head.addEventListener("click", () => {
        if (head.dataset.toggle) {
          const key = head.dataset.key;
          if (expanded.has(key)) expanded.delete(key);
          else expanded.add(key);
          renderList();
          return;
        }
        openRender(head.dataset.id);
      });
    });
    list.querySelectorAll(".vh-run").forEach((run) => {
      run.addEventListener("click", () => openRender(run.dataset.id));
    });
  }

  let poll = null;

  function watchRunning() {
    const anyRunning = renders.some((r) => r.running);
    if (!anyRunning) {
      if (poll) { clearInterval(poll); poll = null; }
      return;
    }
    if (poll) return;
    // Clips take minutes, so this is a slow refresh -- enough that a finished
    // render appears without being hunted for, not so much that it is chatter.
    poll = setInterval(load, 15000);
  }

  function openModal() {
    const box = byId("vh-modal");
    box.classList.remove("hidden");
    box.setAttribute("aria-hidden", "false");
    byId("vh-search").value = "";
    renderList();
    byId("vh-search").focus();
  }

  function closeModal() {
    const box = byId("vh-modal");
    box.classList.add("hidden");
    box.setAttribute("aria-hidden", "true");
    // Stop anything that was playing; a modal that keeps talking after it is
    // shut is its own bug.
    box.querySelectorAll("video").forEach((v) => v.pause());
  }

  function build() {
    if (byId("vh-modal")) return;
    const box = document.createElement("div");
    box.id = "vh-modal";
    box.className = "lead-modal hidden";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML = `
      <div class="lead-modal-backdrop" data-close></div>
      <div class="lead-modal-panel" role="dialog" aria-modal="true" aria-labelledby="vh-title">
        <header class="lead-modal-head">
          <h2 id="vh-title">Your renders</h2>
          <button type="button" class="lead-modal-x" data-close aria-label="Close">&times;</button>
        </header>
        <p class="hint">Grouped by home. Open one to see its renders; opening a
          render takes you to its clips.</p>
        <div class="search-field">
          <svg class="search-field-icon" viewBox="0 0 20 20" aria-hidden="true" fill="none"
               stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <circle cx="8.75" cy="8.75" r="5.25"/><path d="M12.6 12.6 16.5 16.5"/></svg>
          <input id="vh-search" type="search" autocomplete="off"
                 placeholder="Search by address, camera move…">
        </div>
        <p id="vh-total" class="lead-modal-count"></p>
        <div id="vh-list" class="vh-list"></div>
        <p id="vh-empty" class="empty-note hidden">No renders match that search.</p>
      </div>`;
    document.body.appendChild(box);

    box.querySelectorAll("[data-close]").forEach((n) =>
      n.addEventListener("click", closeModal));
    byId("vh-search").addEventListener("input", renderList);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !box.classList.contains("hidden")) closeModal();
    });
  }

  let wired = false;

  function load() {
    return fetch("/studio/api/video/jobs")
      .then((r) => r.json())
      .then((data) => {
        renders = data.renders || [];
        const button = byId("vh-open");
        if (!button) return;

        const running = renders.filter((r) => r.running).length;
        // No button until there is something behind it.
        button.hidden = renders.length === 0;
        // A render in progress is the reason someone opens this, so the
        // button says so rather than making them look.
        button.classList.toggle("is-running", running > 0);
        button.firstChild.textContent = running
          ? `${running} rendering… ` : "See renders ";
        const badge = byId("vh-count");
        if (badge) badge.textContent = renders.length ? String(renders.length) : "";

        build();
        if (!wired) {
          button.addEventListener("click", openModal);
          wired = true;
        }
        if (!byId("vh-modal").classList.contains("hidden")) renderList();
        watchRunning();
      })
      .catch(() => {});
  }

  load();
})();
