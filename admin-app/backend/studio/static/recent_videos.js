/* The videos already made, on the way in.

   Reads the same endpoint the lead profile reads, so there is one answer to
   "what has been rendered" rather than two that can disagree. No style
   filter: a person looking for a clip remembers the house, not which of
   three cards they clicked a week ago. */

(async function recentVideos() {
  const card = document.getElementById("rv-card");
  const grid = document.getElementById("rv-grid");
  if (!card || !grid) return;

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  let runs = [];
  try {
    const res = await fetch("/studio/api/video/jobs");
    if (!res.ok) return;
    runs = (await res.json()).renders || [];
  } catch (err) {
    return;  // nothing rendered, or nothing reachable: show no section
  }

  // One tile per clip rather than per run: a run is bookkeeping, a clip is
  // the thing being looked for.
  const tiles = [];
  runs.forEach((run) => {
    (run.clips || []).forEach((clip) => {
      if (!clip.video_url) return;
      tiles.push({
        url: clip.video_url,
        address: run.address || "No listing",
        lead: run.lead_id,
        when: run.created_at,
      });
    });
  });

  if (!tiles.length) return;

  grid.innerHTML = tiles.slice(0, 24).map((t) => {
    // #t=0.5 so the poster frame is half a second in: the first frame of a
    // drone shot is often the sky.
    const open = t.lead ? "/studio/leads/" + t.lead : t.url;
    return '<a class="rv-tile" href="' + esc(open) + '">' +
      '<video src="' + esc(t.url) + '#t=0.5" preload="metadata" muted></video>' +
      '<span class="rv-name">' + esc(t.address) + "</span></a>";
  }).join("");

  document.getElementById("rv-note").textContent =
    tiles.length + (tiles.length === 1 ? " clip" : " clips") +
    ", newest first — drone, walkthrough and basic together.";
  card.hidden = false;
}());
