/* Stage 4 of a drone run.

   Deliberately not the shots step. That page turns each photograph of a
   listing into its own clip with its own camera move, which is the right
   shape for a walkthrough and the wrong shape for this: a drone shot is one
   flight across one property. There is no per-room grain to choose, and a
   room-by-room picker had nothing to say about it.

   What there is to choose: which captured view the flight starts on, which
   it ends on, how the camera moves between them, and for how long. Both ends
   are pictures rather than descriptions because that is what stops the model
   inventing the far side of the house -- the same anchoring the exterior
   clips have always used. */

const lead = window.__LEAD__;
const frames = window.__FRAMES__ || [];
const labels = window.__LABELS__ || {};
const shotLabels = window.__SHOT_LABELS__ || {};
const moves = window.__MOVES__ || [];
const rates = window.__RATES__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { el("dr-note").textContent = text || ""; };

const state = {
  start: frames[0] || null,
  end: null,
  move: (moves[0] || {}).key || null,
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function frameName(url, i) {
  return shotLabels[labels[url]] || `View ${i + 1}`;
}

/* ---------- the two ends ---------- */

function renderFrames() {
  el("dr-start").innerHTML = frames.map((url, i) => tile(url, i, url === state.start)).join("");
  // The ending offers "none", because a shot without one is a legitimate
  // choice: some moves have nowhere to land and inventing a destination is
  // worse than not going there.
  el("dr-end").innerHTML =
    `<button type="button" class="dr-frame dr-frame-none${
      state.end ? "" : " is-on"}" data-url="">No ending</button>` +
    frames.filter((url) => url !== state.start)
      .map((url) => tile(url, frames.indexOf(url), url === state.end)).join("");

  el("dr-start").querySelectorAll(".dr-frame").forEach((button) =>
    button.addEventListener("click", () => {
      state.start = button.dataset.url;
      // A clip cannot end where it began; that is a still, not a flight.
      if (state.end === state.start) state.end = null;
      renderFrames();
    }));
  el("dr-end").querySelectorAll(".dr-frame").forEach((button) =>
    button.addEventListener("click", () => {
      state.end = button.dataset.url || null;
      renderFrames();
    }));
}

function tile(url, i, on) {
  return `
    <button type="button" class="dr-frame${on ? " is-on" : ""}" data-url="${url}">
      <img src="${url}" alt="">
      <span>${escapeHtml(frameName(url, i))}</span>
    </button>`;
}

/* ---------- the move ---------- */

function renderMoves() {
  el("dr-moves").innerHTML = moves.map((move) => `
    <button type="button" class="dr-move${move.key === state.move ? " is-on" : ""}"
            data-move="${move.key}">
      <span class="dr-move-name">${escapeHtml(move.name)}</span>
      <span class="dr-move-note">${escapeHtml(move.note)}</span>
    </button>`).join("");

  el("dr-moves").querySelectorAll(".dr-move").forEach((button) =>
    button.addEventListener("click", () => {
      state.move = button.dataset.move;
      renderMoves();
    }));
}

/* ---------- what it costs ---------- */

function renderCost() {
  const seconds = Number(el("dr-duration").value) || 0;
  const resolution = el("dr-resolution").value;
  const rate = rates[resolution] != null ? rates[resolution] : rates["*"];
  el("dr-cost").textContent = rate
    ? `About $${(rate * seconds).toFixed(2)} for ${seconds} seconds.`
    : `${seconds} seconds.`;
}

el("dr-duration").addEventListener("change", renderCost);
el("dr-resolution").addEventListener("change", renderCost);

/* ---------- generating ---------- */

el("dr-go").addEventListener("click", async () => {
  if (!state.start) { note("Pick the frame the flight starts on."); return; }
  if (!state.move) { note("Pick how the camera moves."); return; }

  const button = el("dr-go");
  button.disabled = true;
  note("");
  el("dr-running").hidden = false;
  el("dr-run-title").textContent = "Generating the shot";
  el("dr-run-sub").textContent =
    "One clip. This takes a couple of minutes — you can leave the page.";

  try {
    const res = await fetch("/studio/api/video/drone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead,
        start: state.start,
        end: state.end,
        move: state.move,
        duration: Number(el("dr-duration").value),
        resolution: el("dr-resolution").value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "the shot couldn't be started");
    poll(body.job_id);
  } catch (err) {
    button.disabled = false;
    el("dr-running").hidden = true;
    note(err.message);
  }
});

/* Polled rather than pushed, the same way the shots step does it: generation
   runs on a background thread and the page has to survive being left. */
async function poll(jobId) {
  try {
    const res = await fetch(`/studio/api/video/jobs/${jobId}`);
    const job = await res.json();
    const clip = (job.clips || [])[0] || {};

    if (job.status === "completed" && clip.url) {
      el("dr-run-title").textContent = "Done";
      el("dr-run-sub").textContent = "";
      el("dr-result").innerHTML =
        `<video src="${clip.url}" controls playsinline class="dr-video"></video>`;
      el("dr-go").disabled = false;
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      el("dr-run-title").textContent = "That didn't work";
      el("dr-run-sub").textContent = job.error || clip.error || "";
      el("dr-go").disabled = false;
      return;
    }
    setTimeout(() => poll(jobId), 4000);
  } catch (err) {
    setTimeout(() => poll(jobId), 6000);
  }
}

renderFrames();
renderMoves();
renderCost();
