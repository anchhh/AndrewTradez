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

let images = [];
let primary = null;

/* Every view captured for this property. The one the path is drawn on is
   marked, because the path is stored in that picture's coordinates -- moving
   it to another would be a line over the wrong roof. */
function renderShots() {
  const box = el("ge-shots");
  if (!images.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = images.map((url) => `
    <figure class="ge-shot${url === primary ? " is-primary" : ""}" data-url="${url}">
      <img src="${url}" alt="A captured view of this property">
      <figcaption>
        ${url === primary
          ? `<span class="ge-badge">Drawing on this</span>`
          : `<button type="button" class="btn-secondary btn-tiny" data-act="primary">Draw on this</button>`}
        <button type="button" class="ge-x" data-act="remove" aria-label="Remove">&times;</button>
      </figcaption>
    </figure>`).join("");

  box.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const url = button.closest(".ge-shot").dataset.url;
      change(button.dataset.act, url);
    });
  });
}

/* One endpoint for add, choose and remove, so the three cannot disagree
   about what the flight plan holds. */
async function change(action, url) {
  note(action === "remove" ? "Removing…" : "Saving…");
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, image: url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that didn't save");
    images = body.images || [];
    primary = (body.path || {}).image || null;
    renderShots();
    note(action === "primary"
      ? "The flight path will be drawn on that view."
      : "Saved.");
  } catch (err) {
    note(err.message);
  }
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

async function take(files) {
  const chosen = [...(files || [])];
  if (!chosen.length) return;
  note(chosen.length > 1 ? `Saving ${chosen.length} screenshots…` : "Saving…");
  let added = 0;
  for (const file of chosen) {
    try {
      await change("add", await upload(file));
      added += 1;
    } catch (err) {
      note(err.message);
    }
  }
  if (added) {
    note(added > 1
      ? `${added} views saved. Draw the flight path on one of them at the next step.`
      : "Saved. Draw the flight path on it at the next step.");
  }
}

el("ge-file").addEventListener("change", (e) => take(e.target.files));
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
drop.addEventListener("drop", (e) => take(e.dataTransfer.files));

/* A capture made on an earlier visit, so coming back does not look like
   nothing happened. */
(async function start() {
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`);
    const body = await res.json();
    images = body.images || [];
    primary = (body.path || {}).image || null;
    renderShots();
    if (images.length) {
      note(`${images.length} view${images.length > 1 ? "s" : ""} captured so far.`);
    }
  } catch (err) { /* nothing saved yet is the normal case */ }
})();
