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
let slots = window.__SLOTS__ || {};
const plan = window.__PLAN__ || [];

/* Every view captured for this property, each with the shot in the plan it
   answers. Labelling is a person's job: which side of a house an oblique
   view shows is obvious to look at and guesswork for anything else, and the
   enhancer reads these labels to decide what to send with what. */
function renderShots() {
  const box = el("ge-shots");
  if (!images.length) {
    box.innerHTML = "";
    return;
  }

  const options = plan.flatMap((group) =>
    group.shots.filter((shot) => !shot.listing).map((shot) =>
      ({ key: shot.key, label: `${group.label} — ${shot.label}` })));

  box.innerHTML = images.map((url, i) => `
    <figure class="ge-shot" data-url="${url}">
      <img src="${url}" alt="Captured view ${i + 1}">
      <figcaption>
        <select class="ge-slot" aria-label="Which shot is this?">
          <option value="">Unlabelled</option>
          ${options.map((o) => `<option value="${o.key}"${
            slots[url] === o.key ? " selected" : ""}>${o.label}</option>`).join("")}
        </select>
        <button type="button" class="ge-x" data-act="remove" aria-label="Remove">&times;</button>
      </figcaption>
    </figure>`).join("");

  box.querySelectorAll("button").forEach((button) =>
    button.addEventListener("click", () =>
      change(button.dataset.act, button.closest(".ge-shot").dataset.url)));

  box.querySelectorAll(".ge-slot").forEach((select) =>
    select.addEventListener("change", () =>
      change("slot", select.closest(".ge-shot").dataset.url, select.value)));
}

/* The checklist above reflects what is labelled, so it has to be redrawn
   when a label changes -- a plan that still says "missing" after you filled
   it is a plan nobody trusts. */
function renderPlan() {
  const filled = new Set(Object.values(slots));
  document.querySelectorAll(".ge-plan-shot").forEach((row) => {
    const slot = row.dataset.slot;
    if (!plan.some((g) => g.shots.some((s) => s.key === slot && !s.listing))) return;
    const done = filled.has(slot);
    row.classList.toggle("is-done", done);
    row.querySelector(".ge-tick").textContent = done ? "✓" : "";
  });
}

/* One endpoint for add, choose and remove, so the three cannot disagree
   about what the flight plan holds. */
async function change(action, url, slot) {
  note(action === "remove" ? "Removing…" : "Saving…");
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, image: url, slot }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that didn't save");
    images = body.images || [];
    slots = body.slots || {};
    renderShots();
    renderPlan();
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
    slots = body.slots || {};
    renderShots();
    renderPlan();
    if (images.length) {
      note(`${images.length} view${images.length > 1 ? "s" : ""} captured so far.`);
    }
  } catch (err) { /* nothing saved yet is the normal case */ }
})();
