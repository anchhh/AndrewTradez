/* The Google Earth stage: open Earth at this address, come back with the
   views the enhancer needs.

   The capture cannot happen in the page. Earth refuses to be framed
   (X-Frame-Options: SAMEORIGIN) and a cross-origin frame cannot be
   screenshotted anyway, so the screenshot is taken outside -- by the
   extension, which is the only thing here that can read another tab -- and
   sent straight to this listing. This page says which views to go and get,
   and is where each one is put in its place.

   A box per shot, because a single oblique view leaves the enhancer guessing
   at the half of the plot it cannot see. Filling a box is a drag: from the
   unplaced strip below, or straight off the desktop. Which side of a house
   an oblique view shows is obvious to a person looking at it and guesswork
   for anything else, which is why this is a person's job and not a
   heuristic. */

const lead = window.__LEAD__;
const plan = window.__PLAN__ || [];
const haveListing = window.__HAVE_LISTING__ || {};

let images = [];
let slots = window.__SLOTS__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { el("ge-note").textContent = text || ""; };

const DRAG_TYPE = "application/x-estly-capture";

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function placedIn(slot) {
  return Object.keys(slots).find((url) => slots[url] === slot) || null;
}

/* ---------- the plan ---------- */

function renderPlan() {
  el("ge-plan").innerHTML = plan.map((group) => `
    <section class="ge-plan-group">
      <h3>${escapeHtml(group.label)}</h3>
      <p class="hint">${escapeHtml(group.note)}</p>
      <div class="ge-boxes">
        ${group.shots.map((shot) => shot.listing
          ? listingRow(shot)
          : dropBox(shot)).join("")}
      </div>
    </section>`).join("");

  el("ge-plan").querySelectorAll(".ge-box").forEach(wireBox);
}

/* A row rather than a box: this one is answered by the listing's own photos,
   which are already on the lead. Nothing to drop, only something to know. */
function listingRow(shot) {
  const done = haveListing[shot.listing];
  return `
    <div class="ge-box is-listing${done ? " is-filled" : ""}">
      <span class="ge-box-label">${escapeHtml(shot.label)}</span>
      <span class="ge-box-hint">${escapeHtml(shot.hint)} &mdash; ${
        done ? "on the listing" : "none on this listing yet"}</span>
    </div>`;
}

function dropBox(shot) {
  const url = placedIn(shot.key);
  return `
    <div class="ge-box${url ? " is-filled" : ""}" data-slot="${shot.key}">
      ${url
        ? `<img src="${url}" alt="${escapeHtml(shot.label)}">
           <button type="button" class="ge-box-x" data-act="clear"
                   aria-label="Take out">&times;</button>`
        : ""}
      <span class="ge-box-label">${escapeHtml(shot.label)}</span>
      <span class="ge-box-hint">${escapeHtml(shot.hint)}</span>
    </div>`;
}

function wireBox(box) {
  const slot = box.dataset.slot;
  if (!slot) return;

  const clear = box.querySelector('[data-act="clear"]');
  if (clear) {
    clear.addEventListener("click", () => {
      const url = placedIn(slot);
      if (url) place(url, "");
    });
  }

  ["dragenter", "dragover"].forEach((name) =>
    box.addEventListener(name, (e) => {
      e.preventDefault();
      // Without this the browser's default is "no drop" and the cursor says
      // so, which reads as the box refusing the image.
      e.dataTransfer.dropEffect = "copy";
      box.classList.add("is-over");
    }));
  ["dragleave", "drop"].forEach((name) =>
    box.addEventListener(name, () => box.classList.remove("is-over")));

  box.addEventListener("drop", async (e) => {
    e.preventDefault();

    // Two kinds of drop. One is a capture already on this listing being
    // moved into place; the other is an image file off the desktop, which
    // has to be uploaded and added before it can be placed.
    const existing = e.dataTransfer.getData(DRAG_TYPE);
    if (existing) {
      place(existing, slot);
      return;
    }

    const file = (e.dataTransfer.files || [])[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      note("That isn't an image.");
      return;
    }
    note("Adding…");
    try {
      const url = await upload(file);
      await change("add", url);
      await place(url, slot);
    } catch (err) {
      note(err.message);
    }
  });
}

/* ---------- the unplaced strip ---------- */

function renderShots() {
  const spare = images.filter((url) => !slots[url]);
  el("ge-shots").innerHTML = spare.map((url, i) => `
    <figure class="ge-shot" data-url="${url}" draggable="true">
      <img src="${url}" alt="Unplaced capture ${i + 1}">
      <figcaption>
        <span class="ge-shot-name">Drag into a box</span>
        <button type="button" class="ge-x" data-act="remove" aria-label="Remove">&times;</button>
      </figcaption>
    </figure>`).join("");

  el("ge-shots").querySelectorAll(".ge-shot").forEach((figure) => {
    const url = figure.dataset.url;
    figure.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(DRAG_TYPE, url);
      e.dataTransfer.effectAllowed = "copy";
      figure.classList.add("is-dragging");
    });
    figure.addEventListener("dragend", () => figure.classList.remove("is-dragging"));
    figure.querySelector("button").addEventListener("click", () => change("remove", url));
  });

  el("ge-empty").hidden = spare.length > 0 || !images.length;
}

/* ---------- talking to the server ---------- */

/* One endpoint for adding, placing and removing, so the three cannot
   disagree about what the flight plan holds. */
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
    renderPlan();
    renderShots();
    note("");
  } catch (err) {
    note(err.message);
  }
}

const place = (url, slot) => change("slot", url, slot);

async function upload(file) {
  // The field is "photos" and the reply is {photos: [...]} -- the same
  // endpoint the listing uploader uses, so a dropped image lands beside the
  // listing photos instead of in a second place with its own rules.
  const form = new FormData();
  form.append("photos", file);
  const res = await fetch("/studio/api/upload", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "that image couldn't be saved");
  const url = (body.photos || [])[0];
  // Uploads are de-duplicated by image hash, so the same file twice comes
  // back with nothing rather than an error.
  if (!url) throw new Error("that image is already on this listing");
  return url;
}

/* ---------- start ---------- */

(async function start() {
  renderPlan();
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`);
    const body = await res.json();
    images = body.images || [];
    slots = body.slots || {};
    renderPlan();
    renderShots();
  } catch (err) { /* nothing captured yet is the normal case */ }
})();
