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
const listingPhotos = window.__LISTING__ || [];
const rooms = window.__ROOMS__ || {};

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
  return Object.keys(slots).filter((url) => slots[url] === slot);
}

/* ---------- full size ---------- */

/* Every thumbnail here is too small to tell one oblique view from another,
   and telling them apart is the whole judgement this stage asks for. So
   anything showing an image can open it. */
function zoom(url) {
  el("ge-lightbox-img").src = url;
  el("ge-lightbox").hidden = false;
}

function closeZoom() {
  el("ge-lightbox").hidden = true;
  el("ge-lightbox-img").removeAttribute("src");
}

el("ge-lightbox-x").addEventListener("click", closeZoom);
el("ge-lightbox").addEventListener("click", (e) => {
  // Clicking the backdrop closes; clicking the picture itself does not, so
  // a mis-aimed click while looking at it is not a dismissal.
  if (e.target.id !== "ge-lightbox-img") closeZoom();
});

/* A magnifier corner for anything that already does something else when
   clicked -- a chip in a box, a tile in either strip, a tile in the picker.

   A span rather than a button, deliberately. The picker's tiles ARE buttons,
   and a button inside a button is invalid HTML: the parser closes the outer
   one when it meets the inner, which put every tile's label outside its own
   frame and made the picker look broken. role and tabindex give it the
   behaviour a button would have had. */
function zoomButton(url) {
  return `<span class="ge-zoom" role="button" tabindex="0" data-act="zoom"
                data-url="${url}" title="See it full size"
                aria-label="See it full size">&#10530;</span>`;
}

function wireZoom(root) {
  root.querySelectorAll('[data-act="zoom"]').forEach((control) => {
    const open = (e) => {
      e.stopPropagation();
      e.preventDefault();
      zoom(control.dataset.url);
    };
    control.addEventListener("click", open);
    control.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") open(e);
    });
  });
}

/* ---------- the plan ---------- */

function renderPlan() {
  el("ge-plan").innerHTML = plan.map((group) => `
    <section class="ge-plan-group">
      <h3>${escapeHtml(group.label)}</h3>
      <p class="hint">${escapeHtml(group.note)}</p>
      <div class="ge-boxes">
        ${group.shots.map(dropBox).join("")}
      </div>
    </section>`).join("");

  el("ge-plan").querySelectorAll(".ge-box").forEach(wireBox);
  wireZoom(el("ge-plan"));
}

function dropBox(shot) {
  const urls = placedIn(shot.key);
  const listing = shot.source === "listing";

  // A box that holds several shows them as a strip and keeps its drop area,
  // because there is always room for one more answer to "what does the front
  // of this house look like". A box that holds one becomes the picture.
  if (shot.multi) {
    return `
      <div class="ge-box is-multi${listing ? " is-listing" : ""}${
        urls.length ? " is-filled" : ""}" data-slot="${shot.key}">
        <span class="ge-box-label">${escapeHtml(shot.label)}${
          urls.length ? ` <span class="ge-box-count">${urls.length}</span>` : ""}</span>
        <span class="ge-box-hint">${escapeHtml(shot.hint)}</span>
        ${urls.length ? `<div class="ge-box-strip">${urls.map((url) => `
          <span class="ge-box-chip">
            <img src="${url}" alt="">
            ${zoomButton(url)}
            <button type="button" class="ge-box-x" data-act="clear"
                    data-url="${url}" aria-label="Take out">&times;</button>
          </span>`).join("")}</div>` : ""}
      </div>`;
  }

  const url = urls[0];
  return `
    <div class="ge-box${url ? " is-filled" : ""}${
      listing ? " is-listing" : ""}" data-slot="${shot.key}">
      ${url
        ? `<img src="${url}" alt="${escapeHtml(shot.label)}">
           <button type="button" class="ge-box-x" data-act="clear"
                   data-url="${url}" aria-label="Take out">&times;</button>`
        : ""}
      <span class="ge-box-label">${escapeHtml(shot.label)}</span>
      <span class="ge-box-hint">${escapeHtml(shot.hint)}</span>
    </div>`;
}

function wireBox(box) {
  const slot = box.dataset.slot;
  if (!slot) return;

  box.querySelectorAll('[data-act="clear"]').forEach((button) =>
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      place(button.dataset.url, "");
    }));

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

  // Clicking the box opens a picker. Dragging still works and is quicker
  // when the image is already beside the box; it stops being quicker the
  // moment the image is a scroll away, which on a thirty-photo listing is
  // most of them.
  box.addEventListener("click", (e) => {
    if (e.target.closest("[data-act]")) return;
    openPicker(slot);
  });

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

function roomLabel(url) {
  const entry = rooms[url];
  const label = entry && typeof entry === "object" ? entry.label : entry;
  return label || "Photo";
}

/* The listing's photographs, as drag sources. Placing one never takes it out
   of this strip: a photo can be the reference for a box and still be a photo
   of the house. */
function renderListing() {
  const used = new Set(Object.keys(slots));
  el("ge-listing").innerHTML = listingPhotos.map((url) => `
    <figure class="ge-shot${used.has(url) ? " is-used" : ""}"
            data-url="${url}" draggable="true">
      <img src="${url}" alt="">
      ${zoomButton(url)}
      <figcaption>
        <span class="ge-shot-name">${escapeHtml(roomLabel(url))}</span>
      </figcaption>
    </figure>`).join("");

  el("ge-listing").querySelectorAll(".ge-shot").forEach((figure) => {
    figure.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(DRAG_TYPE, figure.dataset.url);
      e.dataTransfer.effectAllowed = "copy";
      figure.classList.add("is-dragging");
    });
    figure.addEventListener("dragend", () => figure.classList.remove("is-dragging"));
  });
  wireZoom(el("ge-listing"));
}

function renderShots() {
  const spare = images.filter((url) => !slots[url]);
  el("ge-shots").innerHTML = spare.map((url, i) => `
    <figure class="ge-shot" data-url="${url}" draggable="true">
      <img src="${url}" alt="Unplaced capture ${i + 1}">
      ${zoomButton(url)}
      <figcaption>
        <span class="ge-shot-name">Drag into a box</span>
        <button type="button" class="ge-x" data-act="remove"
                aria-label="Remove">&times;</button>
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
    figure.querySelector('[data-act="remove"]')
      .addEventListener("click", () => change("remove", url));
  });
  wireZoom(el("ge-shots"));

  el("ge-empty").hidden = spare.length > 0 || !images.length;
}

/* ---------- filling a box by clicking it ---------- */

let pickSlot = null;
let picked = new Set();

function shotFor(slot) {
  for (const group of plan) {
    const shot = group.shots.find((s) => s.key === slot);
    if (shot) return { group, shot };
  }
  return null;
}

function openPicker(slot) {
  const found = shotFor(slot);
  if (!found) return;
  pickSlot = slot;
  picked = new Set(placedIn(slot));

  el("ge-picker-title").textContent = `${found.group.label} — ${found.shot.label}`;
  el("ge-picker-hint").textContent = found.shot.hint;
  renderPicker();
  el("ge-picker").hidden = false;
}

/* What can go in this box. A reference box offers the listing's photographs;
   every other box offers the captures, including ones already placed
   elsewhere -- moving a view from one box to another is a legitimate thing
   to want, and it says where it currently is rather than hiding it. */
function pickerSource() {
  const found = shotFor(pickSlot);
  return found && found.shot.source === "listing" ? listingPhotos : images;
}

function renderPicker() {
  const found = shotFor(pickSlot);
  const multi = !!(found && found.shot.multi);

  el("ge-picker-grid").innerHTML = pickerSource().map((url) => {
    const elsewhere = slots[url] && slots[url] !== pickSlot;
    return `
      <button type="button" class="en-pick-item${picked.has(url) ? " is-on" : ""}"
              data-url="${url}">
        <img src="${url}" alt="">
        ${zoomButton(url)}
        <span title="${escapeHtml(elsewhere ? `In ${shotName(slots[url])}` : "")}">${
          escapeHtml(elsewhere ? shotName(slots[url]) : (
            found.shot.source === "listing" ? roomLabel(url) : "Not placed"))}</span>
      </button>`;
  }).join("");

  el("ge-picker-grid").querySelectorAll(".en-pick-item").forEach((button) =>
    button.addEventListener("click", () => {
      const url = button.dataset.url;
      if (picked.has(url)) picked.delete(url);
      else {
        // A box that holds one is a choice, not a list.
        if (!multi) picked.clear();
        picked.add(url);
      }
      renderPicker();
    }));
  wireZoom(el("ge-picker-grid"));

  el("ge-picker-count").textContent = multi
    ? `${picked.size} selected`
    : (picked.size ? "1 selected" : "none selected");
}

/* Short enough to fit a tile: "Front · 3D" rather than "Front — Satellite
   3D". The full name is on the tile's title attribute for anyone who wants
   it. */
const SHORT = {
  "Street views": "Street", "Satellite overhead": "Overhead",
  "Satellite 3D": "3D", "Reference photos": "Reference",
};

function shotName(slot) {
  const found = shotFor(slot);
  if (!found) return slot;
  return `${found.group.label} · ${SHORT[found.shot.label] || found.shot.label}`;
}

el("ge-picker-cancel").addEventListener("click", () => { el("ge-picker").hidden = true; });
el("ge-picker-done").addEventListener("click", async () => {
  const slot = pickSlot;
  const before = new Set(placedIn(slot));
  el("ge-picker").hidden = true;

  // Only the difference is sent. Re-placing what is already there would be
  // a round trip per image for no change, and on a single-image slot it
  // would evict and re-add the same picture.
  for (const url of before) {
    if (!picked.has(url)) await place(url, "");
  }
  for (const url of picked) {
    if (!before.has(url)) await place(url, slot);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Innermost first: the lightbox opens on top of the picker.
  if (!el("ge-lightbox").hidden) closeZoom();
  else if (!el("ge-picker").hidden) el("ge-picker").hidden = true;
});

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
    renderListing();
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
  renderListing();
  try {
    const res = await fetch(`/studio/api/leads/${lead}/drone-path`);
    const body = await res.json();
    images = body.images || [];
    slots = body.slots || {};
    renderPlan();
    renderShots();
    renderListing();
  } catch (err) { /* nothing captured yet is the normal case */ }
})();
