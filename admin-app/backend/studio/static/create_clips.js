/* Stage 7: the shelf.

   Every clip this property has produced, whatever made it. Reads the same
   endpoint the lead profile and the Create screen read, so there is one
   answer to "what has been rendered" rather than three that can disagree.

   A render opened from anywhere else lands here with its id in the query, so
   the thing you came back for is the thing that is highlighted and scrolled
   to -- rather than making you find it among its siblings. */

const lead = window.__LEAD__;
const highlight = String(window.__HIGHLIGHT__ || "");

const el = (id) => document.getElementById(id);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* The server writes naive UTC and isoformat() omits the zone, which the
   browser then reads as local time. Say Z when nothing else does. */
function when(value) {
  if (!value) return null;
  const utc = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value + "Z";
  const at = new Date(utc);
  return Number.isNaN(at.getTime()) ? null : at;
}

function ago(value) {
  const at = when(value);
  if (!at) return "";
  const mins = Math.round((Date.now() - at.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  return at.toLocaleDateString();
}

const STYLES = { drone: "Drone shot", walkthrough: "Walkthrough", basic: "Basic" };

/* The order sections appear in, and what an unlabelled render is called.

   Fixed rather than sorted by count or recency, so the page does not
   rearrange itself between visits -- a section that moves is a section you
   have to find again. Renders made before the style was recorded have none,
   and "Video" is the honest name for those rather than a guess. */
const SECTIONS = ["drone", "walkthrough", "basic", ""];
const SECTION_NAMES = Object.assign({}, STYLES, { "": "Video" });

/* Back to where a clip was made.

   A clip on its own says nothing about how to make another like it, and
   "which page produced this" is the thing you want the moment you decide a
   clip is nearly right. Drone shots go to their own stage, which still holds
   the two frames and the route that made them; everything else goes to the
   render page for that run, which is where its photo grid and per-clip moves
   live. */
function madeAt(run) {
  if (run.style === "drone") {
    return "/studio/create/video/drone?lead_id=" + lead + "&style=drone";
  }
  return "/studio/create/render?job=" + run.id
    + "&from=clips&lead_id=" + lead;
}

async function load() {
  let runs = [];
  try {
    const res = await fetch("/studio/api/video/jobs");
    if (!res.ok) throw new Error();
    runs = ((await res.json()).renders || [])
      .filter((r) => String(r.lead_id) === String(lead));
  } catch (err) {
    el("cl-note").textContent = "Couldn't reach the server to list the clips.";
    return;
  }

  // One tile per clip, not per run: a run is bookkeeping and a clip is the
  // thing being looked for.
  const tiles = [];
  runs.forEach((run) => {
    (run.clips || []).forEach((clip) => {
      if (!clip.video_url) return;
      tiles.push({
        url: clip.video_url,
        job: run.id,
        group: SECTIONS.includes(run.style || "") ? (run.style || "") : "",
        style: STYLES[run.style] || "Video",
        origin: madeAt(run),
        cost: run.cost != null ? run.cost : run.estimated_cost,
        model: run.model_label || "",
        made: run.created_at,
      });
    });
  });

  if (!tiles.length) {
    el("cl-empty").hidden = false;
    el("cl-note").textContent = "Nothing rendered for this listing yet.";
    return;
  }

  // A section per style, in a fixed order, empty ones left out. Eleven clips
  // of one house in one pile is the same wall this page was built to replace,
  // one level down: "the drone ones" is how somebody asks for them.
  const tile = (t) => `
    <figure class="cl-tile${String(t.job) === highlight ? " is-here" : ""}"
            id="cl-job-${t.job}">
      <video src="${esc(t.url)}" controls playsinline preload="metadata"></video>
      <figcaption>
        <a class="cl-style" href="${esc(t.origin)}"
           title="Open the step this was made in">${esc(t.style)} &rarr;</a>
        <span class="cl-meta">${esc(ago(t.made))}${
          t.cost != null ? " · $" + Number(t.cost).toFixed(2) : ""}${
          t.model ? " · " + esc(t.model) : ""}</span>
        <a class="btn-tiny" href="${esc(t.url)}" download>Download</a>
      </figcaption>
    </figure>`;

  el("cl-grid").innerHTML = SECTIONS.map((key) => {
    const mine = tiles.filter((t) => t.group === key);
    if (!mine.length) return "";
    return `
      <section class="cl-section">
        <h3 class="cl-section-head">${esc(SECTION_NAMES[key])}
          <span class="cl-section-n">${mine.length}</span>
        </h3>
        <div class="cl-row">${mine.map(tile).join("")}</div>
      </section>`;
  }).join("");

  const kinds = SECTIONS.filter((k) => tiles.some((t) => t.group === k)).length;
  el("cl-note").textContent =
    tiles.length + (tiles.length === 1 ? " clip" : " clips")
    + (kinds > 1 ? ", grouped by what made them." : ".")
    + " Newest first within each group; the style name opens the step it was"
    + " made in.";

  // Scrolled to rather than merely marked: on a listing with a dozen clips,
  // an outline below the fold is not an answer to "where is the one I just
  // opened".
  const here = highlight && el("cl-job-" + highlight);
  if (here) here.scrollIntoView({ behavior: "smooth", block: "center" });
}

load();
