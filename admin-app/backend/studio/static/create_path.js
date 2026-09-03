/* Drawing the drone's path on an overhead of the property.

   The manual version of this is: open Google Earth, screenshot it, draw a
   red line. Earth refuses to be framed (X-Frame-Options) and a cross-origin
   frame cannot be screenshotted anyway, so the app fetches its own overhead
   instead -- no capture step, consistent framing, and the same image can be
   recovered later. "Use my own overhead" keeps the Earth route open for when
   the 3D oblique view is what is wanted.

   The line is stored in IMAGE coordinates, not screen coordinates, so it
   survives a resize, a different monitor and a reload. */

const lead = window.__LEAD__;
const img = document.getElementById("dp-image-el");
const canvas = document.getElementById("dp-canvas");
const ctx = canvas.getContext("2d");

let points = [];      // [[x, y], ...] in the image's own pixels
let natural = { w: 0, h: 0 };
let references = [];

const el = (id) => document.getElementById(id);
const note = (text) => { el("dp-note").textContent = text || ""; };

/* ---------- the canvas ---------- */

function fitStage() {
  /* Keep the whole plot on screen. The overhead comes back square at 1024px,
     which put the bottom of the property below the fold -- half the flight
     could only be drawn by scrolling. Measured rather than a fixed viewport
     reserve, because what sits above the stage is not a constant. */
  const wrap = el("dp-wrap");
  const top = wrap.getBoundingClientRect().top + window.scrollY;
  const room = Math.max(320, window.innerHeight - top - 72);
  img.style.maxHeight = room + "px";
}

function sizeCanvas() {
  fitStage();
  // Match the displayed size, then draw in image coordinates scaled to it.
  const rect = img.getBoundingClientRect();
  canvas.width = Math.round(rect.width);
  canvas.height = Math.round(rect.height);
  draw();
}

function toImage(clientX, clientY) {
  const rect = img.getBoundingClientRect();
  return [
    ((clientX - rect.left) / rect.width) * natural.w,
    ((clientY - rect.top) / rect.height) * natural.h,
  ];
}

function toScreen(point) {
  const rect = img.getBoundingClientRect();
  return [
    (point[0] / natural.w) * rect.width,
    (point[1] / natural.h) * rect.height,
  ];
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (points.length === 0) return;

  const screen = points.map(toScreen);

  // The line itself, in the red the manual version uses, with a dark casing
  // so it stays readable over both a bright roof and a dark drive.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 7;
  strokePath(screen);
  ctx.strokeStyle = "#ef2b2b";
  ctx.lineWidth = 3.5;
  strokePath(screen);

  // Start and end, because which end is which is the whole meaning of the
  // line -- an unlabelled path is two opposite flights.
  marker(screen[0], "#12a150", "A");
  if (screen.length > 1) marker(screen[screen.length - 1], "#ef2b2b", "B");
}

function strokePath(screen) {
  ctx.beginPath();
  screen.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

function marker([x, y], colour, letter) {
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, x, y);
}

canvas.addEventListener("click", (e) => {
  points.push(toImage(e.clientX, e.clientY));
  draw();
  describe();
});

el("dp-clear").addEventListener("click", () => { points = []; draw(); describe(); });
el("dp-undo").addEventListener("click", () => { points.pop(); draw(); describe(); });
window.addEventListener("resize", sizeCanvas);

/* ---------- what the line means ---------- */

/* Described by the server, not here, so the sentence shown is the same
   sentence the render will use. Two implementations would drift, and the one
   on screen is the one being trusted. */
let describing = null;
function describe() {
  clearTimeout(describing);
  describing = setTimeout(async () => {
    if (points.length < 2) {
      el("dp-described").textContent = "Draw a path to see it.";
      return;
    }
    try {
      const res = await fetch(`/studio/api/leads/${lead}/drone-path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "couldn't read that path");
      el("dp-described").textContent = body.described || "—";
      note("Saved.");
    } catch (err) {
      note(err.message);
    }
  }, 400);
}

function payload() {
  return {
    points,
    width: natural.w,
    height: natural.h,
    image: img.getAttribute("src"),
    references,
  };
}

el("dp-save").addEventListener("click", () => {
  if (points.length < 2) { note("A path needs at least two points."); return; }
  describe();
});

/* ---------- the overhead ---------- */

function useImage(src) {
  img.onload = () => {
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    sizeCanvas();
  };
  img.src = src;
}

async function loadOverhead() {
  note("Fetching an overhead…");
  try {
    const res = await fetch(`/studio/api/leads/${lead}/overhead`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "no overhead available");
    useImage(body.url);
    if (body.earth_url) el("dp-earth").href = body.earth_url;
    note("");
  } catch (err) {
    note(err.message + " — you can upload your own overhead instead.");
  }
}

/* An Earth screenshot, or any other overhead. Uploaded through the same
   endpoint the rest of the app uses, so it lands beside the listing photos
   rather than in a second place with its own rules. */
el("dp-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  note("Uploading…");
  const url = await upload(file);
  if (url) { useImage(url); note(""); }
});

el("dp-ref").addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    const url = await upload(file);
    if (url) references.push(url);
  }
  renderRefs();
  if (points.length >= 2) describe();
});

async function upload(file) {
  // The field is "photos" and the reply is {photos: [...]} -- the same
  // endpoint the listing uploader uses, so an overhead lands beside the
  // listing photos instead of in a second place with its own rules.
  const form = new FormData();
  form.append("photos", file);
  try {
    const res = await fetch("/studio/api/upload", { method: "POST", body: form });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "upload failed");
    const url = (body.photos || [])[0];
    if (!url) {
      // Uploads are de-duplicated by image hash, so re-adding a picture that
      // is already here returns nothing rather than failing.
      throw new Error("that image is already on this listing");
    }
    return url;
  } catch (err) {
    note(err.message);
    return null;
  }
}

function renderRefs() {
  el("dp-refs").innerHTML = references.map((url, i) => `
    <span class="dp-ref">
      <img src="${url}" alt="">
      <button type="button" data-i="${i}" aria-label="Remove">&times;</button>
    </span>`).join("");
  el("dp-refs").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      references.splice(Number(b.dataset.i), 1);
      renderRefs();
    }));
}

/* ---------- start ---------- */

(async function start() {
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`);
    const body = await res.json();
    if (body.earth_url) el("dp-earth").href = body.earth_url;
    const saved = body.path || {};
    if (saved.points && saved.points.length) {
      points = saved.points;
      references = saved.references || [];
      renderRefs();
      el("dp-described").textContent = body.described || "—";
      if (saved.image) { useImage(saved.image); return; }
    }
  } catch (err) { /* a missing saved path just means drawing a new one */ }
  loadOverhead();
})();
