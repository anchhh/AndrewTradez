/*
 * The staged-room panel, shared by Scenery and the lead profile.
 *
 * Scenery shows it at the end of a run; the profile shows the same rooms
 * again days later. That is the same thing twice, and two copies of a
 * before/after wipe is how they drift into behaving differently -- so the
 * markup, the wipe, the style switching and the fullscreen viewer live here
 * once and both pages pass their own data in.
 *
 *   stagedRoomPanel({ beforeUrl, label, variants, activeStyle, ... })
 *   openStagedCompare({ rooms, index, style })
 *
 * Nothing here reads page state. Everything a page wants to happen on a click
 * arrives as a callback, which is what lets the profile reuse the panel
 * without inheriting Scenery's wizard.
 */

const STAGE_STYLES = [
  ["unfurnished", "Unfurnished", "Clear the room out — empty walls and floor, nothing added"],
  ["modern", "Modern", "Clean lines, neutral palette, low profile furniture"],
  ["scandinavian", "Scandinavian", "Pale wood, white walls, soft textiles"],
  ["farmhouse", "Farmhouse", "Warm timber, shaker forms, muted greens"],
  ["midcentury", "Mid-century", "Walnut, tapered legs, muted oranges and teals"],
  ["coastal", "Coastal", "Light linen, rattan, blue and sand"],
  ["traditional", "Traditional", "Classic upholstery, warm woods, symmetry"],
  ["minimal", "Minimal", "Very little furniture, lots of floor showing"],
  ["luxury", "Luxury", "Statement pieces, rich materials, layered lighting"],
];

const STAGE_STYLE_NAME = Object.fromEntries(STAGE_STYLES.map(([k, n]) => [k, n]));

function srEscape(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* The wipe. Shared by the card and the fullscreen view because it is the same
   interaction at two sizes. */
function srWireCompare(root) {
  const compare = root.querySelector(".scn-compare");
  const slider = root.querySelector(".scn-slider");
  const wrap = root.querySelector(".scn-after-wrap");
  const handle = root.querySelector(".scn-handle");
  if (!compare || !slider) return null;

  const setSplit = (pct) => {
    // The after side is revealed from the right, so 100 means all before.
    wrap.style.clipPath = `inset(0 0 0 ${pct}%)`;
    handle.style.left = `${pct}%`;
    compare.classList.toggle("is-all-before", Number(pct) >= 99);
  };
  setSplit(slider.value);
  slider.addEventListener("input", () => setSplit(slider.value));
  return setSplit;
}

/* `keepImg` forces the <img> to exist even with nothing to show yet. The
   fullscreen overlay is built once and then repainted by setting .src, so it
   needs the element up front -- a card, which is rebuilt per render, does
   not and shows a caption instead. */
function srCompareMarkup(beforeUrl, afterUrl, pending, keepImg) {
  return `
    <div class="scn-compare ${afterUrl || keepImg ? "" : "is-pending"}">
      <img class="scn-before" src="${srEscape(beforeUrl)}" alt="Before">
      <div class="scn-after-wrap">
        ${afterUrl || keepImg
          ? `<img class="scn-after" src="${srEscape(afterUrl)}" alt="After">`
          : `<div class="scn-after-pending">${srEscape(pending || "Not staged yet")}</div>`}
      </div>
      <input class="scn-slider" type="range" min="0" max="100" value="${afterUrl ? 50 : 100}"
             aria-label="Compare before and after">
      <span class="scn-handle" aria-hidden="true"></span>
      <span class="scn-tag scn-tag-before">Before</span>
      <span class="scn-tag scn-tag-after">After</span>
    </div>`;
}

/*
 * One room panel.
 *
 *   beforeUrl    the original photo
 *   label        room name
 *   variants     {styleKey: stagedUrl} -- what exists for this room
 *   activeStyle  which variant to show
 *   pending      caption for the after side when nothing is staged
 *   warning      what the empty-check still saw, if anything
 *   hint         small line above the style buttons
 *   styles       which styles to offer (defaults to all)
 *   onStyle(key) clicking a style button
 *   onOpen()     "View full screen"
 *   onRetry(btn) shows a Try again button beside the warning when given
 */
function stagedRoomPanel(opts) {
  const variants = opts.variants || {};
  const activeStyle = opts.activeStyle || "";
  const afterUrl = variants[activeStyle] || null;
  const offered = opts.styles || STAGE_STYLES.map((s) => s[0]);

  const card = document.createElement("div");
  card.className = "scn-room";
  card.innerHTML = `
    ${srCompareMarkup(opts.beforeUrl, afterUrl, opts.pending)}
    <div class="scn-room-meta">
      <h3 class="scn-room-label">${srEscape(opts.label || "Room")}</h3>
      ${opts.hint ? `<span class="scn-room-prompt">${srEscape(opts.hint)}</span>` : ""}
      <div class="scn-room-styles">
        ${STAGE_STYLES.filter(([k]) => offered.includes(k)).map(([k, n, desc]) => `
          <button type="button" class="scn-room-style ${k === activeStyle ? "is-active" : ""}${variants[k] ? " is-ready" : ""}"
                  data-style="${k}" title="${srEscape(desc)}">${srEscape(n)}</button>`).join("")}
      </div>
      <button type="button" class="scn-room-open btn-tiny">View full screen</button>
      ${opts.warning ? `
        <div class="scn-room-warn">
          <span><strong>Still in the room:</strong> ${srEscape(opts.warning)}</span>
          ${opts.onRetry ? `<button type="button" class="scn-room-retry btn-tiny">Try again</button>` : ""}
        </div>` : ""}
    </div>`;

  srWireCompare(card);

  if (opts.onStyle) {
    card.querySelectorAll(".scn-room-style").forEach((btn) => {
      btn.addEventListener("click", () => opts.onStyle(btn.dataset.style));
    });
  }
  if (opts.onOpen) {
    card.querySelector(".scn-room-open").addEventListener("click", () => opts.onOpen());
  }
  const retry = card.querySelector(".scn-room-retry");
  if (retry && opts.onRetry) {
    retry.addEventListener("click", () => opts.onRetry(retry));
  }

  return card;
}

/* ---------- fullscreen ----------

   The overlay builds itself on first use rather than living in each template.
   Two pages needing the same markup is exactly how one of them ends up with a
   stale copy of it. */

let srFull = null;
const srCompare = { rooms: [], index: 0, style: null, onStyle: null };

function srBuildOverlay() {
  if (srFull) return srFull;

  srFull = document.createElement("div");
  srFull.id = "staged-full";
  srFull.className = "scn-full hidden";
  srFull.setAttribute("aria-hidden", "true");
  srFull.innerHTML = `
    <button type="button" class="scn-full-x" data-close aria-label="Close">&times;</button>
    <button type="button" class="scn-full-nav scn-full-prev" aria-label="Previous room">&#8249;</button>
    <button type="button" class="scn-full-nav scn-full-next" aria-label="Next room">&#8250;</button>
    <figure class="scn-full-stage">
      ${srCompareMarkup("", "", "", true)}
      <figcaption class="scn-full-bar">
        <span class="scn-full-label"></span>
        <div class="scn-full-styles"></div>
      </figcaption>
    </figure>`;
  srFull.querySelector(".scn-compare").classList.add("scn-compare-full");
  document.body.appendChild(srFull);

  srWireCompare(srFull);
  srFull.querySelector("[data-close]").addEventListener("click", srCloseCompare);
  srFull.querySelector(".scn-full-prev").addEventListener("click", () => srMove(-1));
  srFull.querySelector(".scn-full-next").addEventListener("click", () => srMove(1));
  // Clicking the backdrop closes; clicking the image must not.
  srFull.addEventListener("click", (e) => { if (e.target === srFull) srCloseCompare(); });

  document.addEventListener("keydown", (e) => {
    if (!srFull || srFull.classList.contains("hidden")) return;
    if (e.key === "Escape") srCloseCompare();
    if (e.key === "ArrowLeft") srMove(-1);
    if (e.key === "ArrowRight") srMove(1);
  });

  return srFull;
}

function srRenderCompare() {
  const room = srCompare.rooms[srCompare.index];
  if (!room) return;
  const variants = room.variants || {};
  const style = variants[srCompare.style]
    ? srCompare.style
    : STAGE_STYLES.map((s) => s[0]).find((k) => variants[k]);
  srCompare.style = style;

  srFull.querySelector(".scn-before").src = room.beforeUrl;
  srFull.querySelector(".scn-after").src = variants[style] || room.beforeUrl;

  const name = STAGE_STYLE_NAME[style] || style || "";
  srFull.querySelector(".scn-full-label").textContent =
    `${room.label || "Room"}${name ? " · " + name : ""}` +
    (srCompare.rooms.length > 1 ? `  (${srCompare.index + 1} of ${srCompare.rooms.length})` : "");

  const bar = srFull.querySelector(".scn-full-styles");
  bar.innerHTML = STAGE_STYLES.map(([k, n]) => variants[k]
    ? `<button type="button" class="scn-room-style ${k === style ? "is-active" : ""}"
               data-style="${k}">${srEscape(n)}</button>`
    : "").join("");
  bar.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      srCompare.style = b.dataset.style;
      // The split stays where it is: comparing styles against each other at
      // the same wipe position is the point.
      srRenderCompare();
      if (srCompare.onStyle) srCompare.onStyle(b.dataset.style, room);
    });
  });
}

function srMove(delta) {
  if (srCompare.rooms.length < 2) return;
  const n = srCompare.rooms.length;
  srCompare.index = (srCompare.index + delta + n) % n;
  srRenderCompare();
}

function srCloseCompare() {
  if (!srFull) return;
  srFull.classList.add("hidden");
  srFull.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

/* rooms: [{beforeUrl, label, variants}] */
function openStagedCompare({ rooms, index = 0, style = null, onStyle = null }) {
  srBuildOverlay();
  srCompare.rooms = (rooms || []).filter((r) => Object.keys(r.variants || {}).length);
  if (!srCompare.rooms.length) return;
  srCompare.index = Math.max(0, Math.min(index, srCompare.rooms.length - 1));
  srCompare.style = style;
  srCompare.onStyle = onStyle;
  srRenderCompare();
  // The overlay is built once with nothing to show, so its slider starts at
  // "all before". Centre it on open, or the first view looks unstaged.
  const slider = srFull.querySelector(".scn-slider");
  if (slider && Number(slider.value) >= 99) {
    slider.value = 50;
    slider.dispatchEvent(new Event("input"));
  }
  srFull.classList.remove("hidden");
  srFull.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
