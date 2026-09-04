/* The aerial.

   Its own shot, and nothing to do with the flyover: ONE clip warping
   between two of the listing's own pictures. A start frame, an end frame
   and one line about fast travel.

   The prompt is two sentences and that is deliberate: see AERIAL_MOVES in
   services/video.py. Told not to warp or blur -- which is what the
   flyover's wording says, at length -- this shot comes back as a slow
   drift, which is what was wrong with every version of it before this one. */

const lead = window.__LEAD__;
const wide = window.__WIDE__ || [];
const labels = window.__LABELS__ || {};
const rates = window.__RATES__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { if (el("ae-note")) el("ae-note").textContent = text || ""; };

/* Where it starts, and where it ends. */
let picks = (window.__PICKS__ || []).slice(0, 2);
while (picks.length < 2) picks.push(wide[picks.length] || "");

/* The standard wording, and the edit to it if any. */
let standard = "";
let edit = null;
const promptNow = () => (edit === null ? standard : edit);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const nameOf = (url) => labels[url] || "Listing photo";
const seconds = () => Number(el("ae-secs").value) || 5;

function cost() {
  const rate = rates["1080p"] || rates["*"];
  return rate ? rate * seconds() : null;
}

/* ---------- choosing the two ---------- */

/* The picture used in the other slot is shown but cannot be picked: a clip
   that starts and ends on the same frame has nothing to do. */
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
  for (let i = 0; i < 2; i += 1) {
    el("ae-img" + i).src = picks[i] || "";
    el("ae-name" + i).textContent = picks[i] ? nameOf(picks[i]) : "Choose below";
  }
}

function paintCost() {
  const dollars = cost();
  el("ae-cost").textContent = "One clip, " + seconds() + " seconds"
    + (dollars != null ? " — about $" + dollars.toFixed(2) : "") + ".";
}

function paintAll() {
  for (let i = 0; i < 2; i += 1) paintPicker(i);
  paintStrip();
  paintCost();
}

el("ae-secs").addEventListener("change", paintCost);

/* Remembered, so leaving the page does not throw the choices away. */
async function save() {
  try {
    await fetch("/studio/api/leads/" + lead + "/aerial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opening: picks[0], end: picks[1] }),
    });
  } catch (err) {
    /* the choices still apply to this run; only the memory of them is lost */
  }
}

/* ---------- the confirmation ---------- */

el("ae-go").addEventListener("click", async () => {
  if (picks.some((url) => !url)) { note("Pick both pictures."); return; }
  note("Reading the prompt…");
  try {
    const res = await fetch("/studio/api/video/drone/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: lead, shot: "aerial" }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't read the prompt");
    // Fetched rather than rebuilt here: a preview assembled its own way is
    // a preview of something else.
    standard = body.prompt || "";
    note("");
    review(body);
  } catch (err) {
    note(err.message);
  }
});

function review(body) {
  el("ae-review-prompt").value = promptNow();

  const captions = ["Starts on", "Rests on"];
  el("ae-review-frames").innerHTML = picks.map((url, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + esc(url) + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + captions[i] +
    '<span class="gn-review-also">' + esc(nameOf(url)) + "</span>" +
    "</figcaption></figure>").join("");

  const dollars = cost();
  el("ae-review-specs").textContent =
    "One clip · " + seconds() + " seconds · 1080p · "
    + (body.model || "the video model")
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
        start: picks[0],
        end: picks[1],
        duration: seconds(),
        // Sent every time, edited or not: "what I saw" and "what ran" are
        // the same string or the confirmation was theatre.
        prompt: promptNow(),
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
