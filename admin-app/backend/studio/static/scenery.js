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
  step: 1,
  leadId: null,
  address: null,
  photos: [],            // [{url, room, label}]
  selected: new Set(),   // photo urls
  styles: {},            // {url: styleKey} -- each room can differ
  staged: {},            // {url: stagedImageUrl} once generated
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
  renderLoaded();
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

function toggleSelected(url) {
  if (state.selected.has(url)) state.selected.delete(url);
  else state.selected.add(url);
  syncTiles();
  renderSummary();
  renderCounts();
}

/* Repaint the ticks in place rather than rebuilding forty tiles -- selecting
   from the viewer has to be reflected behind it without the grid flickering. */
function syncTiles() {
  document.querySelectorAll("#scn-grid .thumb").forEach((tile) => {
    const on = state.selected.has(tile.dataset.url);
    tile.classList.toggle("is-excluded", !on);
    const box = tile.querySelector("input");
    if (box) box.checked = on;
  });
}

function photoTile(photo) {
  const on = state.selected.has(photo.url);
  const div = document.createElement("div");
  div.className = "thumb is-selectable" + (on ? "" : " is-excluded");
  div.dataset.url = photo.url;
  div.innerHTML = `
    <img src="${escapeHtml(photo.url)}" alt="" loading="lazy">
    <label class="thumb-use" title="Stage this room">
      <input type="checkbox" ${on ? "checked" : ""}>
    </label>
    <button type="button" class="thumb-zoom" title="View full screen">⤢</button>`;

  // The whole tile toggles it. The checkbox is left in place as the visual
  // state, and its own change event is not wired -- clicking it bubbles here.
  div.addEventListener("click", (e) => {
    if (e.target.closest(".thumb-zoom")) return;
    if (e.target.tagName === "INPUT") e.preventDefault();
    toggleSelected(photo.url);
  });

  div.querySelector(".thumb-zoom").addEventListener("click", (e) => {
    e.stopPropagation();
    const all = state.photos.map((p) => p.url);
    const rooms = {};
    state.photos.forEach((p) => { rooms[p.url] = { room: p.room, label: p.label, order: p.order }; });
    openLightbox(all, all.indexOf(photo.url), rooms, {
      isSelected: (url) => state.selected.has(url),
      toggle: (url) => toggleSelected(url),
      label: "room",
    });
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

/* The style grid sets every room at once. Individual rooms then override it
   from the dropdown on their own row, which is the usual shape of this: one
   look for the house, one or two rooms that want something else. */
function renderStyles() {
  const box = el("scn-styles");
  const chosen = [...state.selected].map((u) => state.styles[u]);
  const allSame = chosen.length && chosen.every((c) => c && c === chosen[0]) ? chosen[0] : null;

  box.innerHTML = STYLES.map(([key, name, desc]) => `
    <button type="button" class="scn-style ${allSame === key ? "is-active" : ""}" data-style="${key}"
            title="${escapeHtml(desc)}">
      <span class="scn-style-name">${escapeHtml(name)}</span>
    </button>`).join("");

  box.querySelectorAll(".scn-style").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selected.forEach((url) => { state.styles[url] = btn.dataset.style; });
      renderStyles();
      renderRooms();
      renderSummary();
    });
  });
}

/* ---------- the rooms being staged ---------- */

/* Before and after in one frame, dragged rather than toggled -- for staging,
   the question is always "is that the same room", and a slider answers it in
   a way two images side by side do not. Until a room is generated the after
   side says so rather than showing the original twice. */
function roomCard(photo) {
  const styleKey = state.styles[photo.url] || "";
  const staged = state.staged[photo.url];

  const card = document.createElement("div");
  card.className = "scn-room";
  card.innerHTML = `
    <div class="scn-compare ${staged ? "" : "is-pending"}">
      <img class="scn-before" src="${escapeHtml(photo.url)}" alt="Before">
      <div class="scn-after-wrap">
        ${staged
          ? `<img class="scn-after" src="${escapeHtml(staged)}" alt="After">`
          : `<div class="scn-after-pending">Not staged yet</div>`}
      </div>
      <input class="scn-slider" type="range" min="0" max="100" value="${staged ? 50 : 100}"
             aria-label="Compare before and after">
      <span class="scn-handle" aria-hidden="true"></span>
      <span class="scn-tag scn-tag-before">Before</span>
      <span class="scn-tag scn-tag-after">After</span>
    </div>
    <div class="scn-room-meta">
      <span class="scn-room-label">${escapeHtml(photo.label)}</span>
      <select class="scn-room-style" aria-label="Style for this room">
        <option value="">Choose a style…</option>
        ${STYLES.map(([k, n]) => `<option value="${k}" ${k === styleKey ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}
      </select>
    </div>`;

  const compare = card.querySelector(".scn-compare");
  const slider = card.querySelector(".scn-slider");
  const wrap = card.querySelector(".scn-after-wrap");
  const handle = card.querySelector(".scn-handle");
  const setSplit = (pct) => {
    // The after side is revealed from the right, so 100 means all before.
    wrap.style.clipPath = `inset(0 0 0 ${pct}%)`;
    handle.style.left = `${pct}%`;
    compare.classList.toggle("is-all-before", Number(pct) >= 99);
  };
  setSplit(slider.value);
  slider.addEventListener("input", () => setSplit(slider.value));

  card.querySelector(".scn-room-style").addEventListener("change", (e) => {
    state.styles[photo.url] = e.target.value || undefined;
    if (!e.target.value) delete state.styles[photo.url];
    renderStyles();
    renderSummary();
  });

  return card;
}

function renderRooms() {
  const box = el("scn-rooms");
  if (!box) return;
  const chosen = state.photos.filter((p) => state.selected.has(p.url));

  if (!chosen.length) {
    box.innerHTML = `<p class="empty-note">No rooms picked — go back a step and choose some.</p>`;
    return;
  }
  box.innerHTML = "";
  chosen.forEach((photo) => box.appendChild(roomCard(photo)));
}

/* ---------- summary ---------- */

function renderSummary() {
  const text = el("scn-summary-text");
  const go = el("scn-go");
  const chosen = [...state.selected];
  const styled = chosen.filter((u) => state.styles[u]);
  const without = chosen.length - styled.length;

  if (!chosen.length) {
    text.textContent = "No rooms picked.";
    go.disabled = true;
  } else if (!styled.length) {
    text.textContent = "Pick a style to finish.";
    go.disabled = true;
  } else {
    // Name the styles in play, so a mixed set is legible without reading
    // every dropdown.
    const counts = {};
    styled.forEach((u) => { counts[state.styles[u]] = (counts[state.styles[u]] || 0) + 1; });
    const parts = Object.entries(counts).map(([key, n]) => {
      const name = (STYLES.find((x) => x[0] === key) || [key, key])[1];
      return `<strong>${n}</strong> ${escapeHtml(name.toLowerCase())}`;
    });
    text.innerHTML =
      `${parts.join(", ")}` +
      (without ? ` — <strong>${without}</strong> still need${without === 1 ? "s" : ""} a style` : "") +
      `.`;
    // Every picked room needs a style; a room with none would silently be
    // skipped, which is worse than saying so.
    go.disabled = without > 0;
  }

  renderStepGates();
}

/* What arrived, in the order the rooms actually run -- so you can see the
   listing landed properly before moving on, without leaving step 1. */
function renderLoaded() {
  const box = el("scn-loaded");
  if (!box) return;
  if (!state.photos.length) {
    box.innerHTML = "";
    return;
  }

  const groups = groupedPhotos();
  box.innerHTML = `
    <div class="scn-loaded-head">
      <span class="scn-loaded-title">${state.photos.length} photo${state.photos.length === 1 ? "" : "s"} loaded</span>
      <span class="scn-loaded-note">${groups.length} room${groups.length === 1 ? "" : "s"}</span>
    </div>
    ${groups.map((g) => `
      <div class="scn-loaded-room">
        <span class="scn-loaded-label">${escapeHtml(g.label)} <span class="photo-room-count">${g.photos.length}</span></span>
        <div class="scn-loaded-strip">
          ${g.photos.map((p) => `<img src="${escapeHtml(p.url)}" alt="" loading="lazy" data-url="${escapeHtml(p.url)}">`).join("")}
        </div>
      </div>`).join("")}`;

  // Same viewer as everywhere else, without the selecting -- this step is
  // about confirming what arrived, not choosing.
  const all = state.photos.map((p) => p.url);
  const rooms = {};
  state.photos.forEach((p) => { rooms[p.url] = { room: p.room, label: p.label, order: p.order }; });
  box.querySelectorAll("img").forEach((img) => {
    img.addEventListener("click", () => openLightbox(all, all.indexOf(img.dataset.url), rooms));
  });
}

/* ---------- steps ----------
   Each step gates its own Next, so you cannot arrive at "choose a style" with
   no rooms picked and wonder why the button does nothing. */

function renderStepGates() {
  // Photos, not a lead: options 2 and 3 bring photos with no lead attached,
  // and those are just as stageable.
  const hasPhotos = state.photos.length > 0;
  const next1 = document.querySelector('.step-next[data-goto="2"]');
  if (next1) next1.disabled = !hasPhotos;
  const note1 = el("step1-note");
  if (note1) {
    note1.textContent = hasPhotos
      ? `${state.photos.length} photo${state.photos.length === 1 ? "" : "s"} ready`
      : "Pick a listing, paste a link, or upload photos to continue.";
  }

  const n = state.selected.size;
  const next2 = document.querySelector('.step-next[data-goto="3"]');
  if (next2) next2.disabled = n === 0;
  const note2 = el("step2-note");
  if (note2) {
    note2.textContent = n
      ? `${n} room${n === 1 ? "" : "s"} selected`
      : "Tick at least one room to continue.";
  }
}

function goToStep(step) {
  state.step = step;
  // Step 2's selection is only settled when you leave it, so build step 3's
  // list on arrival rather than trying to keep it in sync throughout.
  if (step === 3) {
    renderRooms();
    renderStyles();
    renderSummary();
  }

  document.querySelectorAll(".step-panel").forEach((panel) => {
    panel.classList.toggle("is-active", Number(panel.dataset.panel) === step);
  });
  document.querySelectorAll(".step").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("is-current", n === step);
    li.classList.toggle("is-done", n < step);
  });

  // A step change moves the content well down the page, so start at the top
  // of the new step rather than wherever the last one was scrolled to.
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initSteps() {
  document.querySelectorAll(".step-next, .step-back").forEach((btn) => {
    btn.addEventListener("click", () => goToStep(Number(btn.dataset.goto)));
  });
  // The progress bar is navigation too, but only backwards -- clicking ahead
  // would skip a gate.
  document.querySelectorAll(".step").forEach((li) => {
    li.addEventListener("click", () => {
      const n = Number(li.dataset.step);
      if (n < state.step) goToStep(n);
    });
  });
}

/* ---------- generate ---------- */

el("scn-go").addEventListener("click", () => {
  // Nothing generates yet: no image model is wired up, and saying so is
  // better than a button that silently does nothing.
  const n = state.selected.size;
  el("scn-status").innerHTML = `
    <div class="scn-notyet">
      <strong>Not wired up yet.</strong>
      Staging ${n} room${n === 1 ? "" : "s"} needs an image model connected — the same
      shape as the video generator, pointed at stills instead of clips. The
      before/after sliders above will fill in as rooms come back.
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
initSteps();
initLeadPicker({ onPick: applyPrefill });

/* Options 2 and 3, shared with Create Video. Photos arriving this way have no
   room labels -- nothing has sorted them -- so they land under "Unsorted" and
   stay unticked until you choose them. */
initListingSource({
  existingPhotos: () => state.photos.map((p) => p.url),
  onExtracted: (data) => {
    if (!state.address && (data.address || data.title)) {
      state.address = data.address || data.title;
      renderSummary();
    }
  },
  onPhotos: (urls) => {
    urls.forEach((url) => state.photos.push({ url, room: null, label: "Unsorted", order: 999 }));
    renderGrid();
    renderLoaded();
    renderSummary();
  },
});

// Arriving from a lead's profile with ?lead_id= skips the picker.
if (window.__PREFILL__) {
  applyPrefill(window.__PREFILL__);
  const open = el("lead-open");
  if (open) open.textContent = "Pick a different lead";
}
