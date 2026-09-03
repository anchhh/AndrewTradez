/* The Google Earth stage: open Earth at this address, come back with a
   screenshot of it.

   The capture cannot happen in the page. Earth refuses to be framed
   (X-Frame-Options: SAMEORIGIN) and a cross-origin frame cannot be
   screenshotted anyway, so the screenshot is taken outside -- by the
   extension, which is the only thing here that can read another tab -- and
   sent straight to this listing. This page opens Earth at the address and
   shows what has come back. */

const lead = window.__LEAD__;
const el = (id) => document.getElementById(id);
const note = (text) => { el("ge-note").textContent = text || ""; };

let images = [];

/* Every view captured for this property.

   No "draw on this" here any more: which view the flight is planned on is a
   question for the planner, where the drawing actually happens and where the
   answer is visible immediately. This stage is a collection. */
function renderShots() {
  const box = el("ge-shots");
  if (!images.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = images.map((url, i) => `
    <figure class="ge-shot" data-url="${url}">
      <img src="${url}" alt="Captured view ${i + 1}">
      <figcaption>
        <span class="ge-shot-name">View ${i + 1}</span>
        <button type="button" class="ge-x" data-act="remove" aria-label="Remove">&times;</button>
      </figcaption>
    </figure>`).join("");

  box.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      change(button.dataset.act, button.closest(".ge-shot").dataset.url);
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
    renderShots();
    note("Saved.");
  } catch (err) {
    note(err.message);
  }
}

/* A capture made on an earlier visit, so coming back does not look like
   nothing happened. */
(async function start() {
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`);
    const body = await res.json();
    images = body.images || [];
    renderShots();
    if (images.length) {
      note(`${images.length} view${images.length > 1 ? "s" : ""} captured so far.`);
    }
  } catch (err) { /* nothing saved yet is the normal case */ }
})();
