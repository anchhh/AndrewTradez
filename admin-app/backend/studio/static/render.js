/*
 * Render: the step Create Video never had.
 *
 * Photos and a style were being gathered and saved as a draft, and the chain
 * stopped there -- the style page said so out loud. This is the arrow that was
 * missing: chosen photos in, one clip per photo out.
 *
 * The shape deliberately matches Scenery's generating stage, because it is the
 * same job and the user already knows that flow. What differs is money: there
 * is no free provider for video, so the cost is stated on the button and the
 * run only ever starts from an explicit click.
 */
const project = window.__PROJECT__ || {};
const el = (id) => document.getElementById(id);

// A listing video is a handful of clips, not a clip of every photo. Forty
// photos at five seconds is $26.80, and defaulting to that would put a
// four-figure mistake one click away on a busy pipeline. Scenery learned the
// same lesson: the default selection is what gets SPENT, so it errs low and
// adding more is a click.
const DEFAULT_CLIPS = 6;

const state = {
  style: null,       // the style card, which is a preset for the moves
  available: [],     // every still in the project
  photos: [],        // the ones ticked, one clip each
  reopened: false,   // opened from the renders picker rather than just rendered
  photosOpen: false, // the room grid, collapsed until you want to change it
  moves: {},         // {url: moveKey} -- the camera move for that clip
  seconds: {},       // {url: length}      -- and how long it runs
  quality: {},       // {url: resolution}  -- and at what size
  moveList: [],      // [{key, name, desc}] from the server
  durationList: [],
  resolutionList: [],
  defaultMove: "push_in",
  defaultDuration: 5,
  defaultResolution: "1080p",
  ratePerSecond: null,
  rates: {},         // {resolution: $/second} -- a 4x swing, not a detail
  modelLabel: "",    // which model is actually behind this
  advice: {},        // {url: {recommended, moves:{move:{level,reason}}}}
  advising: false,
  exteriorMoves: [], // drone moves, offered only on exterior photos
  exteriorRooms: [], // which room labels count as outside
  site: null,        // what the property looks like from the outside
  siteVerdicts: {},  // {url: {level, reason, anchor}} for the chosen move
  siting: false,
  configured: false,
  job: null,
  startedAt: null,
  polling: false,
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function isVideo(url) {
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url || "");
}

function fmtDuration(seconds) {
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + "s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? m + "m " + s + "s" : m + "m";
}

function show(id, on) {
  const node = el(id);
  if (node) node.classList.toggle("hidden", !on);
}

/* The progress bar, same three steps as Scenery. Rendering is not a step of
   its own -- it is what happens between choosing and looking, and numbering it
   would imply there is something to do there. */
function markStep(n) {
  document.querySelectorAll("#steps .step").forEach((li) => {
    const at = Number(li.dataset.step);
    li.classList.toggle("is-current", at === n);
    li.classList.toggle("is-done", at < n);
  });
}

/* ---------- what we are rendering ----------

   Grouped and labelled exactly as Scenery groups its rooms, and for a reason
   beyond consistency: the room labels carry a walkthrough order, and clips are
   stitched in sequence. Sorting by it means the default tour runs the way
   somebody would actually walk the house -- approach, living, kitchen,
   bedrooms -- rather than the order the photos happened to be scraped in. */

function roomOf(url) {
  return (project.photo_rooms || {})[url] || {};
}

function groupedPhotos() {
  const buckets = new Map();
  state.available.forEach((url) => {
    const info = roomOf(url);
    const key = info.room || "unsorted";
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        label: info.label || "Unsorted",
        // Unsorted last: it is the pile nothing could be said about.
        order: info.order != null ? info.order : 999,
        photos: [],
      });
    }
    buckets.get(key).photos.push(url);
  });
  return [...buckets.values()].sort((a, b) => a.order - b.order);
}

/* The order clips are rendered and stitched in: walkthrough order, not the
   order photos arrived. */
function walkthroughOrder() {
  return groupedPhotos().flatMap((group) => group.photos);
}

function selectPhoto(url, on) {
  const ordered = walkthroughOrder();
  const chosen = new Set(state.photos);
  if (on) chosen.add(url);
  else chosen.delete(url);
  state.photos = ordered.filter((u) => chosen.has(u));
  if (on && !state.moves[url]) state.moves[url] = state.defaultMove;
}

function photoTile(url) {
  const on = state.photos.includes(url);
  const at = state.photos.indexOf(url);
  const div = document.createElement("div");
  div.className = "thumb is-selectable" + (on ? "" : " is-excluded");
  div.dataset.url = url;
  div.innerHTML = `
    <img src="${escapeHtml(url)}" alt="" loading="lazy">
    <label class="thumb-use" title="Make a clip from this photo">
      <input type="checkbox" ${on ? "checked" : ""}>
    </label>
    <button type="button" class="thumb-zoom" title="View full screen">⤢</button>
    ${on ? `<span class="rn-thumb-n">${at + 1}</span>` : ""}`;

  // Full screen, picking as you go -- the same viewer Scenery uses, so a
  // decision that needs a proper look at the photo does not need a 116px
  // thumbnail to be made from.
  div.querySelector(".thumb-zoom").addEventListener("click", (e) => {
    e.stopPropagation();
    const all = walkthroughOrder();
    const rooms = {};
    all.forEach((u) => {
      const info = roomOf(u);
      rooms[u] = { room: info.room, label: info.label, order: info.order };
    });
    openLightbox(all, all.indexOf(url), rooms, {
      isSelected: (u) => state.photos.includes(u),
      toggle: (u) => {
        selectPhoto(u, !state.photos.includes(u));
        state.photosOpen = true;
        renderPhotos();
        renderClipMoves();
        renderCost();
      },
      label: "clip",
    });
  });

  div.addEventListener("click", (e) => {
    if (e.target.closest(".thumb-zoom")) return;
    if (e.target.tagName === "INPUT") e.preventDefault();
    selectPhoto(url, !state.photos.includes(url));
    // Stays open: you are picking, and re-rendering closed would end the job
    // after one tick.
    state.photosOpen = true;
    renderPhotos();
    renderClipMoves();
    renderCost();
    fetchAdvice();
    fetchSite();
  });
  return div;
}

function renderPhotos() {
  const box = el("rn-photos");
  if (!state.available.length) {
    box.innerHTML = `<p class="empty-note">
      This project has no photos. Go back and add some.</p>`;
    return;
  }

  // Which rooms are in, named in the header -- collapsed, that line is the
  // only thing standing in for thirty-seven thumbnails, so it has to say more
  // than a number.
  const included = [];
  const seen = new Set();
  state.photos.forEach((url) => {
    const label = roomOf(url).label || "Unsorted";
    if (!seen.has(label)) { seen.add(label); included.push(label); }
  });
  const summary = included.length
    ? included.slice(0, 5).join(", ") + (included.length > 5 ? ` +${included.length - 5} more` : "")
    : "nothing selected";

  // The split matters here now: exterior clips are drone moves anchored to a
  // rear photograph, interior ones are not, so which is which is worth saying
  // while the grid is closed.
  const chosenOutside = state.photos.filter(isExterior).length;
  const split = state.photos.length
    ? `${chosenOutside} exterior, ${state.photos.length - chosenOutside} interior`
    : "";

  box.innerHTML = `
    <button type="button" class="rn-photos-head" id="rn-photos-toggle"
            aria-expanded="${state.photosOpen}" aria-controls="rn-grid">
      <span class="rn-photos-chevron" aria-hidden="true"></span>
      <span class="rn-photos-summary">
        <span class="photo-count">
          <strong>${state.photos.length}</strong> of ${state.available.length} photos
          — one clip each, in walkthrough order
        </span>
        <span class="rn-photos-rooms">${escapeHtml(
          split ? split + " — " + summary : summary)}</span>
      </span>
      <span class="btn-secondary btn-tiny" id="rn-clear" role="button">Clear</span>
    </button>
    <div id="rn-photos-body" class="rn-photos-body" ${state.photosOpen ? "" : "hidden"}>
      <p class="hint">Click a photo to include or leave it out.</p>
      <div id="rn-grid" class="photo-grid is-grouped"></div>
    </div>`;

  el("rn-photos-toggle").addEventListener("click", (e) => {
    if (e.target.closest("#rn-clear")) return;
    state.photosOpen = !state.photosOpen;
    renderPhotos();
    renderClipMoves();
    renderCost();
  });

  const grid = el("rn-grid");

  // Two scopes, each holding its room sections. Same split as the clip list
  // underneath, so what you tick and what you then set a move on are
  // organised the same way rather than being two different orders.
  const scopes = [
    { key: "exterior", label: "Exterior", groups: [] },
    { key: "interior", label: "Interior", groups: [] },
  ];
  groupedPhotos().forEach((group) => {
    scopes[isExteriorRoom(group.key) ? 0 : 1].groups.push(group);
  });

  const hosts = {};
  scopes.forEach((scope) => {
    if (!scope.groups.length) return;
    const photos = scope.groups.reduce((n, g) => n + g.photos.length, 0);
    const on = scope.groups.reduce(
      (n, g) => n + g.photos.filter((u) => state.photos.includes(u)).length, 0);

    const wrap = document.createElement("section");
    wrap.className = "photo-scope";
    wrap.innerHTML = `
      <div class="photo-scope-head">
        <span class="photo-scope-label">${scope.label}</span>
        <span class="photo-scope-count">${on}/${photos}</span>
      </div>`;
    grid.appendChild(wrap);
    hosts[scope.key] = wrap;
  });

  groupedPhotos().forEach((group) => {
    const on = group.photos.filter((u) => state.photos.includes(u)).length;
    const section = document.createElement("section");
    section.className = "photo-room" + (group.key === "unsorted" ? " is-secondary" : "");
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
    group.photos.forEach((url) => sub.appendChild(photoTile(url)));
    section.appendChild(sub);

    section.querySelector(".photo-room-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      const turnOn = on !== group.photos.length;
      group.photos.forEach((url) => selectPhoto(url, turnOn));
      renderPhotos();
      renderClipMoves();
      renderCost();
    });

    (hosts[isExteriorRoom(group.key) ? "exterior" : "interior"] || grid)
      .appendChild(section);
  });

  const clear = el("rn-clear");
  if (clear) {
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      state.photos = [];
      renderPhotos();
      renderClipMoves();
      renderCost();
    });
  }
}

/* ---------- style presets ----------

   These three cards used to be a page of their own that saved one field and
   moved on. A style is a preset for the camera moves, so it belongs beside
   them: picking one sets every clip, and any clip can then be changed. The
   choice is still saved on the project, because it is what a returning visit
   opens on.  */

function renderStyleCards() {
  document.querySelectorAll(".style-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.style === state.style);
  });
}

function applyStyle(style, { save = true } = {}) {
  state.style = style;
  const preset = (state.styleDefaults || {})[style];
  if (preset) {
    state.defaultMove = preset;
    state.photos.forEach((url) => { state.moves[url] = preset; });
  }
  renderStyleCards();
  renderClipMoves();

  if (!save || !project.id) return;
  fetch(`/studio/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ style }),
  }).catch(() => {});
}

document.querySelectorAll(".style-card").forEach((card) => {
  card.addEventListener("click", () => applyStyle(card.dataset.style));
});

/* ---------- what the layout says ----------

   The analysis knows, for every photo, which moves reach a room another
   photograph shows and which would invent one. Rendering enforces it either
   way -- an anchor is attached server-side -- but a page that lets you pick a
   move it knows will invent, and says nothing, is the reason a door appeared
   in the first clip. */

/* Which section a photo belongs to. Room sorting already labelled every
   photo, so nothing is classified twice -- a front elevation, an aerial or a
   yard shot is an exterior, and everything else is a room. */
function isExterior(url) {
  const room = (roomOf(url) || {}).room;
  return state.exteriorRooms.includes(room);
}

function isExteriorRoom(key) {
  return state.exteriorRooms.includes(key);
}

function exteriorMoveOptions() {
  return state.exteriorMoves.map((m) => ({ value: m.key, label: m.name }));
}

/* An exterior photo must not keep an interior default. "Push in" on a drone
   shot is not a smaller version of the right move, it is the wrong one. */
function defaultMoveFor(url) {
  if (!isExterior(url)) return state.defaultMove;
  const site = state.site;
  if (site && site.front === url && site.rear) return "flyover_front_to_back";
  if (site && (site.aerials || []).includes(url)) return "pull_back_wide";
  return "approach_front";
}

function moveFor(url) {
  const current = state.moves[url];
  const outside = isExterior(url);
  const isExtMove = state.exteriorMoves.some((m) => m.key === current);
  // A move from the wrong list is replaced rather than shown: the two sets
  // are not interchangeable.
  if (!current || outside !== isExtMove) return defaultMoveFor(url);
  return current;
}

/* Where a clip ends, when it ends somewhere real. */
function anchorFor(url) {
  if (!isExterior(url) || moveFor(url) !== "flyover_front_to_back") return null;
  const verdict = state.siteVerdicts[url];
  if (verdict && verdict.anchor) return verdict.anchor;
  // Before the site call lands, the rear photo is still the only place a
  // flyover can end, so the list does not flicker while it is in flight.
  return (state.site && state.site.rear) || null;
}

/* Photos consumed as the ENDING of another clip. A front-to-back flyover
   already contains the rear photograph -- it is the last frame -- so
   rendering it again as its own clip is the same picture twice and twice the
   money. It stays visible on the flight it belongs to. */
function anchorsInUse() {
  const used = new Set();
  state.photos.forEach((url) => {
    const anchor = anchorFor(url);
    if (anchor) used.add(anchor);
  });
  return used;
}

/* What actually gets rendered and billed. */
function renderablePhotos() {
  const used = anchorsInUse();
  return state.photos.filter((url) => !used.has(url));
}

const LEVEL_MARK = { anchored: "✓", safe: "•", risky: "!" };
const LEVEL_WORD = { anchored: "anchored", safe: "safe", risky: "would invent" };

/* What the outside of this property allows.

   Runs when there are exterior clips, and only then: it is a Gemini call and
   a satellite fetch, which a listing of bathrooms has no use for. */
async function fetchSite() {
  const outside = state.photos.filter(isExterior);
  if (state.siting || !project.lead_id || !outside.length) return;
  state.siting = true;
  try {
    const res = await fetch("/studio/api/video/site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: project.lead_id,
        clips: outside.map((url) => ({ photo: url, move: moveFor(url) })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "the site couldn't be read");
    state.site = body.site;
    state.siteVerdicts = {};
    (body.clips || []).forEach((c) => { state.siteVerdicts[c.photo] = c; });
    renderClipMoves();
    renderCost();
  } catch (err) {
    const note = el("rn-advice-note");
    if (note) note.textContent = "Couldn't read the exterior: " + err.message;
  } finally {
    state.siting = false;
  }
}

async function fetchAdvice() {
  if (state.advising || !project.lead_id || !state.photos.length) return;
  state.advising = true;
  try {
    const res = await fetch("/studio/api/video/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: project.lead_id,
        clips: renderablePhotos().map((url) => ({
          photo: url, move: state.moves[url] || state.defaultMove,
        })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "layout unavailable");
    (body.clips || []).forEach((clip) => { state.advice[clip.photo] = clip; });
    renderClipMoves();
  } catch (err) {
    // Advice is a help, not a gate: the render still enforces anchoring.
    const note = el("rn-advice-note");
    if (note) note.textContent = "Couldn't check the layout: " + err.message;
  } finally {
    state.advising = false;
  }
}

/* Every clip set to the move the layout recommends. Never a risky one. */
function useRecommended() {
  let changed = 0;
  state.photos.forEach((url) => {
    const rec = (state.advice[url] || {}).recommended;
    if (rec && rec.move && state.moves[url] !== rec.move) {
      state.moves[url] = rec.move;
      changed += 1;
    }
  });
  renderClipMoves();
  renderCost();
  const note = el("rn-advice-note");
  if (note) {
    note.textContent = changed
      ? `${changed} clip${changed === 1 ? "" : "s"} set to the recommended move.`
      : "Every clip is already on its recommended move.";
  }
}

/* ---------- camera moves ----------

   The video answer to Scenery's per-room styles, and the same reasoning: one
   setting for a whole listing is the wrong grain. A pull-out reveals the house
   on the exterior and a push-in sells the kitchen; being made to choose one
   for both produces a worse video than either. */

function moveName(key) {
  const found = state.moveList.find((m) => m.key === key);
  return found ? found.name : key;
}

/* Three dropdowns rather than a row of nine buttons plus two fields. The
   buttons were fine when a move was the only per-clip setting; with length and
   resolution beside them the card turned into a wall of controls, and a
   dropdown says the current value in the space one button used. */
function fillSelect(select, options, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>` +
    options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
}

function moveOptions() {
  return state.moveList.map((m) => ({ value: m.key, label: m.name }));
}
function durationOptions() {
  return state.durationList.map((d) => ({ value: String(d), label: d + " seconds" }));
}
function resolutionOptions() {
  return state.resolutionList.map((r) => ({ value: r, label: r }));
}

function renderSetAll() {
  const move = el("rn-all-move");
  const dur = el("rn-all-duration");
  const res = el("rn-all-resolution");
  if (!move) return;

  fillSelect(move, moveOptions(), "Camera move…");
  fillSelect(dur, durationOptions(), "Length…");
  fillSelect(res, resolutionOptions(), "Resolution…");

  // Applying to every clip, then resetting to the placeholder: this row is an
  // action, not a value, and leaving it showing "8 seconds" would imply every
  // clip still says that after one of them is changed.
  const applyAll = (select, apply) => {
    select.addEventListener("change", () => {
      if (!select.value) return;
      state.photos.forEach((url) => apply(url, select.value));
      select.value = "";
      renderClipMoves();
      renderCost();
    });
  };
  applyAll(move, (url, v) => { state.moves[url] = v; });
  applyAll(dur, (url, v) => { state.seconds[url] = Number(v); });
  applyAll(res, (url, v) => { state.quality[url] = v; });
}

/* Adding more photos, from the bottom of the clip list.

   The room grid is collapsed at the top of this step, which is fine when you
   arrive and useless once you have scrolled past five clips -- the way back
   to it was to scroll up and remember it was a dropdown. This opens it and
   takes you there.

   It says how many are left rather than just "add photos", because the
   answer to "is it worth opening" is that number. */
function renderAddMore() {
  const box = el("rn-addmore");
  if (!box) return;

  const spare = state.available.filter((u) => !state.photos.includes(u)).length;
  if (!state.available.length) {
    box.innerHTML = "";
    return;
  }

  box.innerHTML = spare
    ? `<button type="button" class="rn-addmore-btn" id="rn-addmore-btn">
         <span class="rn-addmore-plus" aria-hidden="true">+</span>
         Add photos from this listing
         <span class="rn-addmore-count">${spare} more</span>
       </button>`
    : `<p class="hint rn-addmore-none">Every photo from this listing is already a clip.</p>`;

  const button = el("rn-addmore-btn");
  if (!button) return;
  button.addEventListener("click", () => {
    state.photosOpen = true;
    renderPhotos();
    renderClipMoves();
    renderCost();
    // Opening it silently above the fold would look like nothing happened.
    const grid = el("rn-photos");
    if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderClipMoves() {
  const box = el("rn-clip-moves");
  if (!box) return;

  if (!state.photos.length) {
    box.innerHTML = "";
    return;
  }

  const pick = (options, current) => options.map((o) =>
    `<option value="${escapeHtml(o.value)}"` +
    `${String(o.value) === String(current) ? " selected" : ""}` +
    // Shown but unpickable. The server refuses this move outright, and an
    // option that can be chosen and then rejected is worse than one that
    // says plainly why it is greyed out.
    `${o.disabled ? " disabled" : ""}>` +
    `${escapeHtml(o.label)}</option>`).join("");

  // Two sections, because the moves are two different sets. Outside is a
  // drone flying over a building; inside is a camera easing across a room,
  // and the rules that keep each honest are different.
  const rowFor = (url, i) => {
    const label = roomOf(url).label;
    const outside = isExterior(url);
    const move = moveFor(url);
    const anchor = anchorFor(url);

    const advice = outside ? null : state.advice[url];
    const rec = advice ? advice.recommended : null;
    const verdict = outside
      ? state.siteVerdicts[url]
      : (advice && advice.moves ? advice.moves[move] : null);

    const options = outside
      ? exteriorMoveOptions().map((o) => {
          // A flyover with nowhere to land is not offered as a choice with a
          // warning -- it is not a choice.
          const blocked = o.value === "flyover_front_to_back"
            && !(state.site && state.site.rear);
          return {
            value: o.value,
            label: o.label + (blocked ? " — needs a rear photo" : ""),
            disabled: blocked,
          };
        })
      : moveOptions().map((o) => {
          const v = advice && advice.moves ? advice.moves[o.value] : null;
          const mark = v ? LEVEL_MARK[v.level] || "" : "";
          const rq = rec && rec.move === o.value ? " — recommended" : "";
          return { value: o.value, label: (mark ? mark + " " : "") + o.label + rq };
        });

    return `
      <div class="rn-clip-row ${verdict ? "is-" + verdict.level : ""}" data-url="${escapeHtml(url)}">
        <img class="rn-clip-shot" src="${escapeHtml(url)}" alt="" loading="lazy">
        <div class="rn-clip-body">
          <span class="rn-clip-name">Clip ${i + 1}${label ? " · " + escapeHtml(label) : ""}</span>
          ${anchor ? `
            <span class="rn-ends-on">
              <img src="${escapeHtml(anchor)}" alt="" loading="lazy">
              ends on ${escapeHtml(roomOf(anchor).label || "the rear photo")}
              ${state.photos.includes(anchor)
                ? " — not rendered separately" : ""}
            </span>` : ""}
          ${verdict ? `
            <span class="rn-verdict rn-verdict-${verdict.level}">
              ${LEVEL_WORD[verdict.level] || verdict.level}${
                !outside && verdict.level === "risky" && rec
                  ? ` — try ${escapeHtml(moveName(rec.move))}` : ""}
            </span>
            <span class="rn-verdict-why">${escapeHtml(verdict.reason)}</span>` : ""}
        </div>
        <div class="rn-clip-controls">
          <select class="rn-select" data-field="move" aria-label="Camera move">
            ${pick(options, move)}
          </select>
          <select class="rn-select rn-select-sm" data-field="duration" aria-label="Clip length">
            ${pick(durationOptions(), state.seconds[url] || state.defaultDuration)}
          </select>
          <select class="rn-select rn-select-sm" data-field="resolution" aria-label="Resolution">
            ${pick(resolutionOptions(), state.quality[url] || state.defaultResolution)}
          </select>
        </div>
        <button type="button" class="rn-clip-x" title="Drop this clip"
                aria-label="Drop clip ${i + 1}">&times;</button>
      </div>`;
  };

  const outside = [];
  const inside = [];
  const consumed = anchorsInUse();
  // Numbered over what will actually render, so "Clip 2" means the second
  // clip rather than the second thing ticked.
  let n = 0;
  state.photos.forEach((url) => {
    if (consumed.has(url)) return;
    (isExterior(url) ? outside : inside).push(rowFor(url, n));
    n += 1;
  });

  const site = state.site;
  const siteNote = !outside.length ? "" : (
    site && site.rear
      ? `<p class="rn-scope-note">The back of this house is photographed, so a
           front-to-back flyover ends on a real picture of it.</p>`
      : site
        ? `<p class="rn-scope-note is-warn">No photograph shows the back of this
             house, so a front-to-back flyover isn't offered — it would have to
             invent one.</p>`
        : `<p class="rn-scope-note">Reading the property from the outside…</p>`);

  box.innerHTML =
    (outside.length ? `
      <section class="rn-scope">
        <h3 class="rn-scope-head" data-scope="Exterior"><span
          class="rn-scope-count">${outside.length}</span></h3>
        ${siteNote}
        ${outside.join("")}
      </section>` : "") +
    (inside.length ? `
      <section class="rn-scope">
        <h3 class="rn-scope-head" data-scope="Interior"><span
          class="rn-scope-count">${inside.length}</span></h3>
        ${inside.join("")}
      </section>` : "");

  box.querySelectorAll(".rn-clip-row").forEach((row) => {
    const url = row.dataset.url;

    // Dropping a clip from here is the same as unticking it in the grid, so it
    // goes through selectPhoto -- the numbering and the walkthrough order are
    // that function's job, not this button's. The grid stays shut: removing a
    // clip is not a reason to unfold thirty-seven thumbnails.
    row.querySelector(".rn-clip-x").addEventListener("click", () => {
      selectPhoto(url, false);
      renderPhotos();
      renderClipMoves();
      renderCost();
    });

    row.querySelectorAll("select").forEach((select) => {
      select.addEventListener("change", () => {
        const value = select.value;
        if (select.dataset.field === "move") state.moves[url] = value;
        if (select.dataset.field === "duration") state.seconds[url] = Number(value);
        if (select.dataset.field === "resolution") state.quality[url] = value;
        // No re-render here: the select already shows the new value, and
        // rebuilding would close the dropdown still under the cursor. The
        // verdict is refreshed instead, which re-renders when it lands.
        renderCost();
        if (select.dataset.field === "move") {
          if (isExterior(url)) fetchSite(); else fetchAdvice();
        }
      });
    });
  });

  renderAddMore();
}

/* ---------- cost, stated before it is spent ---------- */

function rateFor(resolution) {
  const rate = state.rates[resolution];
  return typeof rate === "number" ? rate : (state.ratePerSecond || 0);
}

function renderCost() {
  // Anchors are excluded: a photo used as a flyover's last frame is not a
  // second clip and must not be billed as one.
  const billable = renderablePhotos();
  const n = billable.length;
  const totalSeconds = billable.reduce(
    (sum, url) => sum + (state.seconds[url] || state.defaultDuration), 0);
  // Per clip at that clip's own resolution: 1080p is about four times 480p,
  // so one blended rate across a mixed selection would be wrong every time.
  const totalCost = billable.reduce((sum, url) =>
    sum + (state.seconds[url] || state.defaultDuration)
        * rateFor(state.quality[url] || state.defaultResolution), 0);
  const go = el("rn-go");
  const note = el("rn-note");

  if (!state.configured) {
    go.disabled = true;
    el("rn-cost").textContent = "";
    return;
  }

  go.disabled = n === 0;
  go.textContent = n ? `Render ${n} clip${n === 1 ? "" : "s"}` : "Render";

  if (!n) {
    el("rn-cost").textContent = "";
    note.textContent = "Nothing selected to render.";
    return;
  }

  note.textContent = "";
  if (state.ratePerSecond == null) {
    el("rn-cost").textContent = "";
    return;
  }
  // Video is metered, unlike Scenery. The number goes next to the button, not
  // further down the page, because this click is the one that spends.
  const used = [...new Set(billable.map(
    (url) => state.quality[url] || state.defaultResolution))];
  const rateNote = used.length === 1
    ? `$${rateFor(used[0]).toFixed(3)}/second at ${used[0]}`
    : `across ${used.join(", ")}`;

  // Only offer a cheaper tier the model actually has, and only when it IS
  // cheaper. On a flat-rate model this said "720p would be about $2.98" next
  // to a $2.98 total, which is worse than saying nothing.
  const cheapest = Object.keys(state.rates)
    .filter((res) => rateFor(res) < rateFor(used[0] || state.defaultResolution))
    .sort((a, b) => rateFor(a) - rateFor(b))[0];
  const saving = cheapest
    ? billable.reduce((sum, url) =>
        sum + (state.seconds[url] || state.defaultDuration) * rateFor(cheapest), 0)
    : null;

  el("rn-cost").innerHTML =
    `<strong>${escapeHtml(state.modelLabel)}</strong> · ` +
    `${n} clip${n === 1 ? "" : "s"}, ${totalSeconds}s of footage at ${rateNote} ` +
    `— about <strong>$${totalCost.toFixed(2)}</strong>.` +
    (saving != null && saving < totalCost - 0.005
      ? ` <span class="rn-cost-tip">${cheapest} would be about $${saving.toFixed(2)}.</span>`
      : "");
}

/* ---------- the run ---------- */

function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  el("rn-bar-fill").style.width = pct + "%";
  el("rn-bar").setAttribute("aria-valuenow", String(pct));
  el("rn-count").textContent = `${done} of ${total} clip${total === 1 ? "" : "s"}`;

  const eta = el("rn-eta");
  if (done >= total) {
    eta.textContent = "Finishing up…";
    return;
  }
  const elapsed = (Date.now() - state.startedAt) / 1000;
  if (done > 0) {
    // Clips run one at a time and take minutes, so measured throughput is the
    // only honest estimate -- there is no useful constant to fall back on.
    eta.textContent = "about " + fmtDuration((total - done) * (elapsed / done)) + " left";
  } else {
    eta.textContent = fmtDuration(elapsed) + " elapsed";
  }
}

function renderClipList(clips, total) {
  el("rn-list").innerHTML = Array.from({ length: total }, (_, i) => {
    const clip = clips[i];
    const status = !clip ? "waiting"
      : clip.video_url ? "done"
      : clip.status === "failed" ? "failed"
      : "running";
    const label = { waiting: "Queued", running: "Rendering…", done: "Done", failed: "Failed" }[status];
    const url = state.photos[i];
    const move = url
      ? `${moveName(state.moves[url] || state.defaultMove)} · ${state.seconds[url] || state.defaultDuration}s`
      : "";
    return `<li class="scn-gen-row ${status === "done" ? "is-done" : ""}">
        <span class="scn-gen-room">Clip ${i + 1}${move ? " · " + escapeHtml(move) : ""}</span>
        <span class="scn-gen-nums">${label}</span>
      </li>`;
  }).join("");
}

async function startRender() {
  if (state.polling) return;
  const totalSeconds = state.photos.reduce(
    (sum, url) => sum + (state.seconds[url] || state.defaultDuration), 0);

  state.polling = true;
  state.startedAt = Date.now();
  show("rn-setup", false);
  show("rn-results", false);
  show("rn-running", true);
  markStep(3);
  el("rn-run-title").textContent = "Rendering your clips";
  el("rn-run-sub").textContent =
    `${state.photos.length} clip${state.photos.length === 1 ? "" : "s"}, ` +
    `${totalSeconds}s of footage. Clips take a couple of minutes apiece.`;
  setProgress(0, state.photos.length);
  renderClipList([], state.photos.length);

  let data;
  try {
    const res = await fetch("/studio/api/video/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Clips rather than bare photos: each carries its own camera move.
        clips: renderablePhotos().map((url) => ({
          photo: url,
          move: state.moves[url] || state.defaultMove,
          duration: state.seconds[url] || state.defaultDuration,
          resolution: state.quality[url] || state.defaultResolution,
        })),
        lead_id: project.lead_id || null,
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    state.polling = false;
    show("rn-running", false);
    show("rn-setup", true);
    banner(err.message);
    return;
  }

  state.job = data.job;
  pollJob(data.job.id);
}

async function pollJob(jobId) {
  let job;
  try {
    const res = await fetch(`/studio/api/video/jobs/${jobId}`);
    const body = await res.json();
    if (!res.ok || !body.job) throw new Error(body.error || "lost track of the render");
    job = body.job;
  } catch (err) {
    state.polling = false;
    banner(err.message);
    show("rn-running", false);
    show("rn-setup", true);
    return;
  }

  state.job = job;
  setProgress(job.clips_done, job.clips_total);
  renderClipList(job.clips || [], job.clips_total);

  if (job.status === "queued" || job.status === "running") {
    // Slower than Scenery's poll on purpose: clips take minutes, not seconds.
    setTimeout(() => pollJob(jobId), 4000);
    return;
  }

  state.polling = false;
  finish(job);
}

function finish(job) {
  el("rn-bar-fill").style.width = "100%";
  show("rn-running", false);
  show("rn-results", true);
  markStep(3);

  // Keep each clip's position in the job, because that index is what the
  // trash endpoint addresses.
  const clips = (job.clips || [])
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.video_url && !c.deleted_at);
  const failed = (job.clips_total || 0) - clips.length;
  const took = state.startedAt
    ? fmtDuration((Date.now() - state.startedAt) / 1000) : null;

  if (!clips.length) {
    // Only a genuinely failed job says so. A job with no clips that is still
    // queued or running has simply not produced one yet.
    const stillGoing = job.status === "queued" || job.status === "running";
    el("rn-done").innerHTML = stillGoing
      ? `<div class="scn-run scn-run-busy"><span class="scn-spin" aria-hidden="true"></span>
           <span>Still rendering — nothing has landed yet.</span></div>`
      : `<div class="scn-run scn-run-error"><strong>Nothing rendered.</strong> ` +
        `${escapeHtml(job.error || (job.clips || [])[0]?.error || "The render failed.")}</div>`;
    el("rn-clips").innerHTML = "";
    return;
  }

  el("rn-done").innerHTML =
    `<div class="scn-run scn-run-done"><strong>${state.reopened ? "Saved render." : "Done."}</strong> ` +
    `${clips.length} clip${clips.length === 1 ? "" : "s"} rendered` +
    `${took ? " in " + took : ""}` +
    `${job.estimated_cost != null ? ` · about $${job.estimated_cost.toFixed(2)}` : ""}.` +
    `${failed ? ` <span class="scn-run-warn">${failed} failed.</span>` : ""}</div>`;

  el("rn-clips").classList.remove("rn-clips-grouped");
  el("rn-clips").innerHTML = clips.map((clip, i) => `
    <figure class="rn-clip">
      ${clipX(job.id, clip.index)}
      <video src="${escapeHtml(clip.video_url)}" controls preload="metadata"></video>
      <figcaption>Clip ${i + 1}${clip.move ? " · " + escapeHtml(moveName(clip.move)) : ""}</figcaption>
    </figure>`).join("");

  // Stitching is the next arrow in the chain and does not exist yet; saying so
  // beats implying these are a finished video.
  el("rn-results-note").textContent = clips.length > 1
    ? "These are separate clips — stitching them into one video isn't built yet."
    : "";
}

/* ---------- every render for one listing, on one page ----------

   The renders picker groups by home, and opening a home that has several
   runs lands here rather than making you visit each one in turn. Each run
   keeps its own heading -- they were separate attempts with their own cost
   and settings, and flattening them would lose which clip came from where --
   but they are all on one page. */
async function openLeadRenders(leadId) {
  state.reopened = true;
  show("rn-setup", false);
  show("rn-running", false);
  show("rn-results", true);
  markStep(3);

  let runs = [];
  try {
    const res = await fetch("/studio/api/video/jobs");
    const body = await res.json();
    runs = (body.renders || []).filter((r) => String(r.lead_id) === String(leadId));
  } catch (err) {
    el("rn-done").innerHTML =
      `<div class="scn-run scn-run-error"><strong>Couldn't load.</strong> ` +
      `${escapeHtml(err.message)}</div>`;
    return;
  }

  const done = runs.filter((r) => (r.clips || []).length);
  if (!done.length) {
    el("rn-done").innerHTML =
      `<div class="scn-run scn-run-error">Nothing has finished rendering for ` +
      `this listing yet.</div>`;
    el("rn-clips").innerHTML = "";
    return;
  }

  const clips = done.reduce((n, r) => n + r.clips.length, 0);
  // Spend over EVERY render for this listing, including ones whose clips are
  // all in the trash. Deleting a clip does not refund it, and a total that
  // fell when you tidied up would disagree with the dashboard.
  const spend = runs.reduce(
    (n, r) => n + (r.cost != null ? r.cost : (r.estimated_cost || 0)), 0);
  const trashed = runs.reduce((n, r) => n + (r.trashed || 0), 0);

  el("rn-done").innerHTML =
    `<div class="scn-run scn-run-done"><strong>Saved renders.</strong> ` +
    `${clips} clip${clips === 1 ? "" : "s"} across ${done.length} ` +
    `render${done.length === 1 ? "" : "s"} · $${spend.toFixed(2)} total` +
    `${trashed ? ` · ${trashed} in trash` : ""}.</div>`;

  // Oldest first, so the numbering matches the order they were made and
  // reading down the page follows the work.
  const ordered = [...done].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

  el("rn-clips").classList.add("rn-clips-grouped");
  el("rn-clips").innerHTML = ordered.map((run, n) => {
    const cost = run.cost != null ? run.cost : run.estimated_cost;
    return `
      <section class="rn-run-block">
        <h3 class="rn-run-title">
          <span class="rn-run-n">${n + 1}</span>
          <span>${run.clips.length} clip${run.clips.length === 1 ? "" : "s"}</span>
          <span class="rn-run-meta">${escapeHtml(run.model_label || "")}${
            cost != null ? " · $" + cost.toFixed(2) : ""}</span>
          <a class="btn-secondary btn-tiny"
             href="/studio/create/render?job=${run.id}">Open on its own</a>
        </h3>
        <div class="rn-clip-grid">
          ${run.clips.map((clip, i) => `
            <figure class="rn-clip">
              ${clipX(run.id, clip.index)}
              <video src="${escapeHtml(clip.video_url)}" controls preload="metadata"></video>
              <figcaption>Clip ${i + 1}${
                clip.move ? " · " + escapeHtml(moveName(clip.move)) : ""}${
                clip.duration ? " · " + clip.duration + "s" : ""}</figcaption>
            </figure>`).join("")}
        </div>
      </section>`;
  }).join("");

  el("rn-results-note").textContent =
    "Separate clips from separate runs — stitching them into one video isn't built yet.";
}

/* ---------- trashing a clip ----------

   Soft only. The mp4 is left on disk and the clip is marked, so this is
   always recoverable from the trash -- a single X next to work that cost
   real money should not be able to destroy it. */
function clipX(jobId, index) {
  // Deliberately NOT .rn-clip-x -- that class already belongs to the shots
  // step's "drop this clip from the selection" button, and a shared name
  // meant this handler fired on those too, swallowing their click and
  // POSTing an undefined clip.
  return `<button type="button" class="rn-clip-trash" data-job="${jobId}" data-index="${index}"
                  title="Move to trash" aria-label="Move this clip to trash">&times;</button>`;
}

async function trashClip(jobId, index) {
  try {
    const res = await fetch("/studio/api/video/clip/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: Number(jobId), index: Number(index) }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Couldn't delete that.");
  } catch (err) {
    banner(err.message);
    return;
  }
  // Redraw from the server rather than removing the node, so the counts and
  // totals around it stay honest.
  await refreshResults();
  await loadTrashView();
}

document.addEventListener("click", (e) => {
  const x = e.target.closest(".rn-clip-trash");
  if (!x) return;
  e.preventDefault();
  e.stopPropagation();
  trashClip(x.dataset.job, x.dataset.index);
});

/* ---------- the trash tab ----------

   Scoped to whatever this page is about: one listing when it was opened for
   a lead, one render otherwise. A page about 8732 15th Street Rd listing
   another listing's deleted clips would be a filing cabinet, not this page. */
let trashList = [];

function trashScopeMatches(clip) {
  if (window.__LEAD_RENDERS__) {
    return String(clip.lead_id) === String(window.__LEAD_RENDERS__);
  }
  if (window.__JOB_ID__) return String(clip.job_id) === String(window.__JOB_ID__);
  return false;
}

/* Redraw whichever results view this page is showing. */
async function refreshResults() {
  if (window.__LEAD_RENDERS__) await openLeadRenders(window.__LEAD_RENDERS__);
  else if (window.__JOB_ID__) await openSavedJob(window.__JOB_ID__);
}

async function loadTrashView() {
  try {
    const res = await fetch("/studio/api/video/trash");
    const body = await res.json();
    trashList = (body.clips || []).filter(trashScopeMatches);
  } catch (err) {
    trashList = [];
  }

  const count = el("rn-trash-count");
  if (count) count.textContent = trashList.length ? String(trashList.length) : "";

  const box = el("rn-trash");
  if (!box) return;
  el("rn-trash-empty").classList.toggle("hidden", trashList.length > 0);

  box.innerHTML = trashList.map((c) => `
    <figure class="rn-clip is-trashed">
      <video src="${escapeHtml(c.video_url)}" controls preload="metadata"></video>
      <figcaption>
        ${escapeHtml(moveName(c.move) || "Clip")}${c.duration ? " · " + c.duration + "s" : ""}
        <button type="button" class="rn-restore"
                data-job="${c.job_id}" data-index="${c.index}">Restore</button>
      </figcaption>
    </figure>`).join("");

  box.querySelectorAll(".rn-restore").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await fetch("/studio/api/video/clip/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: Number(btn.dataset.job),
                               index: Number(btn.dataset.index) }),
      });
      await refreshResults();
      await loadTrashView();
    });
  });
}

function showResultsView(name) {
  const trash = name === "trash";
  const clipsView = el("rn-view-clips");
  const trashView = el("rn-view-trash");
  if (!clipsView || !trashView) return;
  clipsView.hidden = trash;
  trashView.hidden = !trash;
  document.querySelectorAll(".rn-tab").forEach((tab) => {
    const on = (tab.dataset.view === "trash") === trash;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  if (trash) loadTrashView();
}

document.querySelectorAll(".rn-tab").forEach((tab) => {
  tab.addEventListener("click", () => showResultsView(tab.dataset.view));
});

function banner(message) {
  const box = el("rn-connection");
  box.hidden = false;
  box.innerHTML = `<strong>Couldn't render.</strong> ${escapeHtml(message)}`;
}

/* ---------- init ---------- */

/* Opening a finished render: the same results view a run ends on, which is
   the point -- what you want back is the thing you were looking at, not a
   different summary of it. Nothing regenerates; the clips already exist. */
async function openSavedJob(jobId) {
  state.reopened = true;
  try {
    const res = await fetch(`/studio/api/video/jobs/${jobId}`);
    const body = await res.json();
    if (!res.ok || !body.job) throw new Error(body.error || "That render is gone.");

    // Still going. Reopening one must rejoin the progress screen, not hand a
    // clipless job to finish() -- which read "no clips" as "failed" and told
    // you a healthy render had died.
    if (body.job.status === "queued" || body.job.status === "running") {
      state.polling = true;
      // created_at is a naive-UTC ISO string, so it needs the Z or the elapsed
      // time comes out hours wrong -- the same trap that made a render read
      // "-1 days ago" in the picker.
      const started = body.job.created_at
        ? Date.parse(body.job.created_at + "Z") : NaN;
      state.startedAt = state.startedAt
        || (Number.isNaN(started) ? Date.now() : started);
      show("rn-setup", false);
      show("rn-results", false);
      show("rn-running", true);
      markStep(3);
      el("rn-run-title").textContent = "Rendering your clips";
      el("rn-run-sub").textContent =
        "Picked up a render already in progress. It keeps going whether or not "
        + "this page is open.";
      setProgress(body.job.clips_done || 0, body.job.clips_total || 1);
      renderClipList(body.job.clips || [], body.job.clips_total || 1);
      pollJob(jobId);
      return;
    }

    show("rn-setup", false);
    show("rn-running", false);

    // Seed the shots step from what this render actually used, so going back
    // to it offers the same setup rather than the defaults.
    const specs = body.job.specs || [];
    const clips = body.job.clips || [];
    const used = [];
    clips.forEach((clip, i) => {
      const url = clip.photo;
      if (!url || !state.available.includes(url)) return;
      used.push(url);
      const spec = specs[i] || {};
      if (spec.move || clip.move) state.moves[url] = spec.move || clip.move;
      if (spec.duration || clip.duration) state.seconds[url] = spec.duration || clip.duration;
      if (spec.resolution || clip.resolution) state.quality[url] = spec.resolution || clip.resolution;
    });
    if (used.length) {
      state.photos = walkthroughOrder().filter((u) => used.includes(u));
      renderPhotos();
      renderClipMoves();
      renderCost();
    }

    finish(body.job);
    // Step 2 is reachable from here, so this is the same journey either way.
    const again = el("rn-again");
    if (again) {
      again.textContent = state.available.length ? "Change shots and render again"
                                                 : "New render";
    }
  } catch (err) {
    show("rn-setup", true);
    banner(err.message);
  }
}

async function init() {
  // Only the photos the project actually selected -- and never a video file,
  // which is already moving and has nothing to animate.
  // A video file is already moving and has nothing to animate, so it is not
  // a candidate.
  const chosen = project.selected_photos || project.photos || [];
  state.available = chosen.filter((u) => u && !isVideo(u));

  // One per room where the photos have been sorted, so the default tour hits
  // living/kitchen/bedroom rather than six angles of the same lounge; a plain
  // cap otherwise. Either way it starts small.
  const seen = new Set();
  state.photos = walkthroughOrder().filter((url) => {
    const room = roomOf(url).room;
    if (!room || seen.has(room)) return false;
    seen.add(room);
    return true;
  }).slice(0, DEFAULT_CLIPS);
  // No labels at all (a pasted link or a manual upload): fall back to a cap,
  // still in the order the photos arrived.
  if (!state.photos.length) state.photos = state.available.slice(0, DEFAULT_CLIPS);

  el("rn-sub").textContent = project.address || project.name || el("rn-sub").textContent;

  renderPhotos();

  try {
    const status = await (await fetch("/studio/api/video/status")).json();
    state.configured = !!status.configured;
    state.ratePerSecond = status.rate_per_second ?? null;
    state.rates = status.rates || {};
    state.modelLabel = status.model_label || status.model || "";
    if (!state.configured) {
      banner(status.config_error ||
        "The video generator isn't connected. Add an Atlas Cloud key to studio/atlascloud.json.");
    }
    state.durationList = status.durations || [4, 5, 6, 8, 10, 12, 15, 20, 30];
    state.resolutionList = status.resolutions || ["480p", "720p", "1080p"];
    if (status.default_duration) state.defaultDuration = status.default_duration;
    if (status.default_resolution) state.defaultResolution = status.default_resolution;

    state.moveList = status.moves || [];
    state.exteriorMoves = status.exterior_moves || [];
    state.exteriorRooms = status.exterior_rooms || [];
    state.styleDefaults = status.style_default_move || {};

    // Re-applying the saved style seeds every clip, without saving it back --
    // opening the page is not a change.
    if (project.style) applyStyle(project.style, { save: false });
    state.photos.forEach((url) => {
      if (!state.moves[url]) state.moves[url] = state.defaultMove;
    });
    renderSetAll();
    // The grid was drawn before this request came back, when the page did not
    // yet know which room labels are outside -- so every photo landed under
    // Interior and stayed there. Redraw it now that the answer is in.
    renderPhotos();
    renderClipMoves();
    renderStyleCards();
  } catch (err) {
    banner("Couldn't reach the server to check the generator.");
  }

  renderCost();

  fetchAdvice();
  fetchSite();

  if (window.__LEAD_RENDERS__ || window.__JOB_ID__) {
    await refreshResults();
    // Loaded up front so the tab can say how many are in there without
    // having to be opened first.
    loadTrashView();
  }
}

el("rn-recommend").addEventListener("click", useRecommended);
el("rn-go").addEventListener("click", startRender);
el("rn-back").addEventListener("click", () => {
  window.location.href = `/studio/create?project=${project.id}`;
});
function backToShots() {
  // Nothing to go back TO without photos -- that only happens when a saved
  // render's lead has since lost them.
  if (!state.available.length) {
    window.location.href = "/studio/create";
    return;
  }
  state.reopened = false;
  show("rn-results", false);
  show("rn-running", false);
  show("rn-setup", true);
  markStep(2);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

el("rn-again").addEventListener("click", backToShots);
// Backwards only, like Scenery's, and never mid-render.
document.querySelectorAll("#steps .step").forEach((li) => {
  li.addEventListener("click", () => {
    if (state.polling) return;
    const step = Number(li.dataset.step);
    if (step === 1) {
      window.location.href = project.id
        ? `/studio/create?project=${project.id}`
        : "/studio/create";
    }
    if (step === 2) backToShots();
  });
});

el("rn-cancel").addEventListener("click", async () => {
  if (!state.job) return;
  await fetch(`/studio/api/video/jobs/${state.job.id}/cancel`, { method: "POST" })
    .catch(() => {});
  state.polling = false;
  show("rn-running", false);
  show("rn-setup", true);
  markStep(2);
});

init();
