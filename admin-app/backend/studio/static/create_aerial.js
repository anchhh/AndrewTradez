/* The establishing shot.

   A descent from a wide view of the neighbourhood onto the front of the
   house, ending on exactly the frame the flyover opens with. Another handsome
   wide shot is easy; one that lands on a frame you already have is what makes
   the two into a sequence.

   Only one thing is chosen here -- what it opens on. Where it lands was
   decided at stage 4 by generating the front, and saying so is cheaper than
   offering a choice that has one right answer. */

const lead = window.__LEAD__;
const wide = window.__WIDE__ || [];
const front = window.__FRONT__ || "";
const slots = window.__SLOTS__ || {};
const slotOrder = window.__SLOT_ORDER__ || Object.keys(slots);
const shotLabels = window.__SHOT_LABELS__ || {};
const rates = window.__RATES__ || {};
const moveName = window.__MOVE_NAME__ || "Aerial approach";

const el = (id) => document.getElementById(id);
const note = (text) => { if (el("ae-note")) el("ae-note").textContent = text || ""; };

let opening = window.__OPENING__ || wide[0] || "";
/* Optional, and never the same picture as either end. */
let middle = window.__MIDDLE__ || "";
/* One standard wording per clip, and one edit slot per clip. With a middle
   frame there are two clips and two different instructions -- the first
   accelerates into the middle, the second brakes from it onto the front --
   so the confirmation shows both and an edit to one leaves the other alone. */
let standards = [];
let edits = [null, null];

const promptNow = (i) => (edits[i] === null ? (standards[i] || "") : edits[i]);
const legCount = () => (middle ? 2 : 1);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* What a picture is. These are the listing's own photographs now rather
   than Earth captures, so the board's labels usually have nothing to say
   about them -- but the slot lookup stays for the case where somebody's
   saved choice predates that. */
function nameOf(url) {
  const key = slotOrder.find((k) => (slots[k] || []).includes(url));
  if (key) return shotLabels[key] || "Capture";
  return "Listing photo";
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

/* The optional frame in between. Clicking the chosen one again removes it,
   which is how a single-select-or-none behaves everywhere else here. */
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

function paintAll() {
  paintViews();
  paintMiddles();
  renderCost();
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

/* ---------- what it costs ---------- */

function renderCost() {
  const seconds = Number(el("ae-duration").value);
  // A middle frame is a second leg, and the length is per clip -- so say the
  // total rather than letting the price double without explanation.
  const legs = middle ? 2 : 1;
  const rate = rates[el("ae-resolution").value] || rates["*"];
  const total = seconds * legs;
  el("ae-cost").textContent = (rate
    ? "About $" + (rate * total).toFixed(2) + " for " + total + " seconds"
    : total + " seconds")
    + (legs === 2
       ? " — two clips of " + seconds + "s, meeting on the middle frame."
       : ".");
}

/* ---------- the confirmation ---------- */

el("ae-go").addEventListener("click", async () => {
  if (!opening) { note("Pick what it opens on."); return; }
  note("Reading the prompt…");
  try {
    const res = await fetch("/studio/api/video/drone/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead, shot: "aerial", middle: middle,
        duration: Number(el("ae-duration").value),
        resolution: el("ae-resolution").value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't read the prompt");
    // Two instructions when there is a middle frame, one otherwise. Fetched
    // rather than rebuilt here: a preview assembled its own way is a preview
    // of something else.
    standards = (body.prompts && body.prompts.length === 2)
      ? body.prompts : [body.prompt || ""];
    note("");
    review(body);
  } catch (err) {
    note(err.message);
  }
});

function review(body) {
  const two = legCount() === 2 && standards.length === 2;
  el("ae-review-prompt").value = promptNow(0);
  el("ae-review-leg2").hidden = !two;
  el("ae-review-h1").textContent = two ? "Leg 1 — opening to the middle" : "The prompt";
  el("ae-review-hint1").textContent = two
    ? "Starts steady and accelerates into the middle frame. Editable, for this run."
    : "Editable, for this run.";
  if (two) el("ae-review-prompt2").value = promptNow(1);

  const ends = middle
    ? [[opening, "Opens on", nameOf(opening)],
       [middle, "Through", nameOf(middle)],
       [front, "Lands on", "The front"]]
    : [[opening, "Opens on", nameOf(opening)],
       [front, "Lands on", "The front"]];
  el("ae-review-frames").innerHTML = ends.map((end, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + esc(end[0]) + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + end[1] +
    '<span class="gn-review-also">' + esc(end[2]) + "</span>" +
    "</figcaption></figure>").join("");

  const seconds = Number(el("ae-duration").value);
  el("ae-review-specs").textContent =
    moveName + " · " +
    (middle ? "two clips of " + seconds + "s" : seconds + " seconds") +
    " · " + el("ae-resolution").value +
    " · " + (body.model || "the video model");

  el("ae-review").hidden = false;
}

function closeReview() { el("ae-review").hidden = true; }

el("ae-review-cancel").addEventListener("click", closeReview);
el("ae-review-reset").addEventListener("click", () => {
  edits = [null, null];
  el("ae-review-prompt").value = promptNow(0);
  if (legCount() === 2) el("ae-review-prompt2").value = promptNow(1);
});
el("ae-review").addEventListener("click", (e) => {
  if (e.target.id === "ae-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ae-review").hidden) closeReview();
});

el("ae-review-go").addEventListener("click", () => {
  // Remembered per leg, so a second confirmation opens on what just ran.
  const boxes = [el("ae-review-prompt"), el("ae-review-prompt2")];
  for (let i = 0; i < legCount(); i += 1) {
    const typed = (boxes[i].value || "").trim();
    edits[i] = typed && typed !== (standards[i] || "") ? typed : null;
  }
  closeReview();
  generate();
});

/* ---------- generating ---------- */

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
        duration: Number(el("ae-duration").value),
        resolution: el("ae-resolution").value,
        // Sent every time, edited or not: "what I saw" and "what ran" are
        // the same string or the confirmation was theatre. One per clip.
        prompts: middle ? [promptNow(0), promptNow(1)] : [promptNow(0)],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "the shot couldn't be started");
    window.location.href = "/studio/create/video/rendering?job=" + body.job_id
      + "&style=drone";
  } catch (err) {
    el("ae-go").disabled = false;
    note(err.message);
  }
}

/* ---------- go ---------- */

if (el("ae-views")) {
  paintAll();
  const clear = el("ae-mid-clear");
  if (clear) {
    clear.addEventListener("click", () => { middle = ""; paintAll(); save(); });
  }
  el("ae-duration").addEventListener("change", renderCost);
  el("ae-resolution").addEventListener("change", renderCost);
}
