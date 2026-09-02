/*
 * Render: the step Create Video never had.
 *
 * Photos and a style were being gathered and saved as a draft, and the chain
 * stopped there -- the style page said so out loud. This is the arrow that was
 * missing: chosen photos in, one clip per photo out.
 *
 * The shape deliberately matches Scenery's generating stage, because it is the
 * same job and the user already knows that flow. What differs is money: there
 * is no free provider for video, so the cost is stated on the button and the
 * run only ever starts from an explicit click.
 */
const project = window.__PROJECT__ || {};
const el = (id) => document.getElementById(id);

// A listing video is a handful of clips, not a clip of every photo. Forty
// photos at five seconds is $26.80, and defaulting to that would put a
// four-figure mistake one click away on a busy pipeline. Scenery learned the
// same lesson: the default selection is what gets SPENT, so it errs low and
// adding more is a click.
const DEFAULT_CLIPS = 6;

const state = {
  style: null,       // the style card, which is a preset for the moves
  available: [],     // every still in the project
  photos: [],        // the ones ticked, one clip each
  moves: {},         // {url: moveKey} -- the camera move for that clip
  seconds: {},       // {url: length}      -- and how long it runs
  quality: {},       // {url: resolution}  -- and at what size
  moveList: [],      // [{key, name, desc}] from the server
  durationList: [],
  resolutionList: [],
  defaultMove: "push_in",
  defaultDuration: 5,
  defaultResolution: "1080p",
  ratePerSecond: null,
  configured: false,
  job: null,
  startedAt: null,
  polling: false,
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function isVideo(url) {
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url || "");
}

function fmtDuration(seconds) {
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? m + "m " + s + "s" : m + "m";
}

function show(id, on) {
  const node = el(id);
  if (node) node.classList.toggle("hidden", !on);
}

/* The progress bar, same three steps as Scenery. Rendering is not a step of
   its own -- it is what happens between choosing and looking, and numbering it
   would imply there is something to do there. */
function markStep(n) {
  document.querySelectorAll("#steps .step").forEach((li) => {
    const at = Number(li.dataset.step);
    li.classList.toggle("is-current", at === n);
    li.classList.toggle("is-done", at < n);
  });
}

/* ---------- what we are rendering ----------

   Grouped and labelled exactly as Scenery groups its rooms, and for a reason
   beyond consistency: the room labels carry a walkthrough order, and clips are
   stitched in sequence. Sorting by it means the default tour runs the way
   somebody would actually walk the house -- approach, living, kitchen,
   bedrooms -- rather than the order the photos happened to be scraped in. */

function roomOf(url) {
  return (project.photo_rooms || {})[url] || {};
}

function groupedPhotos() {
  const buckets = new Map();
  state.available.forEach((url) => {
    const info = roomOf(url);
    const key = info.room || "unsorted";
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: info.label || "Unsorted",
        // Unsorted last: it is the pile nothing could be said about.
        order: info.order != null ? info.order : 999,
        photos: [],
      });
    }
    buckets.get(key).photos.push(url);
  });
  return [...buckets.values()].sort((a, b) => a.order - b.order);
}

/* The order clips are rendered and stitched in: walkthrough order, not the
   order photos arrived. */
function walkthroughOrder() {
  return groupedPhotos().flatMap((group) => group.photos);
}

function selectPhoto(url, on) {
  const ordered = walkthroughOrder();
  const chosen = new Set(state.photos);
  if (on) chosen.add(url);
  else chosen.delete(url);
  state.photos = ordered.filter((u) => chosen.has(u));
  if (on && !state.moves[url]) state.moves[url] = state.defaultMove;
}

function photoTile(url) {
  const on = state.photos.includes(url);
  const at = state.photos.indexOf(url);
  const div = document.createElement("div");
  div.className = "thumb is-selectable" + (on ? "" : " is-excluded");
  div.dataset.url = url;
  div.innerHTML = `
    <img src="${escapeHtml(url)}" alt="" loading="lazy">
    <label class="thumb-use" title="Make a clip from this photo">
      <input type="checkbox" ${on ? "checked" : ""}>
    </label>
    ${on ? `<span class="rn-thumb-n">${at + 1}</span>` : ""}`;

  div.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") e.preventDefault();
    selectPhoto(url, !state.photos.includes(url));
    renderPhotos();
    renderClipMoves();
    renderCost();
  });
  return div;
}

function renderPhotos() {
  const box = el("rn-photos");
  if (!state.available.length) {
    box.innerHTML = `<p class="empty-note">
      This project has no photos. Go back and add some.</p>`;
    return;
  }

  box.innerHTML = `
    <div class="rn-photos-head">
      <span class="photo-count">
        <strong>${state.photos.length}</strong> of ${state.available.length} photos
        — one clip each, in walkthrough order
      </span>
      <button type="button" class="btn-secondary btn-tiny" id="rn-clear">Clear</button>
    </div>
    <p class="hint">Click a photo to include or leave it out.</p>
    <div id="rn-grid" class="photo-grid is-grouped"></div>`;

  const grid = el("rn-grid");
  groupedPhotos().forEach((group) => {
    const on = group.photos.filter((u) => state.photos.includes(u)).length;
    const section = document.createElement("section");
    section.className = "photo-room" + (group.key === "unsorted" ? " is-secondary" : "");
    section.dataset.room = group.key;
    section.innerHTML = `
      <div class="photo-room-head">
        <span class="photo-room-label">${escapeHtml(group.label)}</span>
        <span class="photo-room-count">${on}/${group.photos.length}</span>
        <button type="button" class="btn-tiny photo-room-toggle">
          ${on === group.photos.length ? "None" : "All"}
        </button>
      </div>`;

    const sub = document.createElement("div");
    sub.className = "photo-room-grid";
    group.photos.forEach((url) => sub.appendChild(photoTile(url)));
    section.appendChild(sub);

    section.querySelector(".photo-room-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      const turnOn = on !== group.photos.length;
      group.photos.forEach((url) => selectPhoto(url, turnOn));
      renderPhotos();
      renderClipMoves();
      renderCost();
    });

    grid.appendChild(section);
  });

  const clear = el("rn-clear");
  if (clear) {
    clear.addEventListener("click", () => {
      state.photos = [];
      renderPhotos();
      renderClipMoves();
      renderCost();
    });
  }
}

/* ---------- style presets ----------

   These three cards used to be a page of their own that saved one field and
   moved on. A style is a preset for the camera moves, so it belongs beside
   them: picking one sets every clip, and any clip can then be changed. The
   choice is still saved on the project, because it is what a returning visit
   opens on.  */

function renderStyleCards() {
  document.querySelectorAll(".style-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.style === state.style);
  });
}

function applyStyle(style, { save = true } = {}) {
  state.style = style;
  const preset = (state.styleDefaults || {})[style];
  if (preset) {
    state.defaultMove = preset;
    state.photos.forEach((url) => { state.moves[url] = preset; });
  }
  renderStyleCards();
  renderClipMoves();

  if (!save || !project.id) return;
  fetch(`/studio/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ style }),
  }).catch(() => {});
}

document.querySelectorAll(".style-card").forEach((card) => {
  card.addEventListener("click", () => applyStyle(card.dataset.style));
});

/* ---------- camera moves ----------

   The video answer to Scenery's per-room styles, and the same reasoning: one
   setting for a whole listing is the wrong grain. A pull-out reveals the house
   on the exterior and a push-in sells the kitchen; being made to choose one
   for both produces a worse video than either. */

function moveName(key) {
  const found = state.moveList.find((m) => m.key === key);
  return found ? found.name : key;
}

/* Three dropdowns rather than a row of nine buttons plus two fields. The
   buttons were fine when a move was the only per-clip setting; with length and
   resolution beside them the card turned into a wall of controls, and a
   dropdown says the current value in the space one button used. */
function fillSelect(select, options, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>` +
    options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
}

function moveOptions() {
  return state.moveList.map((m) => ({ value: m.key, label: m.name }));
}
function durationOptions() {
  return state.durationList.map((d) => ({ value: String(d), label: d + " seconds" }));
}
function resolutionOptions() {
  return state.resolutionList.map((r) => ({ value: r, label: r }));
}

function renderSetAll() {
  const move = el("rn-all-move");
  const dur = el("rn-all-duration");
  const res = el("rn-all-resolution");
  if (!move) return;

  fillSelect(move, moveOptions(), "Camera move…");
  fillSelect(dur, durationOptions(), "Length…");
  fillSelect(res, resolutionOptions(), "Resolution…");

  // Applying to every clip, then resetting to the placeholder: this row is an
  // action, not a value, and leaving it showing "8 seconds" would imply every
  // clip still says that after one of them is changed.
  const applyAll = (select, apply) => {
    select.addEventListener("change", () => {
      if (!select.value) return;
      state.photos.forEach((url) => apply(url, select.value));
      select.value = "";
      renderClipMoves();
      renderCost();
    });
  };
  applyAll(move, (url, v) => { state.moves[url] = v; });
  applyAll(dur, (url, v) => { state.seconds[url] = Number(v); });
  applyAll(res, (url, v) => { state.quality[url] = v; });
}

function renderClipMoves() {
  const box = el("rn-clip-moves");
  if (!box) return;

  if (!state.photos.length) {
    box.innerHTML = "";
    return;
  }

  const pick = (options, current) => options.map((o) =>
    `<option value="${escapeHtml(o.value)}"${String(o.value) === String(current) ? " selected" : ""}>` +
    `${escapeHtml(o.label)}</option>`).join("");

  box.innerHTML = state.photos.map((url, i) => {
    const label = roomOf(url).label;
    return `
      <div class="rn-clip-row" data-url="${escapeHtml(url)}">
        <img class="rn-clip-shot" src="${escapeHtml(url)}" alt="" loading="lazy">
        <div class="rn-clip-body">
          <span class="rn-clip-name">Clip ${i + 1}${label ? " · " + escapeHtml(label) : ""}</span>
        </div>
        <div class="rn-clip-controls">
          <select class="rn-select" data-field="move" aria-label="Camera move">
            ${pick(moveOptions(), state.moves[url] || state.defaultMove)}
          </select>
          <select class="rn-select rn-select-sm" data-field="duration" aria-label="Clip length">
            ${pick(durationOptions(), state.seconds[url] || state.defaultDuration)}
          </select>
          <select class="rn-select rn-select-sm" data-field="resolution" aria-label="Resolution">
            ${pick(resolutionOptions(), state.quality[url] || state.defaultResolution)}
          </select>
        </div>
      </div>`;
  }).join("");

  box.querySelectorAll(".rn-clip-row").forEach((row) => {
    const url = row.dataset.url;
    row.querySelectorAll("select").forEach((select) => {
      select.addEventListener("change", () => {
        const value = select.value;
        if (select.dataset.field === "move") state.moves[url] = value;
        if (select.dataset.field === "duration") state.seconds[url] = Number(value);
        if (select.dataset.field === "resolution") state.quality[url] = value;
        // No re-render: the select already shows the new value, and rebuilding
        // would close the dropdown the user is still looking at.
        renderCost();
      });
    });
  });
}

/* ---------- cost, stated before it is spent ---------- */

function renderCost() {
  const n = state.photos.length;
  const totalSeconds = state.photos.reduce(
    (sum, url) => sum + (state.seconds[url] || state.defaultDuration), 0);
  const go = el("rn-go");
  const note = el("rn-note");

  if (!state.configured) {
    go.disabled = true;
    el("rn-cost").textContent = "";
    return;
  }

  go.disabled = n === 0;
  go.textContent = n ? `Render ${n} clip${n === 1 ? "" : "s"}` : "Render";

  if (!n) {
    el("rn-cost").textContent = "";
    note.textContent = "Nothing selected to render.";
    return;
  }

  note.textContent = "";
  if (state.ratePerSecond == null) {
    el("rn-cost").textContent = "";
    return;
  }
  const total = totalSeconds * state.ratePerSecond;
  // Video is metered, unlike Scenery. The number goes next to the button, not
  // further down the page, because this click is the one that spends. Clips
  // can differ in length, so it is total seconds rather than count x length.
  el("rn-cost").innerHTML =
    `${n} clip${n === 1 ? "" : "s"}, ${totalSeconds}s of footage ` +
    `at $${state.ratePerSecond.toFixed(3)}/second — about <strong>$${total.toFixed(2)}</strong>.`;
}

/* ---------- the run ---------- */

function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  el("rn-bar-fill").style.width = pct + "%";
  el("rn-bar").setAttribute("aria-valuenow", String(pct));
  el("rn-count").textContent = `${done} of ${total} clip${total === 1 ? "" : "s"}`;

  const eta = el("rn-eta");
  if (done >= total) {
    eta.textContent = "Finishing up…";
    return;
  }
  const elapsed = (Date.now() - state.startedAt) / 1000;
  if (done > 0) {
    // Clips run one at a time and take minutes, so measured throughput is the
    // only honest estimate -- there is no useful constant to fall back on.
    eta.textContent = "about " + fmtDuration((total - done) * (elapsed / done)) + " left";
  } else {
    eta.textContent = fmtDuration(elapsed) + " elapsed";
  }
}

function renderClipList(clips, total) {
  el("rn-list").innerHTML = Array.from({ length: total }, (_, i) => {
    const clip = clips[i];
    const status = !clip ? "waiting"
      : clip.video_url ? "done"
      : clip.status === "failed" ? "failed"
      : "running";
    const label = { waiting: "Queued", running: "Rendering…", done: "Done", failed: "Failed" }[status];
    const url = state.photos[i];
    const move = url
      ? `${moveName(state.moves[url] || state.defaultMove)} · ${state.seconds[url] || state.defaultDuration}s`
      : "";
    return `<li class="scn-gen-row ${status === "done" ? "is-done" : ""}">
        <span class="scn-gen-room">Clip ${i + 1}${move ? " · " + escapeHtml(move) : ""}</span>
        <span class="scn-gen-nums">${label}</span>
      </li>`;
  }).join("");
}

async function startRender() {
  if (state.polling) return;
  const totalSeconds = state.photos.reduce(
    (sum, url) => sum + (state.seconds[url] || state.defaultDuration), 0);

  state.polling = true;
  state.startedAt = Date.now();
  show("rn-setup", false);
  show("rn-results", false);
  show("rn-running", true);
  markStep(3);
  el("rn-run-title").textContent = "Rendering your clips";
  el("rn-run-sub").textContent =
    `${state.photos.length} clip${state.photos.length === 1 ? "" : "s"}, ` +
    `${totalSeconds}s of footage. Clips take a couple of minutes apiece.`;
  setProgress(0, state.photos.length);
  renderClipList([], state.photos.length);

  let data;
  try {
    const res = await fetch("/studio/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Clips rather than bare photos: each carries its own camera move.
        clips: state.photos.map((url) => ({
          photo: url,
          move: state.moves[url] || state.defaultMove,
          duration: state.seconds[url] || state.defaultDuration,
          resolution: state.quality[url] || state.defaultResolution,
        })),
        lead_id: project.lead_id || null,
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    state.polling = false;
    show("rn-running", false);
    show("rn-setup", true);
    banner(err.message);
    return;
  }

  state.job = data.job;
  pollJob(data.job.id);
}

async function pollJob(jobId) {
  let job;
  try {
    const res = await fetch(`/studio/api/video/jobs/${jobId}`);
    const body = await res.json();
    if (!res.ok || !body.job) throw new Error(body.error || "lost track of the render");
    job = body.job;
  } catch (err) {
    state.polling = false;
    banner(err.message);
    show("rn-running", false);
    show("rn-setup", true);
    return;
  }

  state.job = job;
  setProgress(job.clips_done, job.clips_total);
  renderClipList(job.clips || [], job.clips_total);

  if (job.status === "queued" || job.status === "running") {
    // Slower than Scenery's poll on purpose: clips take minutes, not seconds.
    setTimeout(() => pollJob(jobId), 4000);
    return;
  }

  state.polling = false;
  finish(job);
}

function finish(job) {
  el("rn-bar-fill").style.width = "100%";
  show("rn-running", false);
  show("rn-results", true);
  markStep(3);

  const clips = (job.clips || []).filter((c) => c.video_url);
  const failed = (job.clips_total || 0) - clips.length;
  const took = state.startedAt ? fmtDuration((Date.now() - state.startedAt) / 1000) : null;

  if (!clips.length) {
    el("rn-done").innerHTML =
      `<div class="scn-run scn-run-error"><strong>Nothing rendered.</strong> ` +
      `${escapeHtml(job.error || (job.clips || [])[0]?.error || "The render failed.")}</div>`;
    el("rn-clips").innerHTML = "";
    return;
  }

  el("rn-done").innerHTML =
    `<div class="scn-run scn-run-done"><strong>Done.</strong> ` +
    `${clips.length} clip${clips.length === 1 ? "" : "s"} rendered` +
    `${took ? " in " + took : ""}` +
    `${job.estimated_cost != null ? ` · about $${job.estimated_cost.toFixed(2)}` : ""}.` +
    `${failed ? ` <span class="scn-run-warn">${failed} failed.</span>` : ""}</div>`;

  el("rn-clips").innerHTML = clips.map((clip, i) => `
    <figure class="rn-clip">
      <video src="${escapeHtml(clip.video_url)}" controls preload="metadata"></video>
      <figcaption>Clip ${i + 1}${clip.move ? " · " + escapeHtml(moveName(clip.move)) : ""}</figcaption>
    </figure>`).join("");

  // Stitching is the next arrow in the chain and does not exist yet; saying so
  // beats implying these are a finished video.
  el("rn-results-note").textContent = clips.length > 1
    ? "These are separate clips — stitching them into one video isn't built yet."
    : "";
}

function banner(message) {
  const box = el("rn-connection");
  box.hidden = false;
  box.innerHTML = `<strong>Couldn't render.</strong> ${escapeHtml(message)}`;
}

/* ---------- init ---------- */

async function init() {
  // Only the photos the project actually selected -- and never a video file,
  // which is already moving and has nothing to animate.
  // A video file is already moving and has nothing to animate, so it is not
  // a candidate.
  const chosen = project.selected_photos || project.photos || [];
  state.available = chosen.filter((u) => u && !isVideo(u));

  // One per room where the photos have been sorted, so the default tour hits
  // living/kitchen/bedroom rather than six angles of the same lounge; a plain
  // cap otherwise. Either way it starts small.
  const seen = new Set();
  state.photos = walkthroughOrder().filter((url) => {
    const room = roomOf(url).room;
    if (!room || seen.has(room)) return false;
    seen.add(room);
    return true;
  }).slice(0, DEFAULT_CLIPS);
  // No labels at all (a pasted link or a manual upload): fall back to a cap,
  // still in the order the photos arrived.
  if (!state.photos.length) state.photos = state.available.slice(0, DEFAULT_CLIPS);

  el("rn-sub").textContent = project.address || project.name || el("rn-sub").textContent;

  renderPhotos();

  try {
    const status = await (await fetch("/studio/api/video/status")).json();
    state.configured = !!status.configured;
    state.ratePerSecond = status.rate_per_second ?? null;
    if (!state.configured) {
      banner(status.config_error ||
        "The video generator isn't connected. Add an Atlas Cloud key to studio/atlascloud.json.");
    }
    state.durationList = status.durations || [4, 5, 6, 8, 10, 12, 15, 20, 30];
    state.resolutionList = status.resolutions || ["480p", "720p", "1080p"];
    if (status.default_duration) state.defaultDuration = status.default_duration;
    if (status.default_resolution) state.defaultResolution = status.default_resolution;

    state.moveList = status.moves || [];
    state.styleDefaults = status.style_default_move || {};

    // Re-applying the saved style seeds every clip, without saving it back --
    // opening the page is not a change.
    if (project.style) applyStyle(project.style, { save: false });
    state.photos.forEach((url) => {
      if (!state.moves[url]) state.moves[url] = state.defaultMove;
    });
    renderSetAll();
    renderClipMoves();
    renderStyleCards();
  } catch (err) {
    banner("Couldn't reach the server to check the generator.");
  }

  renderCost();
}

el("rn-go").addEventListener("click", startRender);
el("rn-back").addEventListener("click", () => {
  window.location.href = `/studio/create?project=${project.id}`;
});
el("rn-again").addEventListener("click", () => {
  show("rn-results", false);
  show("rn-setup", true);
  markStep(2);
});
// Backwards only, like Scenery's, and never mid-render.
document.querySelectorAll("#steps .step").forEach((li) => {
  li.addEventListener("click", () => {
    if (state.polling) return;
    if (Number(li.dataset.step) === 1) {
      window.location.href = `/studio/create?project=${project.id}`;
    }
  });
});

el("rn-cancel").addEventListener("click", async () => {
  if (!state.job) return;
  await fetch(`/studio/api/video/jobs/${state.job.id}/cancel`, { method: "POST" })
    .catch(() => {});
  state.polling = false;
  show("rn-running", false);
  show("rn-setup", true);
  markStep(2);
});

init();
