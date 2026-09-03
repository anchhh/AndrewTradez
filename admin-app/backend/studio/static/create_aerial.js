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
let standard = "";
let edited = null;

const promptNow = () => (edited === null ? standard : edited);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* What a capture is, from the box it was placed in. Walked in the plan's
   order rather than the object's, which arrives alphabetically sorted. */
function nameOf(url) {
  const key = slotOrder.find((k) => (slots[k] || []).includes(url));
  return shotLabels[key] || "Capture";
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
      el("ae-open-img").src = opening;
      el("ae-open-name").textContent = nameOf(opening);
      paintViews();
      save();
    }));

  if (opening) el("ae-open-name").textContent = nameOf(opening);
}

/* Remembered, so leaving the page does not throw the choice away. */
async function save() {
  try {
    await fetch("/studio/api/leads/" + lead + "/aerial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opening: opening }),
    });
  } catch (err) {
    /* the choice still applies to this run; only the memory of it is lost */
  }
}

/* ---------- what it costs ---------- */

function renderCost() {
  const seconds = Number(el("ae-duration").value);
  const rate = rates[el("ae-resolution").value] || rates["*"];
  el("ae-cost").textContent = rate
    ? "About $" + (rate * seconds).toFixed(2) + " for " + seconds + " seconds."
    : seconds + " seconds.";
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
        lead_id: lead, shot: "aerial",
        duration: Number(el("ae-duration").value),
        resolution: el("ae-resolution").value,
      }),
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

  const ends = [[opening, "Opens on", nameOf(opening)],
                [front, "Lands on", "The front"]];
  el("ae-review-frames").innerHTML = ends.map((end, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + esc(end[0]) + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + end[1] +
    '<span class="gn-review-also">' + esc(end[2]) + "</span>" +
    "</figcaption></figure>").join("");

  const seconds = Number(el("ae-duration").value);
  el("ae-review-specs").textContent =
    moveName + " · " + seconds + " seconds · " + el("ae-resolution").value +
    " · " + (body.model || "the video model");

  el("ae-review").hidden = false;
}

function closeReview() { el("ae-review").hidden = true; }

el("ae-review-cancel").addEventListener("click", closeReview);
el("ae-review-reset").addEventListener("click", () => {
  edited = null;
  el("ae-review-prompt").value = standard;
});
el("ae-review").addEventListener("click", (e) => {
  if (e.target.id === "ae-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ae-review").hidden) closeReview();
});

el("ae-review-go").addEventListener("click", () => {
  const typed = el("ae-review-prompt").value.trim();
  edited = typed && typed !== standard ? typed : null;
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
        end: front,
        duration: Number(el("ae-duration").value),
        resolution: el("ae-resolution").value,
        prompt: promptNow(),
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
  paintViews();
  el("ae-duration").addEventListener("change", renderCost);
  el("ae-resolution").addEventListener("change", renderCost);
  renderCost();
}
