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

const defaultPrompt = window.__PROMPT__ || "";

let generated = window.__GENERATED__ || {};
/* One prompt, shared by both columns: it is the same job twice, and having
   edited it for the front only to find the back still on the old wording is
   a trap rather than a feature. Lives for the visit -- an edit is a thing
   you are trying, not a setting. */
let prompt = defaultPrompt;

const el = (id) => document.getElementById(id);
const note = (text) => { el("gn-note").textContent = text || ""; };
const busy = {};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* What a picture is, from the box it was placed in at stage 2. */
function nameOf(url) {
  const slot = Object.keys(slots).find((key) => (slots[key] || []).includes(url));
  return shotLabels[slot] || "Capture";
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
    const all = [side.base, ...(side.references || [])].filter(Boolean);

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
      count.textContent = `— all ${all.length}, in this order`;
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

function inputsOf(side) {
  return [side.base, ...(side.references || [])].filter(Boolean);
}

function review(sideKey) {
  const side = sides.find((s) => s.key === sideKey);
  if (!side || !side.base) return;
  pending = sideKey;

  const all = inputsOf(side);
  el("gn-review-title").textContent = `Generate the ${side.label.toLowerCase()}`;
  el("gn-review-prompt").value = prompt;
  el("gn-review-count").textContent = `— all ${all.length}`;

  const model = document.querySelector('input[name="gn-model"]:checked');
  const label = model ? model.closest(".en-model").querySelector("strong") : null;
  el("gn-review-model").textContent = label
    ? `Model: ${label.textContent} — change it behind this box if that is wrong.`
    : "";

  el("gn-review-shots").innerHTML = all.map((url, i) => {
    const name = i === 0 ? "Base — redrawn" : nameOf(url);
    return `
      <figure class="gn-review-shot${i === 0 ? " is-base" : ""}">
        <img src="${url}" alt="">
        <figcaption><b>${i + 1}</b> ${escapeHtml(name)}</figcaption>
      </figure>`;
  }).join("");

  el("gn-review").hidden = false;
}

function closeReview() {
  el("gn-review").hidden = true;
  pending = null;
}

el("gn-review-cancel").addEventListener("click", closeReview);
el("gn-review-reset").addEventListener("click", () => {
  el("gn-review-prompt").value = defaultPrompt;
});
el("gn-review").addEventListener("click", (e) => {
  if (e.target.id === "gn-review") closeReview();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("gn-review").hidden) closeReview();
});

el("gn-review-go").addEventListener("click", () => {
  const sideKey = pending;
  // Remembered before the box closes, so the next confirmation opens on the
  // wording that just ran rather than throwing the edit away.
  prompt = el("gn-review-prompt").value.trim() || defaultPrompt;
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
        prompt: prompt,
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
