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
  available: [],     // every still in the project
  photos: [],        // the ones ticked, one clip each
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

/* ---------- what we are rendering ---------- */

function renderPhotos() {
  const box = el("rn-photos");
  if (!state.available.length) {
    box.innerHTML = `<p class="empty-note">
      This project has no photos. Go back and add some.</p>`;
    return;
  }

  const chosen = new Set(state.photos);
  box.innerHTML = `
    <div class="rn-photos-head">
      <span class="photo-count">
        <strong>${state.photos.length}</strong> of ${state.available.length} photos
        — one clip each, in this order
      </span>
      <button type="button" class="btn-secondary btn-tiny" id="rn-clear">Clear</button>
    </div>
    <p class="hint">Click a photo to include or leave it out.</p>
    <div class="rn-strip">
      ${state.available.map((url) => {
        const at = state.photos.indexOf(url);
        return `
        <div class="rn-thumb ${at >= 0 ? "" : "is-excluded"}" data-url="${escapeHtml(url)}">
          <img src="${escapeHtml(url)}" alt="" loading="lazy">
          ${at >= 0 ? `<span class="rn-thumb-n">${at + 1}</span>` : ""}
        </div>`;
      }).join("")}
    </div>`;

  box.querySelectorAll(".rn-thumb").forEach((tile) => {
    tile.addEventListener("click", () => {
      const url = tile.dataset.url;
      const at = state.photos.indexOf(url);
      if (at >= 0) state.photos.splice(at, 1);
      // Keep the project's own order rather than click order -- the clips are
      // stitched in sequence and a jumbled tour is worse than a short one.
      else state.photos = state.available.filter(
        (u) => u === url || state.photos.includes(u));
      renderPhotos();
      renderCost();
    });
  });

  const clear = el("rn-clear");
  if (clear) {
    clear.addEventListener("click", () => {
      state.photos = [];
      renderPhotos();
      renderCost();
    });
  }
}

/* ---------- cost, stated before it is spent ---------- */

function renderCost() {
  const seconds = Number(el("rn-duration").value) || 5;
  const n = state.photos.length;
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
  const total = n * seconds * state.ratePerSecond;
  // Video is metered, unlike Scenery. The number goes next to the button, not
  // further down the page, because this click is the one that spends.
  el("rn-cost").innerHTML =
    `${n} clip${n === 1 ? "" : "s"} × ${seconds}s at $${state.ratePerSecond.toFixed(3)}/second ` +
    `— about <strong>$${total.toFixed(2)}</strong>.`;
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
    return `<li class="scn-gen-row ${status === "done" ? "is-done" : ""}">
        <span class="scn-gen-room">Clip ${i + 1}</span>
        <span class="scn-gen-nums">${label}</span>
      </li>`;
  }).join("");
}

async function startRender() {
  if (state.polling) return;
  const seconds = Number(el("rn-duration").value) || 5;

  state.polling = true;
  state.startedAt = Date.now();
  show("rn-setup", false);
  show("rn-results", false);
  show("rn-running", true);
  el("rn-run-title").textContent = "Rendering your clips";
  el("rn-run-sub").textContent =
    `${state.photos.length} clip${state.photos.length === 1 ? "" : "s"} at ` +
    `${seconds}s each. Clips take a couple of minutes apiece.`;
  setProgress(0, state.photos.length);
  renderClipList([], state.photos.length);

  let data;
  try {
    const res = await fetch("/studio/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photos: state.photos,
        lead_id: project.lead_id || null,
        style: el("rn-style").value,
        duration: seconds,
        resolution: el("rn-resolution").value,
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
  setProgress(job.done, job.total);
  renderClipList(job.clips || [], job.total);

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

  const clips = (job.clips || []).filter((c) => c.video_url);
  const failed = (job.total || 0) - clips.length;
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
      <figcaption>Clip ${i + 1}</figcaption>
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
  const rooms = project.photo_rooms || null;
  if (rooms) {
    const seen = new Set();
    state.photos = state.available.filter((url) => {
      const room = (rooms[url] || {}).room;
      if (!room || seen.has(room)) return false;
      seen.add(room);
      return true;
    }).slice(0, DEFAULT_CLIPS);
  }
  if (!state.photos.length) state.photos = state.available.slice(0, DEFAULT_CLIPS);

  if (project.style) el("rn-style").value = project.style;
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
    if (status.min_duration) el("rn-duration").min = status.min_duration;
    if (status.max_duration) el("rn-duration").max = status.max_duration;
  } catch (err) {
    banner("Couldn't reach the server to check the generator.");
  }

  renderCost();
}

el("rn-duration").addEventListener("input", renderCost);
el("rn-resolution").addEventListener("change", renderCost);
el("rn-go").addEventListener("click", startRender);
el("rn-back").addEventListener("click", () => {
  window.location.href = `/studio/create/style?project=${project.id}`;
});
el("rn-again").addEventListener("click", () => {
  show("rn-results", false);
  show("rn-setup", true);
});
el("rn-cancel").addEventListener("click", async () => {
  if (!state.job) return;
  await fetch(`/studio/api/video/jobs/${state.job.id}/cancel`, { method: "POST" })
    .catch(() => {});
  state.polling = false;
  show("rn-running", false);
  show("rn-setup", true);
});

init();
