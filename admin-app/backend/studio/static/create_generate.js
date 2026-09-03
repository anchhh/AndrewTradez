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

let generated = window.__GENERATED__ || {};

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
    inputs.innerHTML = all.map((url, i) => `
      <button type="button" class="gn-input${i === 0 ? " is-base" : ""}"
              data-url="${url}">
        <img src="${url}" alt="">
        <span>${i === 0 ? "Base" : escapeHtml(nameOf(url))}</span>
      </button>`).join("");
    inputs.querySelectorAll(".gn-input").forEach((button) =>
      button.addEventListener("click", () => zoom(button.dataset.url)));
  });

  document.querySelectorAll(".gn-go").forEach((button) => {
    button.disabled = !!busy[button.dataset.side] ||
      !(sides.find((s) => s.key === button.dataset.side) || {}).base;
  });
}

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
  button.addEventListener("click", () => generate(button.dataset.side)));

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
