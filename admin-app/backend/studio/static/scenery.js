/*
 * Scenery: virtual staging from photos already captured.
 *
 * Shares Create Video's starting point -- a lead arrives with its photos and
 * room labels -- but the output is a styled still of a room, so the page is
 * about choosing rooms and a look rather than assembling a project.
 *
 * The room labels earn their keep here: staging an exterior or a floor plan
 * is meaningless, so the default selection is the rooms people actually pay
 * to have furnished, and the rest arrive unticked.
 */
const el = (id) => document.getElementById(id);

const state = {
  leadId: null,
  address: null,
  photos: [],            // [{url, room, label}]
  selected: new Set(),   // photo urls
  style: null,
};

/* Rooms worth staging: an empty living room sells, an empty bathroom does not
   and a floor plan cannot. Everything else is still offered, just unticked. */
const STAGEABLE = new Set([
  "living", "bedroom", "primary_bedroom", "dining", "office", "basement", "outdoor_space",
]);

const STYLES = [
  ["modern", "Modern", "Clean lines, neutral palette, low profile furniture"],
  ["scandinavian", "Scandinavian", "Pale wood, white walls, soft textiles"],
  ["farmhouse", "Farmhouse", "Warm timber, shaker forms, muted greens"],
  ["midcentury", "Mid-century", "Walnut, tapered legs, muted oranges and teals"],
  ["coastal", "Coastal", "Light linen, rattan, blue and sand"],
  ["traditional", "Traditional", "Classic upholstery, warm woods, symmetry"],
  ["minimal", "Minimal", "Very little furniture, lots of floor showing"],
  ["luxury", "Luxury", "Statement pieces, rich materials, layered lighting"],
];

/* ---------- lead ---------- */

async function applyPrefill(prefill) {
  state.leadId = prefill.lead_id ?? null;
  state.address = prefill.address || prefill.name || null;

  const rooms = prefill.photo_rooms || {};
  state.photos = (prefill.photos || []).map((url) => {
    const entry = rooms[url];
    return {
      url,
      room: entry ? entry.room : null,
      label: entry ? entry.label : "Unsorted",
      order: entry && entry.order != null ? entry.order : 999,
    };
  });

  // Default to the rooms worth staging. A first-time user gets a sensible
  // selection rather than an empty one or forty ticked boxes.
  state.selected = new Set(
    state.photos.filter((p) => STAGEABLE.has(p.room)).map((p) => p.url)
  );

  renderGrid();
  renderSummary();
}

/* ---------- photos ---------- */

function groupedPhotos() {
  const buckets = new Map();
  state.photos.forEach((photo) => {
    const key = photo.room || "unsorted";
    if (!buckets.has(key)) {
      buckets.set(key, { key, label: photo.label, order: photo.order, photos: [] });
    }
    buckets.get(key).photos.push(photo);
  });
  return [...buckets.values()].sort((a, b) => a.order - b.order);
}

function photoTile(photo) {
  const on = state.selected.has(photo.url);
  const div = document.createElement("div");
  div.className = "thumb" + (on ? "" : " is-excluded");
  div.innerHTML = `
    <img src="${escapeHtml(photo.url)}" alt="" loading="lazy">
    <label class="thumb-use" title="Stage this room">
      <input type="checkbox" ${on ? "checked" : ""}>
    </label>`;
  div.querySelector("input").addEventListener("change", (e) => {
    if (e.target.checked) state.selected.add(photo.url);
    else state.selected.delete(photo.url);
    div.classList.toggle("is-excluded", !e.target.checked);
    renderSummary();
    renderCounts();
  });
  return div;
}

function renderGrid() {
  const grid = el("scn-grid");
  const empty = el("scn-empty");
  grid.innerHTML = "";

  if (!state.photos.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.classList.add("is-grouped");

  groupedPhotos().forEach((group) => {
    const on = group.photos.filter((p) => state.selected.has(p.url)).length;
    const section = document.createElement("section");
    section.className = "photo-room" + (STAGEABLE.has(group.key) ? "" : " is-secondary");
    section.dataset.room = group.key;
    section.innerHTML = `
      <div class="photo-room-head">
        <span class="photo-room-label">${escapeHtml(group.label)}</span>
        <span class="photo-room-count">${on}/${group.photos.length}</span>
        <button type="button" class="btn-tiny photo-room-toggle">
          ${on === group.photos.length ? "None" : "All"}
        </button>
      </div>`;

    const sub = document.createElement("div");
    sub.className = "photo-room-grid";
    group.photos.forEach((p) => sub.appendChild(photoTile(p)));
    section.appendChild(sub);

    section.querySelector(".photo-room-toggle").addEventListener("click", () => {
      const turnOn = on !== group.photos.length;
      group.photos.forEach((p) => {
        if (turnOn) state.selected.add(p.url);
        else state.selected.delete(p.url);
      });
      renderGrid();
      renderSummary();
    });

    grid.appendChild(section);
  });

  renderCounts();
}

/* Counts only, so ticking a box doesn't rebuild forty tiles under the cursor. */
function renderCounts() {
  document.querySelectorAll(".photo-room").forEach((section) => {
    const group = groupedPhotos().find((g) => g.key === section.dataset.room);
    if (!group) return;
    const on = group.photos.filter((p) => state.selected.has(p.url)).length;
    section.querySelector(".photo-room-count").textContent = `${on}/${group.photos.length}`;
    section.querySelector(".photo-room-toggle").textContent =
      on === group.photos.length ? "None" : "All";
  });

  el("scn-count").textContent = state.photos.length
    ? `${state.selected.size} of ${state.photos.length} photos selected`
    : "No listing picked yet.";
}

/* ---------- style ---------- */

function renderStyles() {
  const box = el("scn-styles");
  box.innerHTML = STYLES.map(([key, name, desc]) => `
    <button type="button" class="scn-style ${state.style === key ? "is-active" : ""}" data-style="${key}">
      <span class="scn-style-name">${escapeHtml(name)}</span>
      <span class="scn-style-desc">${escapeHtml(desc)}</span>
    </button>`).join("");

  box.querySelectorAll(".scn-style").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.style = state.style === btn.dataset.style ? null : btn.dataset.style;
      renderStyles();
      renderSummary();
    });
  });
}

/* ---------- summary ---------- */

function renderSummary() {
  const text = el("scn-summary-text");
  const go = el("scn-go");
  const n = state.selected.size;
  const style = STYLES.find((s) => s[0] === state.style);

  const missing = [];
  if (!state.leadId) missing.push("a listing");
  if (!n) missing.push("at least one room");
  if (!style) missing.push("a style");

  if (missing.length) {
    text.textContent = `Pick ${missing.join(", ")}.`;
    go.disabled = true;
    return;
  }

  text.innerHTML =
    `<strong>${n} room${n === 1 ? "" : "s"}</strong> from ${escapeHtml(state.address || "this listing")}, ` +
    `staged <strong>${escapeHtml(style[1].toLowerCase())}</strong>.`;
  go.disabled = false;
}

/* ---------- generate ---------- */

el("scn-go").addEventListener("click", () => {
  // Nothing generates yet: no image model is wired up, and saying so is
  // better than a button that silently does nothing.
  el("scn-status").innerHTML = `
    <div class="scn-notyet">
      <strong>Not wired up yet.</strong>
      Staging ${state.selected.size} room${state.selected.size === 1 ? "" : "s"} in
      ${escapeHtml((STYLES.find((s) => s[0] === state.style) || ["", "that style"])[1])}
      needs an image model connected — the same shape as the video generator,
      pointed at stills instead of clips.
    </div>`;
});

el("scn-clear").addEventListener("click", () => {
  state.selected.clear();
  renderGrid();
  renderSummary();
});

/* ---------- init ---------- */

renderStyles();
renderSummary();
initLeadPicker({ onPick: applyPrefill });

// Arriving from a lead's profile with ?lead_id= skips the picker.
if (window.__PREFILL__) {
  applyPrefill(window.__PREFILL__);
  const open = el("lead-open");
  if (open) open.textContent = "Pick a different lead";
}
