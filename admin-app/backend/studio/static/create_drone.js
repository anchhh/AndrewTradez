/* The drone shot: a recap, then a confirmation, then one clip.

   Nothing is chosen here except how long the clip runs and how big it is.
   Which two photographs the flight travels between was answered at stage 4
   by generating them; the route was answered at stage 5 by drawing it; and
   the camera move is not a question at all -- every shot this flow makes is
   a drone flight, and how high it goes is a consequence of the route.

   Asking any of that again was letting the same thing be answered two ways
   on two pages, and then rendering whichever page was last. */

const lead = window.__LEAD__;
const made = window.__MADE__ || {};
const rates = window.__RATES__ || {};
const described = window.__DESCRIBED__ || "";
const moveName = window.__MOVE_NAME__ || "Drone flight";
const flight = window.__FLIGHT__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { el("dr-note").textContent = text || ""; };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------- what it costs ---------- */

function renderCost() {
  const seconds = Number(el("dr-duration").value);
  // The rate table can price every resolution the same, and says so with a
  // "*" key. Reading only the exact resolution missed that and quietly
  // showed a length where a price belonged.
  const rate = rates[el("dr-resolution").value] || rates["*"];
  el("dr-cost").textContent = rate
    ? "About $" + (rate * seconds).toFixed(2) + " for " + seconds + " seconds."
    : seconds + " seconds.";
}

/* ---------- what will be sent ---------- */

/* The prompt is two thousand characters of constraint that a year of failed
   renders paid for, and until now none of it was on screen -- the button
   spent a couple of dollars on wording nobody could read. Fetched rather
   than rebuilt here: a preview assembled its own way is a preview of
   something else. */

let standard = "";
let edited = null;

const promptNow = () => (edited === null ? standard : edited);

el("dr-go").addEventListener("click", async () => {
  note("Reading the prompt…");
  try {
    const res = await fetch("/studio/api/video/drone/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead,
        duration: Number(el("dr-duration").value),
        resolution: el("dr-resolution").value,
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
  el("dr-review-prompt").value = promptNow();

  const ends = [[made.front, "Opens on", "The front"],
                [made.back, "Lands on", "The back"]];
  el("dr-review-frames").innerHTML = ends.map((end, i) =>
    '<figure class="gn-review-shot' + (i === 0 ? " is-base" : "") + '">' +
    '<img src="' + end[0] + '" alt="">' +
    '<figcaption><b>' + (i + 1) + "</b> " + end[1] +
    '<span class="gn-review-also">' + escapeHtml(end[2]) + "</span>" +
    "</figcaption></figure>").join("");

  el("dr-review-path").textContent = described
    || "No route drawn — the camera has only the two photographs to work between.";

  const seconds = Number(el("dr-duration").value);
  el("dr-review-specs").textContent =
    moveName + " · " + seconds + " seconds · " + el("dr-resolution").value +
    " · " + (body.model || "the video model");

  el("dr-review").hidden = false;
}

function closeReview() { el("dr-review").hidden = true; }

el("dr-review-cancel").addEventListener("click", closeReview);
el("dr-review-reset").addEventListener("click", () => {
  edited = null;
  el("dr-review-prompt").value = standard;
});
el("dr-review").addEventListener("click", (e) => {
  if (e.target.id === "dr-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("dr-review").hidden) closeReview();
});

el("dr-review-go").addEventListener("click", () => {
  const typed = el("dr-review-prompt").value.trim();
  edited = typed && typed !== standard ? typed : null;
  closeReview();
  generate();
});

/* ---------- generating ---------- */

async function generate() {
  const button = el("dr-go");
  button.disabled = true;
  note("");
  el("dr-running").hidden = false;
  el("dr-run-title").textContent = "Generating the shot";
  el("dr-run-sub").textContent =
    "One clip. This takes a couple of minutes — you can leave the page.";

  try {
    const res = await fetch("/studio/api/video/drone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: lead,
        start: made.front,
        end: made.back,
        duration: Number(el("dr-duration").value),
        resolution: el("dr-resolution").value,
        // Sent every time, edited or not: "what I saw" and "what ran" are
        // the same string or the confirmation was theatre.
        prompt: promptNow(),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "the shot couldn't be started");
    poll(body.job_id);
  } catch (err) {
    button.disabled = false;
    el("dr-running").hidden = true;
    note(err.message);
  }
}

/* Polled rather than pushed, the same way the shots step does it: generation
   runs on a background thread and the page has to survive being left. */
async function poll(jobId) {
  try {
    const res = await fetch("/studio/api/video/jobs/" + jobId);
    const job = await res.json();
    const clip = (job.clips || [])[0] || {};

    if (job.status === "completed" && clip.url) {
      el("dr-run-title").textContent = "Done";
      el("dr-run-sub").textContent = "";
      el("dr-result").innerHTML =
        '<video src="' + clip.url + '" controls playsinline class="dr-video"></video>';
      el("dr-go").disabled = false;
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      el("dr-run-title").textContent = "That didn't work";
      el("dr-run-sub").textContent = job.error || clip.error || "";
      el("dr-go").disabled = false;
      return;
    }
    setTimeout(() => poll(jobId), 4000);
  } catch (err) {
    setTimeout(() => poll(jobId), 6000);
  }
}

/* ---------- the route, drawn ---------- */

/* The same line the flight stage drew, over the same picture. It is a
   read-back and it should read back the thing itself: an overhead with no
   line on it is indistinguishable from an overhead with no line SAVED. */
function drawRoute() {
  const img = el("dr-route-img");
  const canvas = el("dr-route-canvas");
  const points = flight.points || [];
  if (!img || !canvas || points.length < 2 || !flight.width) return;

  canvas.width = img.clientWidth;
  canvas.height = img.clientHeight;
  const sx = img.clientWidth / flight.width;
  const sy = img.clientHeight / flight.height;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const line = points.map((p) => [p[0] * sx, p[1] * sy]);

  // Dark casing under a light line, so it reads over a pale driveway and a
  // dark roof alike -- the same pair the flight stage draws with.
  [["rgba(12,10,8,0.55)", 5], ["#ff6b35", 2.5]].forEach((pair) => {
    ctx.beginPath();
    ctx.moveTo(line[0][0], line[0][1]);
    line.slice(1).forEach((p) => ctx.lineTo(p[0], p[1]));
    ctx.strokeStyle = pair[0];
    ctx.lineWidth = pair[1];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  });

  [[line[0], "#ff6b35"], [line[line.length - 1], "#1f7a4d"]].forEach((end) => {
    ctx.beginPath();
    ctx.arc(end[0][0], end[0][1], 5, 0, Math.PI * 2);
    ctx.fillStyle = end[1];
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });
}

if (el("dr-route-img")) {
  const img = el("dr-route-img");
  if (img.complete) drawRoute(); else img.addEventListener("load", drawRoute);
  window.addEventListener("resize", drawRoute);
}

/* ---------- go ---------- */

if (el("dr-duration")) {
  el("dr-duration").addEventListener("change", renderCost);
  el("dr-resolution").addEventListener("change", renderCost);
  renderCost();
}
