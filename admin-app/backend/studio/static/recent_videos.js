/* The videos already made, on the way in to Video or Scenery.

   Grouped by property, not laid out flat. Eleven clips of two houses as
   eleven tiles is a wall of near-identical thumbnails -- five of them the
   same driveway from the same height -- and picking one out of it means
   reading the caption under each. The question being answered here is "which
   house", and only then "which clip"; a listing with six clips is one thing
   to scan past, not six.

   So each property is one card, and it opens that property's videos. Not the
   profile: the profile is everything known about a listing and the clips are
   one panel of it, and somebody who clicked a video thumbnail asked for the
   videos. This page does not try to be a second gallery. */

(async function recentVideos() {
  const card = document.getElementById("rv-card");
  const grid = document.getElementById("rv-grid");
  if (!card || !grid) return;

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  /* Naive UTC without a zone reads as local time in the browser. */
  function when(value) {
    if (!value) return null;
    const utc = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value + "Z";
    const at = new Date(utc);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  function ago(at) {
    if (!at) return "";
    const mins = Math.round((Date.now() - at.getTime()) / 60000);
    if (mins < 60) return "latest just now";
    const hours = Math.round(mins / 60);
    if (hours < 24) return "latest today";
    const days = Math.round(hours / 24);
    return days === 1 ? "latest yesterday" : "latest " + days + " days ago";
  }

  let runs = [];
  try {
    const res = await fetch("/studio/api/video/jobs");
    if (!res.ok) return;
    runs = (await res.json()).renders || [];
  } catch (err) {
    return;  // nothing rendered, or nothing reachable: show no section
  }

  // One entry per property. A render with no lead behind it -- photos from a
  // pasted link or an upload -- has nowhere to group under and no profile to
  // open, so those keep their own card and open the render itself.
  const homes = new Map();
  runs.forEach((run) => {
    const clips = (run.clips || []).filter((c) => c.video_url);
    if (!clips.length) return;
    const key = run.lead_id ? "lead:" + run.lead_id : "run:" + run.id;
    let home = homes.get(key);
    if (!home) {
      home = {
        lead: run.lead_id,
        job: run.id,
        name: run.address || "No listing",
        poster: clips[0].video_url,
        clips: 0,
        latest: null,
        styles: new Set(),
      };
      homes.set(key, home);
    }
    home.clips += clips.length;
    if (run.style) home.styles.add(run.style);
    const made = when(run.created_at);
    if (made && (!home.latest || made > home.latest)) {
      home.latest = made;
      home.poster = clips[0].video_url;
    }
  });

  const list = [...homes.values()].sort(
    (a, b) => (b.latest ? b.latest.getTime() : 0) - (a.latest ? a.latest.getTime() : 0));
  if (!list.length) return;

  const STYLES = { drone: "drone", walkthrough: "walkthrough", basic: "basic" };

  grid.innerHTML = list.map((home) => {
    // Straight to the videos, not the profile. The profile is everything
    // known about a listing and the clips are one panel of it; somebody who
    // clicked a video thumbnail asked for the videos.
    const href = home.lead
      ? "/studio/create/video/clips?lead_id=" + home.lead
      : "/studio/create/render?job=" + home.job;
    const kinds = [...home.styles].map((s) => STYLES[s]).filter(Boolean);
    // #t=0.5 so the poster frame is half a second in: the first frame of a
    // drone shot is often the sky.
    return '<a class="rv-tile" href="' + esc(href) + '">' +
      '<video src="' + esc(home.poster) + '#t=0.5" preload="metadata" muted></video>' +
      '<span class="rv-name">' + esc(home.name) + "</span>" +
      '<span class="rv-sub">' + home.clips +
      (home.clips === 1 ? " clip" : " clips") +
      (kinds.length ? " · " + esc(kinds.join(", ")) : "") +
      (home.latest ? " · " + esc(ago(home.latest)) : "") + "</span></a>";
  }).join("");

  const clips = list.reduce((n, h) => n + h.clips, 0);
  document.getElementById("rv-note").textContent =
    list.length + (list.length === 1 ? " property" : " properties") + ", " +
    clips + (clips === 1 ? " clip" : " clips") +
    " — open one to see its videos.";
  card.hidden = false;
}());
