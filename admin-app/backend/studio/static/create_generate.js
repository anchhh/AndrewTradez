/* The generate stage: two shots, the front and the back, both made in
   Google Flow.

   Flow cannot be automated. It has no public API and no URL that pre-fills a
   prompt or attaches an image, so this page does the two halves that CAN be
   done: hand a side over -- prompt copied, that side's images downloaded in
   order, Flow opened -- and take the result back afterwards.

   Everything placed on the board at stage 2 feeds one of the two columns:
   the oblique first, because it already looks like a photograph taken from
   the air, then the rest of that side, then the neighbours, which go into
   BOTH columns because a house is rebuilt in its street.

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
        : `<div class="gn-placeholder">Nothing back from Flow yet</div>`;

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

  document.querySelectorAll(".gn-flow").forEach((button) => {
    button.disabled = !!busy[button.dataset.side] ||
      !(sides.find((s) => s.key === button.dataset.side) || {}).base;
  });
}

/* The shot Flow made, brought back. Uploaded through the same endpoint the
   rest of the app uses, so it lands beside the listing's images rather than
   in a second place with its own rules, then filed against this side. */
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

/* ---------- handing one side to Google Flow ---------- */

async function toFlow(side) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(window.__PROMPT__ || "");
    copied = true;
  } catch (err) {
    // Clipboard access can be refused; the prompt is in the zip either way.
  }

  // Fetched as a blob rather than navigated to: pointing the window at the
  // endpoint works right up until the session has expired, at which point
  // the "download" is a redirect to the login page and this page is gone.
  note(`Bundling the ${side} set…`);
  try {
    const res = await fetch(`/studio/api/leads/${lead}/flow-bundle?side=${side}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `couldn't build the ${side} set`);
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = (res.headers.get("Content-Disposition") || "")
      .split("filename=").pop().replace(/"/g, "") || `${side}-flow.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  } catch (err) {
    note(err.message);
    return;
  }

  window.open(window.__FLOW_URL__, "_blank", "noopener");
  note(copied
    ? `Prompt copied and the ${side} set downloaded. Flow is open — drop the ` +
      `images in and paste the prompt.`
    : `The ${side} set downloaded. Flow is open; the prompt is in prompt.txt ` +
      `inside the zip.`);
}

document.querySelectorAll(".gn-flow").forEach((button) =>
  button.addEventListener("click", () => toFlow(button.dataset.side)));

render();
