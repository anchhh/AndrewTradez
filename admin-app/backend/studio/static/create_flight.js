/* The flight: one line, from the front shot to the back one.

   The stage before this makes two pictures. The stage after turns them into
   a video. What sits between is the only thing neither of them knows -- how
   the camera gets from one to the other -- and it is a shape, so it is drawn
   rather than described.

   The two ends are not choices. A is the front, B is the back, because that
   is what a flyover of a house is; what is being chosen is the route. */

const lead = window.__LEAD__;
const surfaces = window.__SURFACES__ || [];
const drawn = window.__DRAWN__ || {};

const el = (id) => document.getElementById(id);
const wrap = el("fp-wrap");

/* Everything is kept in the drawing image's own pixels, because that is what
   is stored and what describe() measures against. The canvas is whatever
   size the layout gives it, so the two are converted at the edges only. */
let surface = drawn.image && surfaces.includes(drawn.image)
  ? drawn.image : surfaces[0];
let size = { w: drawn.width || 0, h: drawn.height || 0 };
let points = (drawn.points || []).map((p) => [p[0], p[1]]);
let saving = null;

const note = (text) => { if (el("fp-note")) el("fp-note").textContent = text || ""; };

/* ---------- the surface ---------- */

function load(url) {
  const img = el("fp-image");
  img.onload = () => {
    // The stored line belongs to whichever picture it was drawn on. Changing
    // the picture without changing the line would put it somewhere arbitrary,
    // so a new surface starts from the default run.
    if (!size.w || !size.h || surface !== url || points.length < 2) {
      size = { w: img.naturalWidth, h: img.naturalHeight };
      if (points.length < 2) points = defaults();
    }
    surface = url;
    redraw();
  };
  img.src = url;
}

function paintViews() {
  const views = el("fp-views");
  views.innerHTML = surfaces.map((url) => {
    const on = url === surface ? " is-on" : "";
    return '<button type="button" class="fp-view' + on + '" data-url="' + url +
           '"><img src="' + url + '" alt=""></button>';
  }).join("");
  views.querySelectorAll(".fp-view").forEach((button) =>
    button.addEventListener("click", () => {
      if (button.dataset.url === surface) return;
      points = [];
      size = { w: 0, h: 0 };
      load(button.dataset.url);
      paintViews();
      save();
      note("New view — the path starts again on it.");
    }));
}

/* A run up the plot: the front is the street side, so A sits low in the frame
   and B sits high. A guess, but a better one than an empty canvas, and it is
   two drags from being right. */
function defaults() {
  return [[size.w * 0.5, size.h * 0.86], [size.w * 0.5, size.h * 0.14]];
}

/* ---------- drawing ---------- */

function scale() {
  const img = el("fp-image");
  return { x: img.clientWidth / (size.w || 1), y: img.clientHeight / (size.h || 1) };
}

function toCanvas(point) {
  const s = scale();
  return [point[0] * s.x, point[1] * s.y];
}

function toImage(x, y) {
  const s = scale();
  return [Math.max(0, Math.min(size.w, x / s.x)),
          Math.max(0, Math.min(size.h, y / s.y))];
}

function redraw() {
  const img = el("fp-image");
  const canvas = el("fp-canvas");
  if (!img.clientWidth) return;
  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (points.length < 2) return;

  const line = points.map(toCanvas);
  // Twice: a dark casing under a light line, so the path reads over both a
  // pale driveway and a dark roof without picking a colour that only works
  // on one of them.
  [["rgba(12,10,8,0.55)", 7], ["#ff6b35", 3.5]].forEach((pair) => {
    ctx.beginPath();
    ctx.moveTo(line[0][0], line[0][1]);
    line.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
    ctx.strokeStyle = pair[0];
    ctx.lineWidth = pair[1];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  });

  arrow(ctx, line[line.length - 2], line[line.length - 1]);
  place("fp-pin-a", line[0]);
  place("fp-pin-b", line[line.length - 1]);
}

/* Which way it is going, at the end where it arrives. A line without one is
   the same picture flown backwards. */
function arrow(ctx, from, to) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - 15 * Math.cos(angle - 0.4), to[1] - 15 * Math.sin(angle - 0.4));
  ctx.lineTo(to[0] - 15 * Math.cos(angle + 0.4), to[1] - 15 * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = "#ff6b35";
  ctx.strokeStyle = "rgba(12,10,8,0.55)";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
}

function place(id, at) {
  const pin = el(id);
  pin.style.left = at[0] + "px";
  pin.style.top = at[1] + "px";
}

/* ---------- dragging ---------- */

function drag() {
  let mode = null;

  const at = (e) => {
    const box = el("fp-image").getBoundingClientRect();
    return toImage(e.clientX - box.left, e.clientY - box.top);
  };

  const begin = (e, which) => {
    e.preventDefault();
    mode = which;
    if (which === "draw") points = [at(e)];
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* mouse fallback */ }
  };

  wrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".fp-pin")) return;  // the pins have their own
    begin(e, "draw");
    redraw();
  });
  el("fp-pin-a").addEventListener("pointerdown", (e) => begin(e, "a"));
  el("fp-pin-b").addEventListener("pointerdown", (e) => begin(e, "b"));

  wrap.addEventListener("pointermove", (e) => {
    if (!mode) return;
    const p = at(e);
    if (mode === "draw") {
      // Thinned as it is drawn: a pointer emits far more samples than a
      // flight path has corners, and 400 of them is the server's ceiling.
      const last = points[points.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > size.w * 0.02) {
        points.push(p);
      }
    } else if (mode === "a") {
      points[0] = p;
    } else {
      points[points.length - 1] = p;
    }
    redraw();
  });

  const end = () => {
    if (!mode) return;
    if (mode === "draw" && points.length < 2) points = defaults();
    mode = null;
    redraw();
    save();
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
}

/* ---------- saving ---------- */

/* Debounced, because a drag ends every time a finger lifts and a plan is
   usually two or three of those in a row. */
function save() {
  clearTimeout(saving);
  saving = setTimeout(async () => {
    if (points.length < 2) return;
    try {
      const res = await fetch("/studio/api/leads/" + lead + "/flight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: surface, width: size.w, height: size.h,
                               points: points }),
      });
      // A session that has expired answers with the login PAGE, and asking
      // that for JSON produces a parser error that says nothing useful to
      // the person who drew the line.
      let body = null;
      try {
        body = await res.json();
      } catch (bad) {
        throw new Error(res.status === 200
          ? "the server sent something unreadable"
          : "you have been signed out — open the page again to keep this path");
      }
      if (!res.ok) throw new Error(body.error || "that path didn't save");
      el("fp-described").textContent = body.described || "Nothing drawn yet.";
      note("Saved.");
    } catch (err) {
      note(err.message);
    }
  }, 400);
}

/* ---------- go ---------- */

if (wrap) {
  paintViews();
  load(surface);

  el("fp-clear").addEventListener("click", () => {
    points = defaults();
    redraw();
    save();
    note("Back to a straight run front to back.");
  });
  el("fp-straight").addEventListener("click", () => {
    points = points.length >= 2
      ? [points[0], points[points.length - 1]]
      : defaults();
    redraw();
    save();
  });

  window.addEventListener("resize", redraw);
  drag();
}
