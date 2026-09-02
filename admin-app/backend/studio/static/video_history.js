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

  function renderList() {
    const list = byId("vh-list");
    const total = byId("vh-total");
    const empty = byId("vh-empty");
    if (!list) return;

    const query = (byId("vh-search").value || "").trim();
    const shown = renders.filter((r) => matches(r, query));

    total.textContent = query
      ? `${shown.length} of ${renders.length} shown`
      : `${renders.length} render${renders.length === 1 ? "" : "s"}`;
    empty.classList.toggle("hidden", shown.length > 0);

    list.innerHTML = shown.map((r) => {
      const seconds = r.clips.reduce((n, c) => n + (c.duration || 0), 0);
      return `
        <button type="button" class="vh-render vh-head" data-id="${r.id}">
          <span class="vh-thumbs">
            ${r.clips.slice(0, 3).map((c) => `
              <video src="${esc(c.video_url)}#t=0.5" preload="metadata" muted></video>`).join("")}
          </span>
          <span class="vh-meta">
            <span class="vh-name">${esc(r.address)}</span>
            <span class="vh-sub">
              ${r.clips.length} clip${r.clips.length === 1 ? "" : "s"} · ${seconds}s
              · ${esc(r.clips[0].resolution || "")} · ${esc(when(r.created_at))}
              ${r.estimated_cost != null ? " · $" + r.estimated_cost.toFixed(2) : ""}
            </span>
          </span>
        </button>`;
    }).join("");

    // Straight to the results view on the render page, the way Scenery opens a
    // saved run on its own last step. Carrying the project when there is one
    // keeps "Render again" able to start a fresh run.
    list.querySelectorAll(".vh-head").forEach((head) => {
      head.addEventListener("click", () => {
        const project = (window.__PROJECT__ || {}).id;
        const params = new URLSearchParams({ job: head.dataset.id });
        if (project) params.set("project", project);
        window.location.href = "/studio/create/render?" + params.toString();
      });
    });
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
        <p class="hint">Every render you've made. Opening one takes you to its clips.</p>
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

  fetch("/studio/api/video/jobs")
    .then((r) => r.json())
    .then((data) => {
      renders = data.renders || [];
      const button = byId("vh-open");
      if (!button) return;
      // No button until there is something behind it.
      button.hidden = renders.length === 0;
      const badge = byId("vh-count");
      if (badge) badge.textContent = renders.length ? String(renders.length) : "";
      build();
      button.addEventListener("click", openModal);
    })
    .catch(() => {});
})();
