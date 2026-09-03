/* The crop stage: framing the Earth captures.

   Cropping is exact and instant -- a rectangle in the image's own pixels,
   applied by the server with PIL. No model is involved, and none should be:
   framing a shot is not a judgement anything needs to make for you.

   It matters more than it looks. Earth screenshots arrive with menus down
   one side and half the street in frame, and the generate stage works from
   what is left -- a tight crop is most of the difference between a picture
   of a house and a picture of a neighbourhood.

   Crop coordinates are held in image pixels, never screen pixels, so a box
   survives the overlay being a different size on a different monitor. Same
   reason the flight path is stored that way. */

const lead = window.__LEAD__;
const slots = window.__SLOTS__ || {};
const shotLabels = window.__SHOT_LABELS__ || {};

/* What a capture is, from the plan it was labelled against at stage 2.
   Falls back to its position, because an unlabelled view still has to be
   referable to. */
function captureName(url) {
  return shotLabels[slots[url]] || `View ${captures.indexOf(url) + 1}`;
}

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
          <span class="en-room">${escapeHtml(captureName(url))}</span>
          <span class="en-buttons">
            <button type="button" class="btn-secondary btn-tiny" data-act="view"
                    ${working ? "disabled" : ""}>Full size</button>
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
      else post(act, url);
    });
  });
}

/* One request shape for all three edits, because the answer is the same
   shape: the whole gallery back. Patching the list locally from a partial
   reply is how two views of the same thing start disagreeing. */
async function post(action, url, extra = {}) {
  busy[url] = "Working…";
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
    note("");
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
  el("en-view-name").textContent = captureName(url);
  el("en-view-revert").hidden = !originals[url];
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
el("en-crop-apply").addEventListener("click", () => {
  if (!box) { note("Drag a box first."); return; }
  const [x0, y0, x1, y1] = normalised();
  if (x1 - x0 < 32 || y1 - y0 < 32) { note("That crop is too small."); return; }
  const url = viewUrl;
  closeView();
  post("crop", url, { box: [x0, y0, x1, y1] });
});

// Escape closes whichever overlay is open, because an overlay that can only
// be dismissed by finding the right button is one people get stuck in.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Innermost first: the lightbox opens on top of the cropper.
  if (!el("ge-lightbox").hidden) closeZoom();
  else if (viewUrl) closeView();
});

render();
