/* Stage 3: the editor for the Google Earth captures.

   Two edits, different in kind. Cropping is exact and instant: a rectangle
   in the image's own pixels, applied by the server with PIL. Enhancing is a
   model redrawing the capture from photographs of the house, which takes
   about ten seconds and can come back wrong -- so both are undoable, and
   Revert returns the capture as Earth gave it rather than the step before.

   Which photographs it matches against is asked, not assumed. Which side of
   the house a capture shows is obvious to a person looking at it and
   guesswork for anything else, and matching a back-garden capture against
   the front elevation is how a redraw puts the front door on the back wall.

   Crop coordinates are held in image pixels, never screen pixels, so a box
   survives the overlay being a different size on a different monitor. Same
   reason the flight path is stored that way. */

const lead = window.__LEAD__;
const canEnhance = window.__CAN_ENHANCE__;
const photos = window.__PHOTOS__ || [];
const rooms = window.__ROOMS__ || {};
const defaultRefs = window.__DEFAULT_REFS__ || [];

let captures = window.__CAPTURES__ || [];
let originals = window.__ORIGINALS__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { el("en-note").textContent = text || ""; };
const busy = {};   // {url: label} while a request for that capture is out

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function roomLabel(url) {
  const entry = rooms[url];
  const label = entry && typeof entry === "object" ? entry.label : entry;
  return label || "Unsorted";
}

/* ---------- the gallery ---------- */

function render() {
  el("en-grid").innerHTML = captures.map((url, i) => {
    const edited = !!originals[url];
    const working = busy[url];
    return `
      <figure class="en-item${edited ? " is-done" : ""}" data-url="${url}">
        <button type="button" class="en-shot" data-act="view"
                title="See it full size">
          <img src="${url}" alt="Capture ${i + 1}">
          ${edited ? `<span class="en-flag">Edited</span>` : ""}
          ${working ? `<span class="en-busy">${working}</span>` : ""}
        </button>
        <figcaption>
          <span class="en-room">View ${i + 1}</span>
          <span class="en-buttons">
            <button type="button" class="btn-secondary btn-tiny" data-act="view"
                    ${working ? "disabled" : ""}>Full size</button>
            <button type="button" class="btn-secondary btn-tiny" data-act="pick"
                    ${working || !canEnhance ? "disabled" : ""}>Enhance…</button>
            ${edited ? `<button type="button" class="btn-tiny" data-act="revert"
                    ${working ? "disabled" : ""}>Revert</button>` : ""}
          </span>
        </figcaption>
      </figure>`;
  }).join("");

  el("en-grid").querySelectorAll("button[data-act]").forEach((button) => {
    const url = button.closest(".en-item").dataset.url;
    const act = button.dataset.act;
    button.addEventListener("click", () => {
      if (act === "view") openView(url);
      else if (act === "pick") openPicker(url);
      else post(act, url);
    });
  });
}

/* One request shape for all three edits, because the answer is the same
   shape: the whole gallery back. Patching the list locally from a partial
   reply is how two views of the same thing start disagreeing. */
async function post(action, url, extra = {}) {
  busy[url] = action === "enhance" ? "Redrawing…" : "Working…";
  render();
  note(action === "enhance" ? "Redrawing — this takes a few seconds." : "");
  try {
    const res = await fetch(`/studio/api/leads/${lead}/captures/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: url, ...extra }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that edit didn't work");
    captures = body.images || [];
    originals = body.originals || {};
    delete busy[url];
    render();
    note(action === "enhance" ? "Redrawn. Revert if it came out wrong." : "");
  } catch (err) {
    delete busy[url];
    render();
    note(err.message);
  }
}

/* ---------- the viewer, which is also the cropper ---------- */

let viewUrl = null;
let box = null;          // [x0, y0, x1, y1] in image pixels
let natural = { w: 0, h: 0 };
let dragging = false;

const cropImg = () => el("en-crop-img");
const cropCanvas = () => el("en-crop-canvas");

function openView(url) {
  viewUrl = url;
  box = null;
  el("en-view-name").textContent = `View ${captures.indexOf(url) + 1}`;
  el("en-view-revert").hidden = !originals[url];
  el("en-view-enhance").disabled = !canEnhance;
  const img = cropImg();
  img.onload = () => {
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    sizeCanvas();
  };
  img.src = url;
  el("en-view").hidden = false;
}

function closeView() {
  el("en-view").hidden = true;
  viewUrl = null;
  box = null;
}

function sizeCanvas() {
  const rect = cropImg().getBoundingClientRect();
  const canvas = cropCanvas();
  canvas.width = Math.round(rect.width);
  canvas.height = Math.round(rect.height);
  drawBox();
}

function toImage(clientX, clientY) {
  const rect = cropImg().getBoundingClientRect();
  return [
    Math.max(0, Math.min(natural.w, ((clientX - rect.left) / rect.width) * natural.w)),
    Math.max(0, Math.min(natural.h, ((clientY - rect.top) / rect.height) * natural.h)),
  ];
}

function normalised() {
  const [ax, ay, bx, by] = box;
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

function drawBox() {
  const canvas = cropCanvas();
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  el("en-crop-apply").disabled = !box;

  if (!box) {
    el("en-crop-size").textContent = `${natural.w} × ${natural.h}`;
    return;
  }

  const rect = cropImg().getBoundingClientRect();
  const sx = rect.width / natural.w;
  const sy = rect.height / natural.h;
  const [x0, y0, x1, y1] = normalised();
  const x = x0 * sx;
  const y = y0 * sy;
  const w = (x1 - x0) * sx;
  const h = (y1 - y0) * sy;

  // Everything outside the box dimmed, which is what makes a crop read as
  // "this is what you keep" rather than "this is a rectangle".
  ctx.fillStyle = "rgba(10, 8, 6, 0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(x, y, w, h);
  ctx.strokeStyle = "#ef5a2b";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  el("en-crop-size").textContent =
    `${Math.round(x1 - x0)} × ${Math.round(y1 - y0)} of ${natural.w} × ${natural.h}`;
}

cropCanvas().addEventListener("mousedown", (e) => {
  const [x, y] = toImage(e.clientX, e.clientY);
  box = [x, y, x, y];
  dragging = true;
  drawBox();
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const [x, y] = toImage(e.clientX, e.clientY);
  box[2] = x;
  box[3] = y;
  drawBox();
});
window.addEventListener("mouseup", () => { dragging = false; });
window.addEventListener("resize", () => { if (viewUrl) sizeCanvas(); });

el("en-crop-reset").addEventListener("click", () => { box = null; drawBox(); });
el("en-crop-cancel").addEventListener("click", closeView);
el("en-view-revert").addEventListener("click", () => {
  const url = viewUrl;
  closeView();
  post("revert", url);
});
el("en-view-enhance").addEventListener("click", () => {
  const url = viewUrl;
  closeView();
  openPicker(url);
});
el("en-crop-apply").addEventListener("click", () => {
  if (!box) { note("Drag a box first."); return; }
  const [x0, y0, x1, y1] = normalised();
  if (x1 - x0 < 32 || y1 - y0 < 32) { note("That crop is too small."); return; }
  const url = viewUrl;
  closeView();
  post("crop", url, { box: [x0, y0, x1, y1] });
});

/* ---------- choosing what it matches against ---------- */

let pickUrl = null;
let chosen = new Set();

function openPicker(url) {
  pickUrl = url;
  chosen = new Set(defaultRefs);
  renderPicker();
  el("en-pick").hidden = false;
}

function renderPicker() {
  el("en-pick-grid").innerHTML = photos.map((url) => `
    <button type="button" class="en-pick-item${chosen.has(url) ? " is-on" : ""}"
            data-url="${url}">
      <img src="${url}" alt="">
      <span>${escapeHtml(roomLabel(url))}</span>
    </button>`).join("");

  el("en-pick-grid").querySelectorAll(".en-pick-item").forEach((button) => {
    button.addEventListener("click", () => {
      const url = button.dataset.url;
      if (chosen.has(url)) chosen.delete(url); else chosen.add(url);
      renderPicker();
    });
  });

  // Said out loud because more is not better here: past a handful the
  // capture stops being clearly the subject among the images sent.
  const n = chosen.size;
  el("en-pick-count").textContent =
    n ? `${n} selected${n > 6 ? " — that's a lot" : ""}` : "none selected";
  el("en-pick-go").disabled = !n;
}

el("en-pick-default").addEventListener("click", () => {
  chosen = new Set(defaultRefs);
  renderPicker();
});
el("en-pick-cancel").addEventListener("click", () => { el("en-pick").hidden = true; });
el("en-pick-go").addEventListener("click", () => {
  const url = pickUrl;
  const references = [...chosen];
  el("en-pick").hidden = true;
  post("enhance", url, { references });
});

// Escape closes whichever overlay is open, because an overlay that can only
// be dismissed by finding the right button is one people get stuck in.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!el("en-pick").hidden) el("en-pick").hidden = true;
  else if (viewUrl) closeView();
});

render();
