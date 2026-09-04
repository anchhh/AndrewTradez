/* The aerial reel.

   A short push over a wide photograph, a whip, and then one long slow zoom
   from a closer view down onto the front of the house. Two shots, one cut.
   With no closer view chosen it is the zoom alone, from the wide shot
   straight down onto the front, and there is nothing to cut.

   The zoom is a real interpolation between two photographs. The whip is
   built on the server from the clips' own frames -- nothing between the two
   WIDE shots is ever generated, because the one time it was the model
   invented a different suburb on the way. */

const lead = window.__LEAD__;
const wide = window.__WIDE__ || [];
const front = window.__FRONT__ || "";
const slots = window.__SLOTS__ || {};
const slotOrder = window.__SLOT_ORDER__ || Object.keys(slots);
const shotLabels = window.__SHOT_LABELS__ || {};
const rates = window.__RATES__ || {};
const timing = window.__TIMING__ || { rush: 0.6, land: 0.5, min_render: 3 };

const el = (id) => document.getElementById(id);
const note = (text) => { if (el("ae-note")) el("ae-note").textContent = text || ""; };

let opening = window.__OPENING__ || wide[0] || "";
/* Optional, and never the same picture as either end. */
let middle = window.__MIDDLE__ || "";
/* One standard wording per shot, and one edit slot per shot: the push and
   the zoom are different instructions and an edit to one leaves the other
   alone. */
let standards = [];
let edits = [null, null];

const shotCount = () => (middle ? 2 : 1);
const promptNow = (i) => (edits[i] === null ? (standards[i] || "") : edits[i]);

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

const openSecs = () => Number(el("ae-open-secs").value) || 3;
const zoomSecs = () => Number(el("ae-zoom-secs").value) || 8;

/* The model renders at least three seconds; a shorter shot is rendered at
   three, trimmed on the cut, and priced at three. */
const rendered = (s) => Math.max(s, timing.min_render);

/* Each shot, plus a whip out and a landing in for the one cut. */
function seconds() {
  return middle
    ? openSecs() + zoomSecs() + timing.rush + timing.land
    : zoomSecs();
}

function cost() {
  const rate = rates["1080p"] || rates["*"];
  if (!rate) return null;
  return middle
    ? rate * (rendered(openSecs()) + zoomSecs())
    : rate * zoomSecs();
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

/* The optional closer view. It is where the long zoom STARTS, so choosing
   one turns a single zoom into a two-shot reel. Clicking the chosen one
   again removes it. */
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
  const dollars = cost();
  // The opening length only means anything when there is an opening shot.
  el("ae-open-row").hidden = !middle;
  el("ae-cost").textContent =
    (middle ? "Two shots" : "One shot") + ", about " + seconds().toFixed(1)
    + " seconds"
    + (dollars != null ? " — about $" + dollars.toFixed(2) : "")
    + (middle && openSecs() < timing.min_render
       ? " (the opening is rendered at " + timing.min_render + " s and trimmed)"
       : "") + ".";
}

function paintAll() {
  paintViews();
  paintMiddles();
  paintCost();
}

el("ae-open-secs").addEventListener("change", paintCost);
el("ae-zoom-secs").addEventListener("change", paintCost);

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
      body: JSON.stringify({ lead_id: lead, shot: "aerial", middle: middle }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't read the prompt");
    // Two instructions when there is an opening shot, one otherwise.
    // Fetched rather than rebuilt here: a preview assembled its own way is
    // a preview of something else.
    standards = (body.prompts && body.prompts.length === 2)
      ? body.prompts : [body.prompt || ""];
    note("");
    review(body);
  } catch (err) {
    note(err.message);
  }
});

/* One editable box per shot, built here rather than sitting in the markup:
   the reel is one shot or two, and a hidden second box that has to be kept
   in step with the choice is a bug waiting for a quiet afternoon. */
function paintPrompts() {
  const heads = middle
    ? ["Shot 1 — the opening push", "Shot 2 — the long zoom"]
    : ["The prompt — one long zoom"];
  const hints = middle
    ? ["A slow forward push over the wide photo, height held.",
       "From the closer view, far back, slowly down onto the front."]
    : ["From the wide photo, far back, slowly down onto the front."];
  el("ae-review-prompts").innerHTML = heads.map((head, i) =>
    '<h4 class="gn-review-h">' + esc(head) + "</h4>" +
    '<p class="hint">' + esc(hints[i]) + " Editable, for this run.</p>" +
    '<textarea id="ae-review-prompt' + i + '" class="gn-review-prompt" ' +
    'spellcheck="false" rows="10"></textarea>').join("");
  for (let i = 0; i < shotCount(); i += 1) {
    el("ae-review-prompt" + i).value = promptNow(i);
  }
}

function review(body) {
  paintPrompts();

  const shots = middle
    ? [[opening, "Shot 1", nameOf(opening)],
       [middle, "Shot 2 starts", nameOf(middle)],
       [front, "and ends", "The front"]]
    : [[opening, "Starts", nameOf(opening)], [front, "and ends", "The front"]];
  el("ae-review-frames").innerHTML = shots.map((shot, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + esc(shot[0]) + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + shot[1] +
    '<span class="gn-review-also">' + esc(shot[2]) + "</span>" +
    "</figcaption></figure>").join("");

  const dollars = cost();
  el("ae-review-specs").textContent =
    (middle ? openSecs() + " s push + " + zoomSecs() + " s zoom"
            : zoomSecs() + " s zoom")
    + " · about " + seconds().toFixed(1) + " seconds · 1080p · "
    + (body.model || "the video model")
    + (dollars != null ? " · about $" + dollars.toFixed(2) : "");

  el("ae-review").hidden = false;
}

function closeReview() { el("ae-review").hidden = true; }

el("ae-review-cancel").addEventListener("click", closeReview);
el("ae-review-reset").addEventListener("click", () => {
  edits = [null, null];
  paintPrompts();
});
el("ae-review").addEventListener("click", (e) => {
  if (e.target.id === "ae-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ae-review").hidden) closeReview();
});

el("ae-review-go").addEventListener("click", () => {
  // Remembered per shot, so a second confirmation opens on what just ran.
  for (let i = 0; i < shotCount(); i += 1) {
    const typed = (el("ae-review-prompt" + i).value || "").trim();
    edits[i] = typed && typed !== (standards[i] || "") ? typed : null;
  }
  closeReview();
  generate();
});

/* ---------- rendering ---------- */

async function generate() {
  el("ae-go").disabled = true;
  note("Starting the render…");
  try {
    const prompts = [];
    for (let i = 0; i < shotCount(); i += 1) prompts.push(promptNow(i));
    const res = await fetch("/studio/api/video/drone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead,
        shot: "aerial",
        start: opening,
        middle: middle,
        end: front,
        opening: openSecs(),
        zoom: zoomSecs(),
        // Sent every time, edited or not: "what I saw" and "what ran" are
        // the same string or the confirmation was theatre.
        prompts: prompts,
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
