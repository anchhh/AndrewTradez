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
/* Only the middle of a stored path survives. The ends used to be draggable,
   so an older line can have them anywhere; they are fixed now and the route
   between them is the part that was ever really chosen. */
let restored = points.length > 2 ? points.slice(1, -1) : [];
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
    }
    surface = url;
    points = whole(restored);
    restored = middleOf(points);
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

/* Where the two ends are, and they do not move.

   A is the front shot and B is the back one, so on an overhead of a house
   they are the street side and the garden side: low in the frame and high in
   it. Fixing them is the point -- the question this page asks is not where
   the flight starts and stops, which the previous stage already answered by
   making those two pictures, but what route joins them. Leaving the ends
   draggable made that look like two questions. */
const END_A = [0.5, 0.86];
const END_B = [0.5, 0.14];

const endA = () => [size.w * END_A[0], size.h * END_A[1]];
const endB = () => [size.w * END_B[0], size.h * END_B[1]];

/* The whole line: fixed start, whatever was drawn, fixed end. Everything
   stored and everything drawn goes through here, so the ends cannot drift
   out of step with the pins that mark them. */
function whole(middle) {
  return [endA()].concat(middle || []).concat([endB()]);
}

/* What was drawn between them, recovered from a stored path. */
function middleOf(all) {
  return (all || []).length > 2 ? all.slice(1, -1) : [];
}

function defaults() {
  return whole([]);
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
  // From the constants, not from the line: the pins ARE the fixed ends, and
  // reading them off the path would let a stray point move them.
  place("fp-pin-a", toCanvas(endA()));
  place("fp-pin-b", toCanvas(endB()));
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
  let drawing = false;
  let middle = [];

  const at = (e) => {
    const box = el("fp-image").getBoundingClientRect();
    return toImage(e.clientX - box.left, e.clientY - box.top);
  };

  wrap.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drawing = true;
    middle = [at(e)];
    points = whole(middle);
    try { wrap.setPointerCapture(e.pointerId); } catch (err) { /* older mouse */ }
    redraw();
  });

  wrap.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = at(e);
    // Thinned as it is drawn: a pointer emits far more samples than a flight
    // path has corners, and 400 of them is the server's ceiling.
    const last = middle[middle.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > size.w * 0.02) {
      middle.push(p);
      points = whole(middle);
      redraw();
    }
  });

  const end = () => {
    if (!drawing) return;
    drawing = false;
    // A tap rather than a drag says "straight there", which is a reasonable
    // thing to mean and a silly thing to store as a one-point detour.
    if (middle.length < 2) points = defaults();
    redraw();
    save();
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
}

/* ---------- saving ---------- */

/* Debounced, because a drag ends every time a finger lifts and a plan is
   usually two or three of those in a row. Leaving the page cannot wait for a
   debounce, so the write itself is separate and can be called directly. */
function save() {
  clearTimeout(saving);
  saving = setTimeout(persist, 400);
}

async function persist() {
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
        // A signed-out session is answered with the login PAGE, and Flask
        // sends it as a 200 after the redirect -- so the status says nothing
        // and the fact that HTML came back where JSON was asked for says
        // everything.
        throw new Error("you have been signed out — open the page again to "
                        + "keep this path");
      }
      if (!res.ok) throw new Error(body.error || "that path didn't save");
      el("fp-described").textContent = body.described || "Nothing drawn yet.";
      note("Saved.");
    } catch (err) {
      note(err.message);
    }
}

/* ---------- on the way out ---------- */

/* The line becomes a picture when you leave, not on every save. A drag ends
   several times in the making of one route and each of those would write a
   file; leaving happens once.

   Worth being clear about what this file is for: it is a record, not an
   input. The video model takes a first frame, a last frame and words -- it
   has no slot for a diagram -- so what the model learns about the route is
   still the sentence. This is so a person can see what was planned without
   opening the planner. */
async function flatten() {
  try {
    await fetch("/studio/api/leads/" + lead + "/flight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "render" }),
    });
  } catch (err) {
    /* Moving on matters more than the picture. */
  }
}

if (el("fp-next")) {
  el("fp-next").addEventListener("click", async (e) => {
    if (points.length < 2) return;
    e.preventDefault();
    const href = el("fp-next").getAttribute("href");
    note("Saving the route…");
    clearTimeout(saving);
    await persist();
    await flatten();
    window.location.href = href;
  });
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
    points = defaults();
    redraw();
    save();
    note("Straight from A to B.");
  });

  window.addEventListener("resize", redraw);
  drag();
}
