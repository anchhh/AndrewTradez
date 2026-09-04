/* The aerial reel.

   Two or three photographs, each a short moving shot, joined by speed-blur
   whips: the wide view of the neighbourhood, optionally a closer one, and
   the front of the house -- which is exactly the frame the flyover opens
   on, so the two cut together with no seam.

   Nothing is generated. The one time the model was asked to fly from the
   wide shot to the closer one it invented a different suburb on the way,
   and the reference reel this copies does not fly that stretch either: it
   holds, rushes to a streak, cuts, and the next shot is just there. That is
   built from the photographs on the server, for nothing.

   Only two things are chosen here: what it opens on, and whether there is a
   closer view in between. Where it ends was decided at stage 4. */

const lead = window.__LEAD__;
const wide = window.__WIDE__ || [];
const front = window.__FRONT__ || "";
const slots = window.__SLOTS__ || {};
const slotOrder = window.__SLOT_ORDER__ || Object.keys(slots);
const shotLabels = window.__SHOT_LABELS__ || {};
const timing = window.__TIMING__ || { drift: 1.5, whip: 0.4, land: 0.35 };

const el = (id) => document.getElementById(id);
const note = (text) => { if (el("ae-note")) el("ae-note").textContent = text || ""; };

let opening = window.__OPENING__ || wide[0] || "";
/* Optional, and never the same picture as either end. */
let middle = window.__MIDDLE__ || "";

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* What a picture is. These are the listing's own photographs, so the
   board's labels usually have nothing to say about them -- but the slot
   lookup stays for the case where somebody's saved choice predates that. */
function nameOf(url) {
  const key = slotOrder.find((k) => (slots[k] || []).includes(url));
  if (key) return shotLabels[key] || "Capture";
  return "Listing photo";
}

const frames = () => (middle ? [opening, middle, front] : [opening, front]);

/* How long the reel runs: each shot drifts, and every cut costs a whip out
   and a landing in. The same arithmetic as the server's, so the number
   here is the number the file comes back with. */
function seconds() {
  const n = frames().length;
  return n * timing.drift + (n - 1) * (timing.whip + timing.land);
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
      // The two cannot be the same picture. Dropping it from the middle is
      // less surprising than refusing the click.
      if (middle === opening) middle = "";
      el("ae-open-img").src = opening;
      el("ae-open-name").textContent = nameOf(opening);
      paintAll();
      save();
    }));

  if (opening) el("ae-open-name").textContent = nameOf(opening);
}

/* The optional closer view in between. Clicking the chosen one again
   removes it, which is how a single-select-or-none behaves everywhere else
   here. */
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

function paintLength() {
  const n = frames().length;
  el("ae-cost").textContent =
    n + " shots, about " + seconds().toFixed(1) + " seconds. Free — built from "
    + "the photos, nothing is generated.";
}

function paintAll() {
  paintViews();
  paintMiddles();
  paintLength();
}

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

el("ae-go").addEventListener("click", () => {
  if (!opening) { note("Pick what it opens on."); return; }
  note("");
  review();
});

function review() {
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

  el("ae-review-specs").textContent =
    frames().length + " shots · about " + seconds().toFixed(1) + " seconds · 1080p · "
    + "built from the photos, no render";

  el("ae-review").hidden = false;
}

function closeReview() { el("ae-review").hidden = true; }

el("ae-review-cancel").addEventListener("click", closeReview);
el("ae-review").addEventListener("click", (e) => {
  if (e.target.id === "ae-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ae-review").hidden) closeReview();
});

el("ae-review-go").addEventListener("click", () => {
  closeReview();
  generate();
});

/* ---------- building it ---------- */

async function generate() {
  el("ae-go").disabled = true;
  note("Building the reel…");
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
