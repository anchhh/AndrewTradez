/* The aerial.

   Its own shot, and nothing to do with the flyover: three of the listing's
   own pictures, warped between. Clip one rushes from photo 1 to photo 2 --
   a start frame, an end frame and one line about fast travel. Clip two
   comes out of the warp and pans to rest on photo 3. They join into one
   file, seamlessly, because clip one ends on exactly the frame clip two
   begins on.

   The prompts are two short sentences and that is deliberate: see
   AERIAL_MOVES in services/video.py. Told not to warp or blur, this shot
   comes back as a slow drift, which is what was wrong with every version
   of it before this one. */

const lead = window.__LEAD__;
const wide = window.__WIDE__ || [];
const labels = window.__LABELS__ || {};
const rates = window.__RATES__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { if (el("ae-note")) el("ae-note").textContent = text || ""; };

/* The three, in order. */
let picks = (window.__PICKS__ || []).slice(0, 3);
while (picks.length < 3) picks.push(wide[picks.length] || "");

/* One standard wording per clip, and one edit slot per clip: the warp and
   coming out of it are different instructions, and an edit to one leaves
   the other alone. */
let standards = ["", ""];
let edits = [null, null];
const promptNow = (i) => (edits[i] === null ? (standards[i] || "") : edits[i]);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const nameOf = (url) => labels[url] || "Listing photo";

const warpSecs = () => Number(el("ae-warp-secs").value) || 3;
const settleSecs = () => Number(el("ae-settle-secs").value) || 5;
const seconds = () => warpSecs() + settleSecs();

function cost() {
  const rate = rates["1080p"] || rates["*"];
  return rate ? rate * seconds() : null;
}

/* ---------- choosing the three ---------- */

/* A picture already used in another slot is shown but cannot be picked:
   the shot travels between three different places, and two identical
   frames is a clip with nothing to do. */
function paintPicker(slot) {
  const box = el("ae-pick" + slot);
  if (!box) return;
  box.innerHTML = wide.map((url) => {
    const mine = url === picks[slot];
    const taken = !mine && picks.includes(url);
    return '<button type="button" class="fp-view' + (mine ? " is-on" : "") +
      '" data-url="' + esc(url) + '"' + (taken ? " disabled" : "") +
      ' title="' + esc(nameOf(url)) + (taken ? " — already used" : "") +
      '"><img src="' + esc(url) + '" alt=""></button>';
  }).join("");

  box.querySelectorAll(".fp-view").forEach((button) =>
    button.addEventListener("click", () => {
      picks[slot] = button.dataset.url;
      paintAll();
      save();
    }));
}

function paintStrip() {
  for (let i = 0; i < 3; i += 1) {
    el("ae-img" + i).src = picks[i] || "";
    el("ae-name" + i).textContent = picks[i] ? nameOf(picks[i]) : "Choose below";
  }
}

function paintCost() {
  const dollars = cost();
  el("ae-cost").textContent =
    "Two clips, " + seconds() + " seconds"
    + (dollars != null ? " — about $" + dollars.toFixed(2) : "")
    + ", joined into one.";
}

function paintAll() {
  for (let i = 0; i < 3; i += 1) paintPicker(i);
  paintStrip();
  paintCost();
}

el("ae-warp-secs").addEventListener("change", paintCost);
el("ae-settle-secs").addEventListener("change", paintCost);

/* Remembered, so leaving the page does not throw the choices away. */
async function save() {
  try {
    await fetch("/studio/api/leads/" + lead + "/aerial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opening: picks[0], middle: picks[1], end: picks[2] }),
    });
  } catch (err) {
    /* the choices still apply to this run; only the memory of them is lost */
  }
}

/* ---------- the confirmation ---------- */

el("ae-go").addEventListener("click", async () => {
  if (picks.some((url) => !url)) { note("Pick all three pictures."); return; }
  note("Reading the prompts…");
  try {
    const res = await fetch("/studio/api/video/drone/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: lead, shot: "aerial" }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't read the prompts");
    // Fetched rather than rebuilt here: a preview assembled its own way is
    // a preview of something else.
    standards = (body.prompts && body.prompts.length === 2)
      ? body.prompts : [body.prompt || "", ""];
    note("");
    review(body);
  } catch (err) {
    note(err.message);
  }
});

function review(body) {
  el("ae-review-prompt0").value = promptNow(0);
  el("ae-review-prompt1").value = promptNow(1);

  const captions = ["Starts on", "Arrives on, then sets off from", "Rests on"];
  el("ae-review-frames").innerHTML = picks.map((url, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + esc(url) + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + captions[i] +
    '<span class="gn-review-also">' + esc(nameOf(url)) + "</span>" +
    "</figcaption></figure>").join("");

  const dollars = cost();
  el("ae-review-specs").textContent =
    warpSecs() + " s warp + " + settleSecs() + " s pan · " + seconds()
    + " seconds · 1080p · " + (body.model || "the video model")
    + (dollars != null ? " · about $" + dollars.toFixed(2) : "");

  el("ae-review").hidden = false;
}

function closeReview() { el("ae-review").hidden = true; }

el("ae-review-cancel").addEventListener("click", closeReview);
el("ae-review-reset").addEventListener("click", () => {
  edits = [null, null];
  el("ae-review-prompt0").value = promptNow(0);
  el("ae-review-prompt1").value = promptNow(1);
});
el("ae-review").addEventListener("click", (e) => {
  if (e.target.id === "ae-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ae-review").hidden) closeReview();
});

el("ae-review-go").addEventListener("click", () => {
  // Remembered per clip, so a second confirmation opens on what just ran.
  for (let i = 0; i < 2; i += 1) {
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
    const res = await fetch("/studio/api/video/drone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead,
        shot: "aerial",
        start: picks[0],
        middle: picks[1],
        end: picks[2],
        warp: warpSecs(),
        settle: settleSecs(),
        // Sent every time, edited or not: "what I saw" and "what ran" are
        // the same string or the confirmation was theatre.
        prompts: [promptNow(0), promptNow(1)],
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "the aerial couldn't be started");
    window.location.href = "/studio/create/video/rendering?job=" + body.job_id
      + "&style=drone";
  } catch (err) {
    el("ae-go").disabled = false;
    note(err.message);
  }
}

paintAll();
