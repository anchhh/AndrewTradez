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
  staged: {},            // {url: {styleKey: imageUrl}} -- a room can hold every style at once
  allStyles: true,       // generate every style for every room, not just the chosen one
  startedAt: null,       // when the current run began, for the ETA
  roomState: {},         // {url: "queued"|"running"|"completed"|"failed"}
  roomError: {},         // {url: message}
  warnings: {},          // {url: {styleKey: "what the check still saw"}}
  job: null,             // the run in flight, if any
  polling: false,
  projectId: null,
};

/* Rooms worth staging: an empty living room sells, an empty bathroom does not
   and a floor plan cannot. Everything else is still offered, just unticked. */
const STAGEABLE = new Set([
  "living", "bedroom", "primary_bedroom", "dining", "office", "basement", "outdoor_space",
]);

const STYLES = STAGE_STYLES;

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

  // One photo per room worth staging -- not every photo of it. A listing with
  // six shots of the living room needs one staged, and the old default ticked
  // all six: 33 of 57 photos on a real lead, which is $2.64 rather than $0.40.
  //
  // That mattered less when a button started the run. Now that reaching step 3
  // starts it, the default selection is what gets *spent*, so it errs low --
  // adding the second angle of a room is one click, un-spending is not.
  const firstOfRoom = new Set();
  state.selected = new Set(
    state.photos
      .filter((p) => {
        if (!STAGEABLE.has(p.room) || firstOfRoom.has(p.room)) return false;
        firstOfRoom.add(p.room);
        return true;
      })
      .map((p) => p.url)
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

/* ---------- cost ---------- */

/* Shown wherever a number of rooms is shown. Since nothing is clicked to start
   a run, an estimate the user never saw before spending would be no estimate
   at all. The rate is fetched rather than hard-coded so switching models in
   atlascloud.json moves this too. */
let costPerImage = 0.08;
let stagingIsFree = false;

fetch("/studio/api/scenery/status")
  .then((r) => r.json())
  .then((d) => {
    if (!d) return;
    if (typeof d.cost_per_image === "number") costPerImage = d.cost_per_image;
    stagingIsFree = !!d.free;
    renderSummary();
    renderStepGates();
  })
  .catch(() => {});

/* "$0.00" reads as a bug, or as a price about to appear. On Gemini's free tier
   the honest word is free, so say it. */
function money(n) {
  if (stagingIsFree) return "free";
  return "$" + (n * costPerImage).toFixed(2);
}

/* ---------- the rooms being staged ---------- */

/* What the after side says before there is an after. Four states rather than
   one, because "queued" and "failed" are very different news. */
function pendingText(roomState, error) {
  if (roomState === "queued") return "Waiting to start…";
  if (roomState === "running") return "Staging this room…";
  if (roomState === "failed") return error || "This room failed.";
  return "Not staged yet";
}


/* Before and after in one frame, dragged rather than toggled -- for staging,
   the question is always "is that the same room", and a slider answers it in
   a way two images side by side do not. Until a room is generated the after
   side says so rather than showing the original twice. */
function roomCard(photo) {
  const variants = state.staged[photo.url] || {};
  // With every style generated, nothing was explicitly chosen -- so show the
  // first look that exists rather than an empty frame next to nine results.
  const styleKey =
    state.styles[photo.url] ||
    (STYLES.map((s) => s[0]).find((k) => variants[k]) || "");
  const staged = variants[styleKey] || null;
  const roomState = state.roomState[photo.url] || (staged ? "completed" : "idle");

  return stagedRoomPanel({
    beforeUrl: photo.url,
    label: photo.label,
    variants,
    activeStyle: styleKey,
    pending: pendingText(roomState, state.roomError[photo.url]),
    hint: "Choose style",
    // Emptying a room is checked afterwards; anything the check still saw is
    // said on the panel rather than left for you to spot in the photograph.
    warning: staged ? ((state.warnings[photo.url] || {})[styleKey] || "") : "",

    onStyle: (key) => {
      // Clicking the style already set clears it, so a room can be taken back
      // out without hunting for a "none" entry.
      if (state.styles[photo.url] === key) delete state.styles[photo.url];
      else state.styles[photo.url] = key;
      renderRooms();
      renderStyles();
      renderSummary();
    },

    onOpen: () => {
      const rooms = state.photos
        .filter((p) => state.selected.has(p.url))
        .map((p) => ({
          beforeUrl: p.url,
          label: p.label,
          variants: state.staged[p.url] || {},
        }));
      openStagedCompare({
        rooms,
        index: rooms.findIndex((r) => r.beforeUrl === photo.url),
        style: styleKey,
      });
    },

    onRetry: () => retryRoom(photo, styleKey),
  });
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
  renderRestageButton();
}

/* ---------- summary ---------- */

function renderSummary() {
  const text = el("scn-summary-text");
  const chosen = [...state.selected];
  const styled = chosen.filter((u) => state.styles[u]);
  const without = chosen.length - styled.length;

  if (!chosen.length) {
    text.textContent = "No rooms picked.";
  } else if (!styled.length) {
    text.textContent = "Pick a style to start.";
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
  }

  const everyCost = el("scn-all-styles-cost");
  if (everyCost) {
    const n = chosen.length * STYLES.length;
    everyCost.textContent = chosen.length
      ? (stagingIsFree ? `${n} images, free.` : `${n} images, about ${money(n)}.`)
      : "";
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
  // With every style selected there is nothing more to choose; with one, that
  // one has to be picked before Generate means anything.
  const chosen = [...state.selected];
  const needStyle = !state.allStyles && chosen.some((u) => !state.styles[u]);
  const images = state.allStyles ? n * STYLES.length : n;

  const go = el("scn-generate");
  if (go) {
    go.disabled = n === 0 || needStyle;
    go.textContent = n
      ? `Generate ${images} image${images === 1 ? "" : "s"}`
      : "Generate";
  }

  const note2 = el("step2-note");
  if (note2) {
    if (!n) {
      note2.textContent = "Tick at least one room to continue.";
    } else if (needStyle) {
      note2.textContent = "Pick a style above, or tick \u201cGenerate every style\u201d.";
    } else {
      note2.innerHTML =
        `${n} room${n === 1 ? "" : "s"} — ` +
        (stagingIsFree
          ? `<strong>free</strong>`
          : `about <strong>${money(images)}</strong>`);
    }
  }
}

function goToStep(step) {
  state.step = step;
  if (step === 3) {
    renderRooms();
    renderSummary();
  }

  document.querySelectorAll(".step-panel").forEach((panel) => {
    panel.classList.toggle("is-active", String(panel.dataset.panel) === String(step));
  });
  // "gen" is not a numbered step. While it runs, step 3 reads as current --
  // that is where you are heading, and the bar should not go blank meanwhile.
  const marker = step === "gen" ? 3 : step;
  document.querySelectorAll(".step").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("is-current", n === marker);
    li.classList.toggle("is-done", n < marker);
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
      // Not while generating: leaving would not stop the run, so the bar would
      // vanish while images were still being paid for and produced.
      if (state.step === "gen") return;
      if (n < state.step) goToStep(n);
    });
  });
}

/* ---------- generate ---------- */

/* Generation sits between choosing rooms and seeing them: press Generate on
   step 2, watch a bar, land on step 3 with the results. Step 3 is a results
   page rather than a control panel -- by the time you are there the work is
   done and switching styles is instant. */

/* Measured, not guessed: nine images finished in 24s at MAX_PARALLEL 4, so
   about 2.7s per image once the pipeline is full. It is only the opening
   estimate -- as soon as one image lands, real throughput replaces it. */
const SECONDS_PER_IMAGE = 2.7;

function roomsToStage() {
  // Whatever is missing, and only that. An image already generated is never
  // bought again, which is what makes returning to a listing free.
  const out = [];
  state.photos
    .filter((p) => state.selected.has(p.url))
    .forEach((p) => {
      const variants = state.staged[p.url] || {};
      const wanted = state.allStyles
        ? STYLES.map((s) => s[0])
        : [state.styles[p.url]].filter(Boolean);
      wanted.forEach((style) => {
        if (!variants[style]) out.push({ photo: p.url, label: p.label, style });
      });
    });
  return out;
}

/* Everything already staged, for doing it again. Same rooms, same styles --
   a restage is "another take", not a different order. */
function roomsToRestage() {
  const out = [];
  state.photos
    .filter((p) => state.selected.has(p.url))
    .forEach((p) => {
      Object.keys(state.staged[p.url] || {}).forEach((style) => {
        out.push({ photo: p.url, label: p.label, style });
      });
    });
  return out;
}

function renderRestageButton() {
  const btn = el("scn-restage");
  const note = el("scn-restage-note");
  if (!btn) return;

  const rooms = roomsToRestage();
  btn.hidden = rooms.length === 0;
  if (note) note.textContent = "";
  if (!rooms.length) return;

  btn.textContent = `Restage ${rooms.length} image${rooms.length === 1 ? "" : "s"}`;
  if (note) {
    note.textContent = stagingIsFree
      ? "Generates a fresh take of the same rooms and styles. Free, and the current set is kept."
      : `Generates a fresh take of the same rooms and styles — about ${money(rooms.length)}. The current set is kept.`;
  }
}

function renderRunStatus(kind, html) {
  const box = el("scn-status");
  if (box) box.innerHTML = '<div class="scn-run scn-run-' + kind + '">' + html + '</div>';
}

function fmtDuration(seconds) {
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? m + "m " + s + "s" : m + "m";
}

function setProgress(done, total, startedAt) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  el("scn-bar-fill").style.width = pct + "%";
  el("scn-bar").setAttribute("aria-valuenow", String(pct));
  el("scn-gen-count").textContent =
    done + " of " + total + " image" + (total === 1 ? "" : "s");

  const eta = el("scn-gen-eta");
  if (done >= total) {
    eta.textContent = "Finishing up...";
    return;
  }
  // Measured throughput beats any constant -- a slow provider day would
  // otherwise keep promising 24s. But not straight away: the first poll can
  // land two images 300ms after the start, which measures as an absurdly fast
  // rate and shows "1s left" on a two-minute job. Wait for a sample worth
  // trusting, and use the constant until then.
  const elapsed = (Date.now() - startedAt) / 1000;
  const trustworthy = done >= 2 && elapsed >= 5;
  const perImage = trustworthy ? elapsed / done : SECONDS_PER_IMAGE;
  eta.textContent = "about " + fmtDuration((total - done) * perImage) + " left";
}

function renderGenList(rooms) {
  const list = el("scn-gen-list");
  if (!list) return;
  // Grouped by room, not one line per image: ten rooms times nine styles is
  // ninety lines, which is a wall rather than progress.
  const byRoom = new Map();
  rooms.forEach((r) => {
    if (!byRoom.has(r.photo)) {
      byRoom.set(r.photo, { label: r.label, done: 0, total: 0, failed: 0 });
    }
    const g = byRoom.get(r.photo);
    g.total += 1;
    if (r.staged_url) g.done += 1;
    else if (r.status === "failed") g.failed += 1;
  });

  list.innerHTML = [...byRoom.values()].map((g) => {
    const complete = g.done + g.failed >= g.total;
    return '<li class="scn-gen-row ' + (complete ? "is-done" : "") + '">' +
      '<span class="scn-gen-room">' + escapeHtml(g.label || "Room") + "</span>" +
      '<span class="scn-gen-nums">' + g.done + "/" + g.total +
      (g.failed ? " · " + g.failed + " failed" : "") + "</span></li>";
  }).join("");
}

async function startGeneration({ restage = false } = {}) {
  if (state.polling) return;
  // A restage asks for images that already exist, so it must also tell the
  // server to skip reuse -- otherwise it would hand back the same pictures.
  const rooms = restage ? roomsToRestage() : roomsToStage();

  // Everything asked for already exists -- go straight to it rather than show
  // a bar that would finish before it rendered.
  if (!rooms.length) {
    goToStep(3);
    renderRunStatus("done", "<strong>Already staged.</strong> Nothing new to generate.");
    return;
  }

  state.polling = true;
  state.startedAt = Date.now();
  rooms.forEach((r) => {
    state.roomState[r.photo] = "queued";
    delete state.roomError[r.photo];
  });

  goToStep("gen");
  const roomCount = new Set(rooms.map((r) => r.photo)).size;
  el("scn-gen-title").textContent = restage ? "Restaging your rooms" : "Staging your rooms";
  el("scn-gen-sub").textContent =
    roomCount + " room" + (roomCount === 1 ? "" : "s") + ", " +
    rooms.length + " image" + (rooms.length === 1 ? "" : "s") + " to make" +
    (stagingIsFree ? " — free." : " — about " + money(rooms.length) + ".");
  setProgress(0, rooms.length, state.startedAt);
  renderGenList(rooms.map((r) => Object.assign({}, r, { status: "queued" })));

  let data;
  try {
    const res = await fetch("/studio/api/scenery/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rooms,
        force: restage,
        lead_id: state.leadId,
        address: state.address,
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  } catch (err) {
    state.polling = false;
    rooms.forEach((r) => { state.roomState[r.photo] = "idle"; });
    el("scn-gen-title").textContent = "That didn't start";
    el("scn-gen-sub").textContent = "";
    renderRunStatus("error",
      "<strong>Couldn't start staging.</strong> " + escapeHtml(err.message));
    return;
  }

  (data.reused || []).forEach((room) => {
    state.staged[room.photo] = state.staged[room.photo] || {};
    state.staged[room.photo][room.style] = room.staged_url;
    state.roomState[room.photo] = "completed";
  });

  if (!data.job) {
    state.polling = false;
    const n = (data.reused || []).length;
    finishRun({ status: "completed", done: n, total: n, rooms: data.reused || [],
                estimated_cost: 0, project_id: null });
    return;
  }

  state.job = data.job;
  pollJob(data.job.id);
}

async function pollJob(jobId) {
  let data;
  try {
    const res = await fetch("/studio/api/scenery/jobs/" + jobId);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  } catch (err) {
    state.polling = false;
    renderRunStatus("error",
      "<strong>Lost track of the run.</strong> " + escapeHtml(err.message));
    return;
  }

  const job = data.job;
  state.job = job;

  (job.rooms || []).forEach((room) => {
    state.roomState[room.photo] = room.status || "running";
    if (room.error) state.roomError[room.photo] = room.error;
    if (room.staged_url) {
      state.staged[room.photo] = state.staged[room.photo] || {};
      state.staged[room.photo][room.style] = room.staged_url;
      state.warnings[room.photo] = state.warnings[room.photo] || {};
      // Empty string clears a previous warning on a retry that succeeded.
      state.warnings[room.photo][room.style] = room.warning || "";
    }
  });

  if (state.step === "gen") {
    setProgress(job.done, job.total, state.startedAt);
    renderGenList(job.rooms || []);
  } else {
    renderRooms();
  }

  if (job.status === "queued" || job.status === "running") {
    setTimeout(() => pollJob(jobId), 2000);
    return;
  }

  state.polling = false;
  finishRun(job);
}

/* The end of a run, however it ended: fill the bar, move to the results, and
   say plainly what came back. */
function finishRun(job) {
  const fill = el("scn-bar-fill");
  if (fill) fill.style.width = "100%";

  if (job.status === "failed") {
    el("scn-gen-title").textContent = "Staging failed";
    el("scn-gen-sub").textContent = "";
    renderRunStatus("error",
      "<strong>Staging failed.</strong> " +
      escapeHtml(job.error || "No rooms came back."));
    return;
  }

  state.projectId = job.project_id || null;
  goToStep(3);

  const failed = (job.total || 0) - (job.done || 0);
  const took = state.startedAt
    ? fmtDuration((Date.now() - state.startedAt) / 1000) : null;
  const cost = stagingIsFree
    ? "free"
    : (job.estimated_cost != null ? "about $" + job.estimated_cost.toFixed(2) : null);

  renderRestageButton();

  const done = el("scn-done");
  if (done) {
    done.innerHTML =
      '<div class="scn-run scn-run-done"><strong>Complete.</strong> ' +
      job.done + " image" + (job.done === 1 ? "" : "s") +
      " staged and saved to your projects" + (took ? " in " + took : "") +
      (cost ? " · " + cost : "") + ". " +
      (failed ? '<span class="scn-run-warn">' + failed + " didn't come back.</span> " : "") +
      (state.projectId
        ? '<a class="scn-run-link" href="/studio/dashboard">See it in Projects</a>' : "") +
      "</div>";
  }
}

el("scn-generate").addEventListener("click", () => startGeneration());

el("scn-restage").addEventListener("click", () => startGeneration({ restage: true }));

el("scn-all-styles").addEventListener("change", (e) => {
  state.allStyles = e.target.checked;
  renderStyles();
  renderSummary();
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


/* ---------- retrying one room ----------

   A single room is fast enough that sending it through the full-page progress
   screen would throw away the results you are looking at and then bring them
   back. A popup keeps the page where it is, and shows the thing worth showing:
   which pass it is on and what it is still trying to remove. */

function retryPopup() {
  let box = el("scn-retry-modal");
  if (box) return box;

  box = document.createElement("div");
  box.id = "scn-retry-modal";
  box.className = "scn-modal hidden";
  box.innerHTML = `
    <div class="scn-modal-panel" role="dialog" aria-modal="true"
         aria-labelledby="scn-retry-title">
      <h3 id="scn-retry-title" class="scn-modal-title"></h3>
      <p class="scn-modal-sub"></p>
      <div class="scn-bar"><div class="scn-bar-fill"></div></div>
      <div class="scn-modal-meta">
        <span class="scn-modal-pass"></span>
        <span class="scn-modal-time"></span>
      </div>
      <p class="scn-modal-left"></p>
      <div class="scn-modal-actions">
        <button type="button" class="btn-secondary btn-tiny" data-close>Close</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  box.querySelector("[data-close]").addEventListener("click", () => {
    box.classList.add("hidden");
  });
  return box;
}

async function retryRoom(photo, styleKey) {
  if (state.polling) return;

  const box = retryPopup();
  const title = box.querySelector(".scn-modal-title");
  const sub = box.querySelector(".scn-modal-sub");
  const fill = box.querySelector(".scn-bar-fill");
  const passLine = box.querySelector(".scn-modal-pass");
  const timeLine = box.querySelector(".scn-modal-time");
  const leftLine = box.querySelector(".scn-modal-left");
  const closeBtn = box.querySelector("[data-close]");

  title.textContent = `Restaging ${photo.label}`;
  sub.textContent = "Emptying the room, then checking it and removing whatever is left.";
  leftLine.textContent = "";
  passLine.textContent = "Starting…";
  fill.style.width = "5%";
  closeBtn.textContent = "Close";
  box.classList.remove("hidden");

  const startedAt = Date.now();
  const ticker = setInterval(() => {
    timeLine.textContent = fmtDuration((Date.now() - startedAt) / 1000) + " elapsed";
  }, 250);

  const finish = (message, kind) => {
    clearInterval(ticker);
    fill.style.width = "100%";
    passLine.textContent = message;
    box.querySelector(".scn-modal-panel").classList.toggle("is-error", kind === "error");
  };

  let jobId;
  try {
    const res = await fetch("/studio/api/scenery/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // force, or reuse hands back the same doubtful image.
        force: true,
        lead_id: state.leadId,
        address: state.address,
        rooms: [{ photo: photo.url, label: photo.label, style: styleKey }],
      }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    jobId = out.job.id;
  } catch (err) {
    finish(err.message, "error");
    return;
  }

  state.polling = true;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1200));
    let job;
    try {
      const res = await fetch(`/studio/api/scenery/jobs/${jobId}`);
      job = (await res.json()).job;
      if (!res.ok || !job) throw new Error("lost track of the run");
    } catch (err) {
      state.polling = false;
      finish(err.message, "error");
      return;
    }

    const room = (job.rooms || [])[0] || {};
    if (room.pass) {
      // Each pass removes what the last one missed, so progress is the pass
      // number rather than anything finer-grained.
      passLine.textContent = `Pass ${room.pass} of ${room.of}`;
      fill.style.width = `${Math.round((room.pass / room.of) * 90)}%`;
      leftLine.textContent = room.leftovers
        ? `Still removing: ${room.leftovers}`
        : "Checking the room…";
    }

    if (job.status === "queued" || job.status === "running") continue;

    state.polling = false;
    (job.rooms || []).forEach((r) => {
      if (!r.staged_url) return;
      state.staged[r.photo] = state.staged[r.photo] || {};
      state.staged[r.photo][r.style] = r.staged_url;
      state.warnings[r.photo] = state.warnings[r.photo] || {};
      state.warnings[r.photo][r.style] = r.warning || "";
    });
    renderRooms();

    if (job.status === "failed") {
      finish(job.error || "That didn't work.", "error");
      return;
    }
    const left = (job.rooms || [])[0]?.warning;
    leftLine.textContent = left ? `Still in the room: ${left}` : "";
    finish(left ? "Done — but not completely empty." : "Done — the room is empty.",
           left ? "error" : "ok");
    closeBtn.textContent = "See it";
    return;
  }
}


/* ---------- past runs ----------

   Scenery was write-only from its own page: every visit started at step 1
   with an empty wizard, and the way back to work already done was the lead
   profile or the dashboard. Opening one here rebuilds the results view from
   what was saved -- the same panels the run ended on, because the images
   already exist and looking at them should cost nothing.

   Nothing here regenerates. What is offered is what was made. */

function pastWhen(project) {
  const seconds = project.created_at || project.updated_at;
  if (!seconds) return "";
  const then = new Date(seconds * 1000);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return days + " days ago";
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* A saved run, back into the shape the wizard works in. The scenes carry
   everything needed: the original is the room, and each style that was made
   for it becomes one of its variants. */
function openPastProject(project) {
  const scenes = (project.scenes || []).filter((s) => s.before && s.after);
  if (!scenes.length) return;

  state.leadId = project.lead_id ?? null;
  state.address = project.address || project.name || null;
  state.photos = [];
  state.selected = new Set();
  state.staged = {};
  state.styles = {};
  state.warnings = {};
  state.roomState = {};
  state.projectId = project.id;

  scenes.forEach((scene) => {
    if (!state.staged[scene.before]) {
      state.photos.push({
        url: scene.before,
        room: null,
        label: scene.label || "Room",
        order: state.photos.length,
      });
      state.selected.add(scene.before);
      state.staged[scene.before] = {};
      // The first style made for a room is what it opens on; the rest are a
      // click away on the panel.
      state.styles[scene.before] = scene.style;
    }
    state.staged[scene.before][scene.style] = scene.after;
    state.roomState[scene.before] = "completed";
  });

  const done = el("scn-done");
  if (done) {
    const n = scenes.length;
    done.innerHTML = `
      <div class="scn-run scn-run-done">
        <strong>${escapeHtml(state.address || "Saved run")}.</strong>
        ${n} image${n === 1 ? "" : "s"} staged ${escapeHtml(pastWhen(project))}.
        Nothing here is being regenerated.
      </div>`;
  }

  goToStep(3);
}

function renderPast(projects) {
  const box = el("scn-past");
  const list = el("scn-past-list");
  if (!box || !list) return;

  const runs = [...projects].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (!runs.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  list.innerHTML = runs.map((run, i) => {
    const scenes = (run.scenes || []).filter((s) => s.before && s.after);
    const rooms = new Set(scenes.map((s) => s.before)).size;
    return `
      <button type="button" class="scn-past-card" data-run="${i}">
        <span class="scn-past-shots">
          ${scenes.slice(0, 4).map((s) => `
            <img src="${escapeHtml(s.after)}" alt="" loading="lazy">`).join("")}
        </span>
        <span class="scn-past-meta">
          <span class="scn-past-name">${escapeHtml(run.address || run.name || "Staged rooms")}</span>
          <span class="scn-past-sub">
            ${rooms} room${rooms === 1 ? "" : "s"} · ${scenes.length} image${scenes.length === 1 ? "" : "s"}
            · ${escapeHtml(pastWhen(run))}
          </span>
        </span>
      </button>`;
  }).join("");

  list.querySelectorAll(".scn-past-card").forEach((card) => {
    card.addEventListener("click", () => openPastProject(runs[Number(card.dataset.run)]));
  });
}

const pastToggle = el("scn-past-toggle");
if (pastToggle) {
  pastToggle.addEventListener("click", () => {
    const list = el("scn-past-list");
    const hidden = list.hasAttribute("hidden");
    if (hidden) list.removeAttribute("hidden");
    else list.setAttribute("hidden", "");
    pastToggle.textContent = hidden ? "Hide" : "Show";
  });
}

fetch("/studio/api/projects")
  .then((r) => r.json())
  .then((projects) => renderPast((projects || []).filter((p) => p.kind === "scenery")))
  .catch(() => {});
