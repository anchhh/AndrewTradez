/* Waiting for a clip.

   The bar cannot be honest about progress -- the provider reports "queued"
   or "processing" and nothing in between -- so it is honest about ELAPSED
   time instead: it advances toward a typical render's length and then holds
   short of the end rather than claiming to be finished. A bar that reaches
   100% and stays there is worse than one that admits it is still going. */

const job = window.__JOB__ || {};
const profile = window.__PROFILE__ || "";

const el = (id) => document.getElementById(id);

// What a clip usually takes, from this app's own runs: about two and a half
// minutes for ten seconds at 1080p, longer for fifteen.
const EXPECTED = Math.max(90, (Number(job.duration) || 10) * 15) * 1000;

/* The server stores naive UTC and isoformat() writes it without a zone, which
   the browser then reads as LOCAL time -- six hours in the future here, and
   an elapsed counter that ran backwards. Say Z when nothing else says it. */
function when(value) {
  if (!value) return Date.now();
  const utc = /(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value + "Z";
  const at = new Date(utc).getTime();
  return Number.isNaN(at) ? Date.now() : Math.min(at, Date.now());
}

const started = when(job.created_at);

let done = false;

function tick() {
  if (done) return;
  const spent = Date.now() - started;
  // Approaches the end without arriving: eased so it slows as it goes, which
  // is also how it feels.
  const share = 1 - Math.exp(-spent / EXPECTED);
  el("rd-bar").style.width = (4 + share * 90).toFixed(1) + "%";

  const mins = Math.floor(spent / 60000);
  const secs = Math.floor((spent % 60000) / 1000);
  el("rd-phase").textContent = "Rendering — " + (mins ? mins + "m " : "") +
    secs + "s elapsed";
}

function finish(url) {
  done = true;
  el("rd-title").textContent = "Done";
  el("rd-stage").hidden = true;
  el("rd-cancel").hidden = true;
  el("rd-result").innerHTML =
    '<video src="' + url + '" controls playsinline autoplay muted ' +
    'class="rd-video"></video>' +
    '<p class="hint">Saved to this listing. It is in the lead profile under ' +
    'Video, and in your videos on the Create screen.</p>';
}

function fail(message) {
  done = true;
  el("rd-title").textContent = "That didn't work";
  el("rd-stage").hidden = true;
  el("rd-cancel").hidden = true;
  el("rd-result").innerHTML = '<p class="rn-scope-note is-warn">' +
    (message || "The render stopped before it finished.") + "</p>";
}

async function poll() {
  if (done) return;
  try {
    const res = await fetch("/studio/api/video/jobs/" + job.id);
    const body = await res.json();
    // This endpoint answers {job: {...}}. Reading the envelope as the job is
    // exactly the bug that made the old inline panel spin forever.
    const now = body.job || body;
    const clip = (now.clips || [])[0] || {};

    if (now.status === "completed" && (now.output_url || clip.video_url)) {
      finish(now.output_url || clip.video_url);
      return;
    }
    if (now.status === "failed" || now.status === "cancelled") {
      fail(now.error || clip.error);
      return;
    }
  } catch (err) {
    // A dropped poll says nothing about the render; the next one is 4s away.
  }
  setTimeout(poll, 4000);
}

el("rd-cancel").addEventListener("click", async () => {
  el("rd-cancel").disabled = true;
  try {
    await fetch("/studio/api/video/jobs/" + job.id + "/cancel", { method: "POST" });
  } catch (err) {
    /* the poll will report whatever actually happened */
  }
});

/* A job that was already finished when this page opened -- arrived at from a
   link, or reloaded after the fact -- should show its video immediately
   rather than pretending to wait for it. */
const first = (job.clips || [])[0] || {};
if (job.status === "completed" && (job.output_url || first.video_url)) {
  finish(job.output_url || first.video_url);
} else if (job.status === "failed" || job.status === "cancelled") {
  fail(job.error || first.error);
} else {
  setInterval(tick, 1000);
  tick();
  poll();
}
