/* The Google Earth stage: open Earth at this address, come back with a
   screenshot of it.

   The capture cannot happen in the page. Earth refuses to be framed
   (X-Frame-Options: SAMEORIGIN) and a cross-origin frame cannot be
   screenshotted anyway, so the screenshot is taken outside and handed back
   here. What this page does is make that round trip short and store the
   result where the flight planner will look for it. */

const lead = window.__LEAD__;
const el = (id) => document.getElementById(id);
const note = (text) => { el("ge-note").textContent = text || ""; };

function show(url) {
  el("ge-shot-img").src = url;
  el("ge-shot").hidden = false;
  el("ge-drop").hidden = true;
}

async function upload(file) {
  const form = new FormData();
  form.append("photos", file);
  const res = await fetch("/studio/api/upload", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "that image couldn't be saved");
  const url = (body.photos || [])[0];
  // Uploads are de-duplicated by image hash, so the same capture twice comes
  // back with nothing rather than an error.
  if (!url) throw new Error("that screenshot is already on this listing");
  return url;
}

async function take(file) {
  if (!file) return;
  note("Saving…");
  try {
    const url = await upload(file);
    // Stored against the lead, not held in the page: the planner is a
    // separate screen, and a capture that only exists here would have to be
    // taken again when you get there.
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that view couldn't be saved");
    show(url);
    note("Saved. Draw the flight path on it at the next step.");
  } catch (err) {
    note(err.message);
  }
}

el("ge-file").addEventListener("change", (e) => take(e.target.files[0]));
el("ge-replace").addEventListener("click", () => {
  el("ge-shot").hidden = true;
  el("ge-drop").hidden = false;
  note("");
});

const drop = el("ge-drop");
["dragenter", "dragover"].forEach((name) =>
  drop.addEventListener(name, (e) => {
    e.preventDefault();
    drop.classList.add("is-over");
  }));
["dragleave", "drop"].forEach((name) =>
  drop.addEventListener(name, (e) => {
    e.preventDefault();
    drop.classList.remove("is-over");
  }));
drop.addEventListener("drop", (e) => take(e.dataTransfer.files[0]));

/* A capture made on an earlier visit, so coming back does not look like
   nothing happened. */
(async function start() {
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`);
    const body = await res.json();
    const saved = (body.path || {}).image;
    if (saved) {
      show(saved);
      note("Captured earlier. Replace it if the view has changed.");
    }
  } catch (err) { /* nothing saved yet is the normal case */ }
})();
