/* The generate stage: two shots, the front and the back.

   A flight starts on one and lands on the other, so those are the two
   pictures worth making. Everything placed on the board at stage 2 exists to
   make them right: the oblique is what each is built ON, the rest of that
   side is reference, and the neighbours go into both because a house gets
   rebuilt in its street and a model with nothing to go on for either side
   invents the street as well.

   Google Flow is offered per side rather than integrated. It has no public
   API and no URL that pre-fills a prompt or attaches an image, so what the
   button does is the three things that can honestly be done: copy the
   prompt, download that side's images in order, open Flow. */

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

function modelChoice() {
  return (document.querySelector('input[name="en-model"]:checked') || {}).value;
}

async function generate(sideKey) {
  busy[sideKey] = "Generating…";
  render();
  note("This takes ten or twenty seconds.");
  try {
    const res = await fetch(`/studio/api/leads/${lead}/generate-side`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: sideKey, model: modelChoice() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that didn't generate");
    generated = body.generated || {};
    note("");
  } catch (err) {
    note(err.message);
  }
  delete busy[sideKey];
  render();
}

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

document.querySelectorAll(".gn-go").forEach((button) =>
  button.addEventListener("click", () => generate(button.dataset.side)));

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
