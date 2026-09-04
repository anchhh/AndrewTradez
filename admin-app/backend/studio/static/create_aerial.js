/* The aerial reel.

   Two or three shots, each a short drone push the model renders from one
   photograph, cut together with speed-blur whips: the wide view of the
   neighbourhood, optionally a closer one, and the front of the house. The
   whips are built on the server from the clips' own frames -- nothing
   between two photographs is ever generated, because the one time it was
   the model invented a different suburb on the way.

   What is chosen here: what it opens on, whether there is a closer view in
   between, and how long each shot holds. */

const lead = window.__LEAD__;
const wide = window.__WIDE__ || [];
const front = window.__FRONT__ || "";
const slots = window.__SLOTS__ || {};
const slotOrder = window.__SLOT_ORDER__ || Object.keys(slots);
const shotLabels = window.__SHOT_LABELS__ || {};
const rates = window.__RATES__ || {};
const timing = window.__TIMING__ || { rush: 0.35, land: 0.3, min_render: 3 };

const el = (id) => document.getElementById(id);
const note = (text) => { if (el("ae-note")) el("ae-note").textContent = text || ""; };

let opening = window.__OPENING__ || wide[0] || "";
/* Optional, and never the same picture as either end. */
let middle = window.__MIDDLE__ || "";
/* The standard wording, shared by every shot, and the edit to it if any. */
let standard = "";
let edit = null;
const promptNow = () => (edit === null ? standard : edit);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function nameOf(url) {
  const key = slotOrder.find((k) => (slots[k] || []).includes(url));
  if (key) return shotLabels[key] || "Capture";
  return "Listing photo";
}

const frames = () => (middle ? [opening, middle, front] : [opening, front]);
const each = () => Number(el("ae-each").value) || 3;

/* The model renders at least three seconds a shot; a shorter shot is
   rendered at three and trimmed, and is priced at three. */
const rendered = () => Math.max(each(), timing.min_render);

function seconds() {
  const n = frames().length;
  return n * each() + (n - 1) * (timing.rush + timing.land);
}

function cost() {
  const rate = rates["1080p"] || rates["*"];
  return rate ? rate * rendered() * frames().length : null;
}

/* ---------- what it opens on ---------- */

function paintViews() {
  const views = el("ae-views");
  if (!views) return;
  views.innerHTML = wide.map((url) => {
    const on = url === opening ? " is-on" : "";
    return '<button type="button" class="fp-view' + on + '" data-url="' + esc(url) +
      '" title="' + esc(nameOf(url)) + '"><img src="' + esc(url) + '" alt=""></button>';
  }).join("");

  views.querySelectorAll(".fp-view").forEach((button) =>
    button.addEventListener("click", () => {
      opening = button.dataset.url;
      if (middle === opening) middle = "";
      el("ae-open-img").src = opening;
      el("ae-open-name").textContent = nameOf(opening);
      paintAll();
      save();
    }));

  if (opening) el("ae-open-name").textContent = nameOf(opening);
}

/* The optional closer view in between. Clicking the chosen one again
   removes it. */
function paintMiddles() {
  const box = el("ae-mids");
  if (!box) return;

  box.innerHTML = wide.filter((url) => url !== opening).map((url) => {
    const on = url === middle ? " is-on" : "";
    return '<button type="button" class="fp-view' + on + '" data-url="' + esc(url) +
      '" title="' + esc(nameOf(url)) + '"><img src="' + esc(url) + '" alt=""></button>';
  }).join("");

  box.querySelectorAll(".fp-view").forEach((button) =>
    button.addEventListener("click", () => {
      middle = button.dataset.url === middle ? "" : button.dataset.url;
      paintAll();
      save();
    }));

  const wrap = el("ae-mid-wrap");
  const arrow = el("ae-mid-arrow");
  if (wrap) {
    wrap.hidden = !middle;
    if (middle) el("ae-mid-img").src = middle;
  }
  if (arrow) arrow.hidden = !middle;
}

function paintCost() {
  const n = frames().length;
  const dollars = cost();
  el("ae-cost").textContent =
    n + " shots of " + each() + " s, about " + seconds().toFixed(1) + " seconds"
    + (dollars != null ? " — about $" + dollars.toFixed(2) : "")
    + " (" + n + " clips of " + rendered() + " s rendered"
    + (each() < timing.min_render ? ", trimmed" : "") + ").";
}

function paintAll() {
  paintViews();
  paintMiddles();
  paintCost();
}

el("ae-each").addEventListener("change", paintCost);

/* Remembered, so leaving the page does not throw the choice away. */
async function save() {
  try {
    await fetch("/studio/api/leads/" + lead + "/aerial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opening: opening, middle: middle }),
    });
  } catch (err) {
    /* the choice still applies to this run; only the memory of it is lost */
  }
}

if (el("ae-mid-clear")) {
  el("ae-mid-clear").addEventListener("click", () => {
    middle = "";
    paintAll();
    save();
  });
}

/* ---------- the confirmation ---------- */

el("ae-go").addEventListener("click", async () => {
  if (!opening) { note("Pick what it opens on."); return; }
  note("Reading the prompt…");
  try {
    const res = await fetch("/studio/api/video/drone/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: lead, shot: "aerial" }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't read the prompt");
    standard = body.prompt || "";
    note("");
    review(body);
  } catch (err) {
    note(err.message);
  }
});

function review(body) {
  el("ae-review-prompt").value = promptNow();

  const labels = middle
    ? [["Opens on", nameOf(opening)], ["Whips into", nameOf(middle)],
       ["Ends on", "The front"]]
    : [["Opens on", nameOf(opening)], ["Ends on", "The front"]];
  el("ae-review-frames").innerHTML = frames().map((url, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + esc(url) + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + labels[i][0] +
    '<span class="gn-review-also">' + esc(labels[i][1]) + "</span>" +
    "</figcaption></figure>").join("");

  const dollars = cost();
  el("ae-review-specs").textContent =
    frames().length + " shots of " + each() + " s · about " + seconds().toFixed(1)
    + " seconds · 1080p · " + (body.model || "the video model")
    + (dollars != null ? " · about $" + dollars.toFixed(2) : "");

  el("ae-review").hidden = false;
}

function closeReview() { el("ae-review").hidden = true; }

el("ae-review-cancel").addEventListener("click", closeReview);
el("ae-review-reset").addEventListener("click", () => {
  edit = null;
  el("ae-review-prompt").value = promptNow();
});
el("ae-review").addEventListener("click", (e) => {
  if (e.target.id === "ae-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ae-review").hidden) closeReview();
});

el("ae-review-go").addEventListener("click", () => {
  const typed = (el("ae-review-prompt").value || "").trim();
  edit = typed && typed !== standard ? typed : null;
  closeReview();
  generate();
});

/* ---------- rendering ---------- */

async function generate() {
  el("ae-go").disabled = true;
  note("Starting the render…");
  try {
    const res = await fetch("/studio/api/video/drone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead,
        shot: "aerial",
        start: opening,
        middle: middle,
        end: front,
        each: each(),
        // Sent every time, edited or not: "what I saw" and "what ran" are
        // the same string or the confirmation was theatre.
        prompt: promptNow(),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "the reel couldn't be started");
    window.location.href = "/studio/create/video/rendering?job=" + body.job_id
      + "&style=drone";
  } catch (err) {
    el("ae-go").disabled = false;
    note(err.message);
  }
}

paintAll();
