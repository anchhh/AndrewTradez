/* Stage 3: the editor for the Google Earth captures.

   Two edits, and they are different in kind. Cropping is exact and instant:
   a rectangle in the image's own pixels, applied by the server with PIL.
   Enhancing is a model redrawing the capture from the listing's exterior
   photographs, which takes about ten seconds and can come back looking
   wrong -- so both are undoable, and Revert always returns the capture as
   Earth gave it rather than the step before.

   Crop coordinates are held in image pixels, never screen pixels, so the box
   survives the overlay being a different size on a different monitor. Same
   reason the flight path is stored that way. */

const lead = window.__LEAD__;
const canEnhance = window.__CAN_ENHANCE__;
let captures = window.__CAPTURES__ || [];
let originals = window.__ORIGINALS__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { el("en-note").textContent = text || ""; };
const busy = {};   // {url: true} while a request for that capture is out

function render() {
  el("en-grid").innerHTML = captures.map((url, i) => {
    const edited = !!originals[url];
    const working = busy[url];
    return `
      <figure class="en-item${edited ? " is-done" : ""}" data-url="${url}">
        <div class="en-shot">
          <img src="${url}" alt="Capture ${i + 1}">
          ${edited ? `<span class="en-flag">Edited</span>` : ""}
          ${working ? `<span class="en-busy">${working}</span>` : ""}
        </div>
        <figcaption>
          <span class="en-room">View ${i + 1}</span>
          <span class="en-buttons">
            <button type="button" class="btn-secondary btn-tiny" data-act="crop"
                    ${working ? "disabled" : ""}>Crop</button>
            <button type="button" class="btn-secondary btn-tiny" data-act="enhance"
                    ${working || !canEnhance ? "disabled" : ""}>Enhance</button>
            ${edited ? `<button type="button" class="btn-tiny" data-act="revert"
                    ${working ? "disabled" : ""}>Revert</button>` : ""}
          </span>
        </figcaption>
      </figure>`;
  }).join("");

  el("en-grid").querySelectorAll("button").forEach((button) => {
    const url = button.closest(".en-item").dataset.url;
    const act = button.dataset.act;
    button.addEventListener("click", () => {
      if (act === "crop") openCrop(url);
      else post(act, url);
    });
  });
}

/* One request shape for all three, because the answer is the same shape:
   the whole gallery back. Patching the list locally from a partial reply is
   how two views of the same thing start disagreeing. */
async function post(action, url, extra = {}) {
  busy[url] = action === "enhance" ? "Redrawing…" : "Working…";
  render();
  note("");
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
    if (action === "enhance") note("Redrawn. Revert if it came out wrong.");
  } catch (err) {
    delete busy[url];
    render();
    note(err.message);
  }
}

/* ---------- the cropper ---------- */

let cropUrl = null;
let box = null;          // [x0, y0, x1, y1] in image pixels
let natural = { w: 0, h: 0 };
let dragging = false;

const overlay = () => el("en-crop");
const cropImg = () => el("en-crop-img");
const cropCanvas = () => el("en-crop-canvas");

function openCrop(url) {
  cropUrl = url;
  box = null;
  const img = cropImg();
  img.onload = () => {
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    sizeCanvas();
  };
  img.src = url;
  overlay().hidden = false;
}

function closeCrop() {
  overlay().hidden = true;
  cropUrl = null;
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

function drawBox() {
  const canvas = cropCanvas();
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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

  // Everything outside the box dimmed, which is what makes a crop readable
  // as "this is what you keep" rather than "this is a rectangle".
  ctx.fillStyle = "rgba(10, 8, 6, 0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.clearRect(x, y, w, h);

  ctx.strokeStyle = "#ef5a2b";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  el("en-crop-size").textContent =
    `${Math.round(x1 - x0)} × ${Math.round(y1 - y0)} of ${natural.w} × ${natural.h}`;
}

function normalised() {
  const [ax, ay, bx, by] = box;
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
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
window.addEventListener("resize", () => { if (cropUrl) sizeCanvas(); });

el("en-crop-reset").addEventListener("click", () => { box = null; drawBox(); });
el("en-crop-cancel").addEventListener("click", closeCrop);
el("en-crop-apply").addEventListener("click", () => {
  if (!box) { note("Drag a box first."); return; }
  const [x0, y0, x1, y1] = normalised();
  if (x1 - x0 < 32 || y1 - y0 < 32) { note("That crop is too small."); return; }
  const url = cropUrl;
  closeCrop();
  post("crop", url, { box: [x0, y0, x1, y1] });
});

// Escape closes it, because an overlay that can only be dismissed by finding
// the right button is an overlay people get stuck in.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cropUrl) closeCrop();
});

render();
