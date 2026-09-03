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
        groups.set(key, { key, address: r.address, lead_id: r.lead_id, runs: [] });
      }
      groups.get(key).runs.push(r);
    });

    return [...groups.values()].map((g) => {
      const all = g.runs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      // Cost over EVERY render for this home, including ones whose clips are
      // all in the trash. Deleting a clip does not refund it.
      g.cost = all.reduce(
        (n, r) => n + (r.cost != null ? r.cost : (r.estimated_cost || 0)), 0);
      g.trashed = all.reduce((n, r) => n + (r.trashed || 0), 0);

      // What can actually be opened is what has something left to show.
      g.runs = all.filter((r) => r.running || (r.clips || []).length);
      g.newest = g.runs[0] || all[0];
      g.running = g.runs.filter((r) => r.running).length;
      g.clips = g.runs.reduce((n, r) => n + (r.clips || []).length, 0);
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
    // Everything matching is grouped, trashed renders included: a home's
    // total spend must not fall because a clip was tidied away. What is
    // OPENABLE is filtered inside the group instead.
    const shown = renders.filter((r) => matches(r, query));
    const groups = groupRenders(shown).filter((g) => g.runs.length);

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
          + ` · $${g.cost.toFixed(2)} · latest ${esc(when(g.newest.created_at))}`
          + (g.trashed ? ` · ${g.trashed} in trash` : "");

      // What the row itself opens. A home with several renders and a lead
      // behind it opens ALL of them on one page -- visiting three pages to
      // see three clips of one house was the thing worth fixing. Without a
      // lead there is nothing to group by on the render page, so those open
      // their newest run.
      const opens = single || g.lead_id == null
        ? `data-id="${single ? g.runs[0].id : g.newest.id}"`
        : `data-lead="${g.lead_id}"`;

      return `
        <div class="vh-group${open ? " is-open" : ""}" data-key="${esc(g.key)}">
          <div class="vh-headrow">
            <button type="button"
                    class="vh-render vh-head${g.running ? " is-running" : ""}"
                    ${opens}>
              ${g.running
                ? '<span class="vh-spin" aria-hidden="true"></span>'
                : `<span class="vh-thumbs">${thumbsFor(g.runs)}</span>`}
              <span class="vh-meta">
                <span class="vh-name">${esc(g.address)}</span>
                <span class="vh-sub">${sub}</span>
              </span>
            </button>
            ${single ? "" : `
              <button type="button" class="vh-chev" data-toggle="1"
                      data-key="${esc(g.key)}"
                      aria-expanded="${open}"
                      aria-label="${open ? "Hide" : "Show"} the individual renders">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor"
                        stroke-width="1.6" stroke-linecap="round"
                        stroke-linejoin="round"/></svg>
              </button>`}
          </div>

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
    function go(params) {
      const project = (window.__PROJECT__ || {}).id;
      if (project) params.set("project", project);
      window.location.href = "/studio/create/render?" + params.toString();
    }

    /* A drone shot does not open on the render page. That page is the
       walkthrough tool -- a photo grid, a move per clip, a room picker --
       and none of it applies to one flight between two frames. Opening a
       drone render there showed the right clip under the wrong controls,
       with a Back button into a flow that never made it.

       So a render goes back to the stage that produced it: drone renders to
       the waiting page, which plays the clip and links on to the shot and
       the lead; everything else to the render page as before. */
    const isDrone = (r) => (r || {}).style === "drone";
    const runById = (id) => renders.find((r) => String(r.id) === String(id));

    function openRender(id) {
      const run = runById(id);
      if (isDrone(run)) {
        window.location.href =
          "/studio/create/video/rendering?job=" + id + "&style=drone";
        return;
      }
      go(new URLSearchParams({ job: id }));
    }

    function openLead(id) {
      // A home whose renders are ALL drone shots goes to the drone flow;
      // a mixed home keeps the render page, which can show both.
      const mine = renders.filter((r) => String(r.lead_id) === String(id));
      if (mine.length && mine.every(isDrone)) {
        window.location.href =
          "/studio/create/video/drone?lead_id=" + id + "&style=drone";
        return;
      }
      go(new URLSearchParams({ lead: id }));
    }

    list.querySelectorAll(".vh-head").forEach((head) => {
      head.addEventListener("click", () => {
        if (head.dataset.lead) openLead(head.dataset.lead);
        else openRender(head.dataset.id);
      });
    });
    list.querySelectorAll(".vh-chev").forEach((chev) => {
      chev.addEventListener("click", () => {
        const key = chev.dataset.key;
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        renderList();
      });
    });
    list.querySelectorAll(".vh-run").forEach((run) => {
      run.addEventListener("click", () => openRender(run.dataset.id));
    });
  }

  /* ---------- trash ----------

     Deleting a clip only marks it, so this is where it comes back from. The
     count is loaded whenever the picker opens, because "is there anything in
     the bin" is the question the button has to answer before it is clicked. */
  let showingTrash = false;
  let trashed = [];

  function syncTrashUi() {
    const toggle = byId("vh-trash-toggle");
    if (toggle) {
      // Rebuilt in one go. Setting textContent first removed the badge, so
      // looking it up afterwards found nothing and the count never showed.
      toggle.innerHTML = showingTrash
        ? "&larr; Back to renders"
        : `Trash <span id="vh-trash-count">${trashed.length || ""}</span>`;
    }
    const search = byId("vh-search");
    if (search) search.closest(".search-field").hidden = showingTrash;
  }

  function loadTrash() {
    return fetch("/studio/api/video/trash")
      .then((r) => r.json())
      .then((data) => {
        trashed = data.clips || [];
        if (showingTrash) renderTrash();
        syncTrashUi();
      })
      .catch(() => {});
  }

  function renderTrash() {
    const list = byId("vh-list");
    byId("vh-total").textContent = trashed.length
      ? `${trashed.length} clip${trashed.length === 1 ? "" : "s"} in the trash`
      : "";
    byId("vh-empty").classList.toggle("hidden", trashed.length > 0);
    byId("vh-empty").textContent = "Nothing in the trash.";

    list.innerHTML = trashed.map((c) => `
      <div class="vh-group">
        <div class="vh-headrow">
          <span class="vh-render vh-head is-trash">
            <span class="vh-thumbs">
              <video src="${esc(c.video_url)}#t=0.5" preload="metadata" muted></video>
            </span>
            <span class="vh-meta">
              <span class="vh-name">${esc(c.address)}</span>
              <span class="vh-sub">
                ${esc(MOVE_NAMES[c.move] || c.move || "clip")} · ${c.duration}s
                · ${esc(c.resolution || "")} · deleted ${esc(when(Date.parse(c.deleted_at) / 1000))}
              </span>
            </span>
          </span>
          <button type="button" class="vh-restore"
                  data-job="${c.job_id}" data-index="${c.index}">Restore</button>
        </div>
      </div>`).join("");

    list.querySelectorAll(".vh-restore").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.disabled = true;
        fetch("/studio/api/video/clip/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ job_id: Number(btn.dataset.job),
                                 index: Number(btn.dataset.index) }),
        }).then(() => Promise.all([loadTrash(), load()]))
          .catch(() => { btn.disabled = false; });
      });
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
    showingTrash = false;
    renderList();
    syncTrashUi();
    loadTrash();
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
        <div class="vh-foot">
          <button type="button" id="vh-trash-toggle" class="vh-trash-toggle">
            Trash <span id="vh-trash-count"></span>
          </button>
        </div>
      </div>`;
    document.body.appendChild(box);

    box.querySelectorAll("[data-close]").forEach((n) =>
      n.addEventListener("click", closeModal));
    byId("vh-trash-toggle").addEventListener("click", () => {
      showingTrash = !showingTrash;
      if (showingTrash) loadTrash(); else renderList();
      syncTrashUi();
    });
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
