/* The generate stage: two shots, the front and the back.

   A flight starts on one and lands on the other, so those are the two
   pictures worth making. Everything placed on the board at stage 2 feeds one
   of the two columns: the oblique is what each is built ON, because it
   already looks like a photograph taken from the air, then the rest of that
   side, then the neighbours, which go into BOTH because a house is rebuilt
   in its street.

   Generated here rather than in Google Flow. Flow made the shot that settled
   which model to use, and driving its page from the extension got three
   guesses deep without ever attaching to the prompt; the same model through
   Atlas Cloud does it in one call, on the account that already pays for the
   video.

   One image per side, replaced rather than accumulated. There is one front
   of a house, and a gallery of attempts at it is a decision deferred. */

const lead = window.__LEAD__;
const sides = window.__SIDES__ || [];
const shotLabels = window.__SHOT_LABELS__ || {};
const slots = window.__SLOTS__ || {};
const slotOrder = window.__SLOT_ORDER__ || Object.keys(slots);

const defaultPrompts = window.__PROMPTS__ || {};

let generated = window.__GENERATED__ || {};
/* Edited wording, per side, for the visit. Per side because the two
   prompts are not the same text any more: the front's says FRONT twice and
   the back's says BACK, and carrying an edit across would quietly hand the
   back the front's rule. An edit is a thing you are trying, not a setting,
   so it does not outlive the page. */
const edits = {};

const promptFor = (side) => edits[side] || defaultPrompts[side] || "";

const el = (id) => document.getElementById(id);
const note = (text) => { el("gn-note").textContent = text || ""; };
const busy = {};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* What a picture is, from the boxes it was placed in at stage 2.

   Boxes, plural: one capture is often three of them at once -- an oblique
   can be the front's 3D, the back's and the neighbours' -- and it is sent
   once. Walked in the plan's order rather than the object's, because the
   object arrives alphabetically sorted and that named a front overhead
   "Back". */
function boxKeysOf(url) {
  return slotOrder.filter((key) => (slots[key] || []).includes(url));
}

function boxesOf(url) {
  return boxKeysOf(url).map((key) => shotLabels[key] || "Capture");
}

/* Front, Back or Neighbours, from the box's own key. Which GROUP a picture
   belongs to is the question people actually ask of this list -- "where are
   the neighbours" was asked of a panel that was already sending four of
   them, under the name of the first box they happened to sit in. */
const GROUPS = { front: "Front", back: "Back", nb: "Neighbours" };

function groupsOf(url) {
  const seen = [];
  boxKeysOf(url).forEach((key) => {
    const group = GROUPS[key.split("_")[0]];
    if (group && !seen.includes(group)) seen.push(group);
  });
  return seen;
}

function nameOf(url) {
  return boxesOf(url)[0] || "Capture";
}

/* ---------- full size ---------- */

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
  if (e.target.id !== "ge-lightbox-img") closeZoom();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ge-lightbox").hidden) closeZoom();
});

/* ---------- each column ---------- */

function render() {
  sides.forEach((side) => {
    const made = generated[side.key];
    const working = busy[side.key];
    const result = el(`gn-result-${side.key}`);

    result.innerHTML = working
      ? `<div class="gn-placeholder is-working">${escapeHtml(working)}</div>`
      : made
        ? `<figure class="gn-made">
             <img src="${made}" alt="${escapeHtml(side.label)}">
             <figcaption>
               <button type="button" class="btn-tiny" data-act="zoom">Full size</button>
               <button type="button" class="btn-tiny" data-act="clear">Discard</button>
             </figcaption>
           </figure>`
        : `<div class="gn-placeholder">Not generated yet</div>`;

    result.querySelectorAll("[data-act]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.dataset.act === "zoom") zoom(made);
        else discard(side.key);
      }));

    const inputs = el(`gn-inputs-${side.key}`);
    if (!inputs) return;
    const all = inputsOf(side);
    const held = heldBack(side).length;

    // Numbered, because the order is not decoration: the model treats the
    // first image as the subject and weighs the rest after it.
    inputs.innerHTML = all.map((url, i) => {
      const label = i === 0 ? "Base — redrawn" : nameOf(url);
      return `
        <button type="button" class="gn-input${i === 0 ? " is-base" : ""}"
                data-url="${url}" title="${escapeHtml(label)} — click for full size">
          <img src="${url}" alt="">
          <span class="gn-input-n">${i + 1}</span>
          <span class="gn-input-name">${escapeHtml(label)}</span>
        </button>`;
    }).join("");

    inputs.querySelectorAll(".gn-input").forEach((button) =>
      button.addEventListener("click", () => zoom(button.dataset.url)));

    const count = el(`gn-count-${side.key}`);
    if (count) {
      count.textContent = held
        ? `— ${all.length} of ${all.length + held}, in this order`
        : `— all ${all.length}, in this order`;
    }
  });

  document.querySelectorAll(".gn-go").forEach((button) => {
    button.disabled = !!busy[button.dataset.side] ||
      !(sides.find((s) => s.key === button.dataset.side) || {}).base;
  });
}

/* ---------- the confirmation ---------- */

/* What a run will consist of, shown before it costs anything. The button used
   to fire straight into a paid minute-long call off the strength of a row of
   thumbnails, and the single biggest input -- the wording -- was not visible
   anywhere on the page. */

let pending = null;

/* Which references a side is sending. The ranking picks the first ten by
   default; swapping one out is the only way anything below the line gets in,
   because the ceiling is the model's and not ours. */
const picks = {};

function chosenFor(side) {
  if (!picks[side.key]) picks[side.key] = (side.references || []).slice();
  return picks[side.key];
}

/* Everything placed for this side that is not going. Named rather than
   counted: "the last 3 do not go" does not answer "where are my
   neighbours". */
function heldBack(side) {
  const chosen = chosenFor(side);
  return (side.all || []).filter((url) => !chosen.includes(url));
}

function inputsOf(side) {
  return [side.base, ...chosenFor(side)].filter(Boolean);
}

/* Click a held-back picture to send it. Something has to come out to make
   room, and it is the last one in -- the least important thing currently
   going, by the same ranking. */
function swapIn(side, url) {
  const chosen = chosenFor(side);
  if (chosen.length >= (side.limit || 9)) chosen.pop();
  chosen.push(url);
  picks[side.key] = chosen;
}

function swapOut(side, url) {
  picks[side.key] = chosenFor(side).filter((u) => u !== url);
}

function review(sideKey) {
  const side = sides.find((s) => s.key === sideKey);
  if (!side || !side.base) return;
  pending = sideKey;

  const all = inputsOf(side);
  const held = heldBack(side);
  el("gn-review-title").textContent = `Generate the ${side.label.toLowerCase()}`;
  el("gn-review-side").textContent = `— the ${side.key}`;
  el("gn-review-prompt").value = promptFor(sideKey);

  // The ceiling is the model's, so it is stated rather than hidden: someone
  // who filled every box should not have to wonder why nine went.
  el("gn-review-count").textContent = held.length
    ? `— ${all.length} of ${all.length + held.length}; the model takes `
      + `${all.length}`
    : `— all ${all.length}`;

  const model = document.querySelector('input[name="gn-model"]:checked');
  const label = model ? model.closest(".en-model").querySelector("strong") : null;
  el("gn-review-model").textContent = label
    ? `Model: ${label.textContent} — change it behind this box if that is wrong.`
    : "";

  el("gn-review-shots").innerHTML = all.map((url, i) => {
    const boxes = boxesOf(url);
    const name = i === 0 ? "Base — redrawn" : (boxes[0] || "Capture");
    // Said rather than hidden: the same picture in three boxes is still one
    // picture, and the count on the board will not match the count here.
    // The base says what it is doing, so its second line says where it came
    // from instead; the rest say how many other boxes hold the same picture,
    // because the board's count and this one will not match otherwise.
    const groups = groupsOf(url);
    const also = i === 0
      ? `<span class="gn-review-also">${escapeHtml(boxes[0] || "")}</span>`
      : groups.length > 1
        ? `<span class="gn-review-also">counts as ${
            escapeHtml(groups.join(" · "))}</span>`
        : "";
    return `
      <figure class="gn-review-shot${i === 0 ? " is-base" : ""}"
              data-url="${url}"
              title="${escapeHtml(boxes.join(" · ") || "Capture")}">
        <img src="${url}" alt="">
        ${i === 0 ? "" : `<button type="button" class="gn-review-drop"
             aria-label="Do not send this one">&times;</button>`}
        <figcaption><b>${i + 1}</b> ${escapeHtml(name)}${also}</figcaption>
      </figure>`;
  }).join("");

  // Below the line, by name, and clickable. The model's ten is a hard
  // ceiling, so this is a swap rather than an add -- but which ten is a
  // judgement, and it belongs to whoever filled the board.
  el("gn-review-held").hidden = !held.length;
  el("gn-review-held-list").innerHTML = held.map((url) => `
    <button type="button" class="gn-review-shot is-held" data-url="${url}"
            title="${escapeHtml(boxesOf(url).join(" · "))} — click to send this
instead of the last one">
      <img src="${url}" alt="">
      <figcaption>${escapeHtml(boxesOf(url)[0] || "Capture")}
        <span class="gn-review-also">click to send</span></figcaption>
    </button>`).join("");

  el("gn-review-shots").querySelectorAll(".gn-review-shot").forEach((fig, i) => {
    if (i === 0) return;  // the base is not a reference and cannot come out
    fig.querySelector(".gn-review-drop").addEventListener("click", (e) => {
      e.stopPropagation();
      swapOut(side, fig.dataset.url);
      review(sideKey);
    });
  });
  el("gn-review-held-list").querySelectorAll(".is-held").forEach((button) =>
    button.addEventListener("click", () => {
      swapIn(side, button.dataset.url);
      review(sideKey);
    }));

  el("gn-review").hidden = false;
}

function closeReview() {
  el("gn-review").hidden = true;
  pending = null;
}

el("gn-review-cancel").addEventListener("click", closeReview);
el("gn-review-reset").addEventListener("click", () => {
  if (pending) delete edits[pending];
  el("gn-review-prompt").value = promptFor(pending);
});
el("gn-review").addEventListener("click", (e) => {
  if (e.target.id === "gn-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("gn-review").hidden) closeReview();
});

el("gn-review-go").addEventListener("click", () => {
  const sideKey = pending;
  // Remembered before the box closes, so the next confirmation on this side
  // opens on the wording that just ran rather than throwing the edit away.
  const typed = el("gn-review-prompt").value.trim();
  if (typed) edits[sideKey] = typed; else delete edits[sideKey];
  closeReview();
  if (sideKey) generate(sideKey);
});

/* ---------- generating ---------- */

async function generate(sideKey) {
  busy[sideKey] = "Generating…";
  render();
  // Said out loud because it is not fast and it is not free: 4K on Pro takes
  // the better part of a minute and costs about a quarter.
  note("Generating through Atlas Cloud — a minute or two.");
  try {
    const res = await fetch(`/studio/api/leads/${lead}/generate-side`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        side: sideKey,
        model: (document.querySelector('input[name="gn-model"]:checked') || {}).value,
        prompt: promptFor(sideKey),
        references: chosenFor(sides.find((s) => s.key === sideKey) || {}),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that didn't generate");
    generated = body.generated || {};
    note("Done. Discard it and run again if it came out wrong.");
  } catch (err) {
    note(err.message);
  }
  delete busy[sideKey];
  render();
}

document.querySelectorAll(".gn-go").forEach((button) =>
  button.addEventListener("click", () => review(button.dataset.side)));

/* ---------- bringing the shot back ---------- */

/* A shot made somewhere else. Uploaded through the same endpoint the rest of
   the app uses, so it lands beside the listing's images rather than in a
   second place with its own rules, then filed against this side. */
async function receive(sideKey, file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { note("That isn't an image."); return; }

  busy[sideKey] = "Adding…";
  render();
  note("");
  try {
    const form = new FormData();
    form.append("photos", file);
    const up = await fetch("/studio/api/upload", { method: "POST", body: form });
    const saved = await up.json();
    if (!up.ok) throw new Error(saved.error || "that image couldn't be saved");
    const url = (saved.photos || [])[0];
    // Uploads are de-duplicated by image hash, so the same file twice comes
    // back with nothing rather than an error.
    if (!url) throw new Error("that image is already on this listing");

    const res = await fetch(`/studio/api/leads/${lead}/generate-side`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: sideKey, image: url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that shot couldn't be filed");
    generated = body.generated || {};
    note(`The ${sideKey} shot is in. The drone stage will fly from it.`);
  } catch (err) {
    note(err.message);
  }
  delete busy[sideKey];
  render();
}

document.querySelectorAll(".gn-file").forEach((input) =>
  input.addEventListener("change", (e) => {
    receive(input.dataset.side, e.target.files[0]);
    input.value = "";
  }));

async function discard(sideKey) {
  try {
    const res = await fetch(`/studio/api/leads/${lead}/generate-side`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: sideKey }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't discard that");
    generated = body.generated || {};
  } catch (err) {
    note(err.message);
  }
  render();
}

render();
