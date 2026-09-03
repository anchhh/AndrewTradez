/* Stage 3: correcting the photographs.

   Each photo is judged on its own request. A listing is thirty photographs
   and each is a separate call to Google, so one request for the lot would
   hold a connection open for a minute and lose everything on a timeout --
   this way the grid fills in as the answers arrive and a failure costs one
   picture rather than the run.

   What comes back is numbers, not a new image: the correction is applied
   here to the real pixels. So "before" and "after" are the same photograph
   at two settings, and the toggle is worth having because the difference is
   often small. Small is the point. */

const lead = window.__LEAD__;
const photos = window.__PHOTOS__ || [];
const rooms = window.__ROOMS__ || {};
const enhanced = window.__ENHANCED__ || {};

const el = (id) => document.getElementById(id);
const note = (text) => { el("en-note").textContent = text || ""; };
const state = {};   // {url: {busy, note, error}}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function roomLabel(url) {
  const entry = rooms[url];
  const label = entry && typeof entry === "object" ? entry.label : entry;
  return label || "Unsorted";
}

function render() {
  el("en-grid").innerHTML = photos.map((url, i) => {
    const done = enhanced[url];
    const info = state[url] || {};
    return `
      <figure class="en-item${done ? " is-done" : ""}" data-url="${url}">
        <div class="en-shot">
          <img src="${done || url}" alt="${escapeHtml(roomLabel(url))}"
               data-before="${url}" data-after="${done || ""}">
          ${done ? `<span class="en-flag">Corrected</span>` : ""}
          ${info.busy ? `<span class="en-busy">Reading…</span>` : ""}
        </div>
        <figcaption>
          <span class="en-room">${escapeHtml(roomLabel(url))}</span>
          <span class="en-note${info.error ? " is-warn" : ""}">${escapeHtml(
            info.error || info.note || "")}</span>
          <span class="en-buttons">
            ${done
              ? `<button type="button" class="btn-tiny" data-act="hold">Hold to compare</button>
                 <button type="button" class="btn-secondary btn-tiny" data-act="revert">Revert</button>`
              : `<button type="button" class="btn-secondary btn-tiny" data-act="enhance"
                         ${info.busy ? "disabled" : ""}>Check this photo</button>`}
          </span>
        </figcaption>
      </figure>`;
  }).join("");

  el("en-grid").querySelectorAll("button").forEach((button) => {
    const url = button.closest(".en-item").dataset.url;
    const act = button.dataset.act;
    if (act === "enhance") button.addEventListener("click", () => enhance(url));
    if (act === "revert") button.addEventListener("click", () => revert(url));
    if (act === "hold") holdToCompare(button);
  });
}

/* Press and hold shows the original. A slider would be prettier and this is
   one gesture that cannot be misread -- what you see while holding is what
   the camera saw. */
function holdToCompare(button) {
  const img = button.closest(".en-item").querySelector("img");
  const show = (which) => { img.src = img.dataset[which] || img.dataset.before; };
  ["mousedown", "touchstart"].forEach((e) =>
    button.addEventListener(e, () => show("before")));
  ["mouseup", "mouseleave", "touchend"].forEach((e) =>
    button.addEventListener(e, () => show("after")));
}

async function enhance(url) {
  state[url] = { busy: true };
  render();
  try {
    const res = await fetch(`/studio/api/leads/${lead}/enhance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "that photo couldn't be read");

    if (body.enhanced) {
      enhanced[url] = body.enhanced;
      state[url] = { note: body.note };
    } else {
      // Judged and found to need nothing. Said out loud, because a photo that
      // silently stays the same looks like a button that did not work.
      delete enhanced[url];
      state[url] = { note: body.note || "Nothing to correct." };
    }
  } catch (err) {
    state[url] = { error: err.message };
  }
  render();
}

async function revert(url) {
  try {
    await fetch(`/studio/api/leads/${lead}/enhance/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: url }),
    });
    delete enhanced[url];
    state[url] = { note: "Back to the original." };
  } catch (err) {
    state[url] = { error: err.message };
  }
  render();
}

/* One at a time, deliberately. Thirty parallel requests is how a free tier
   starts returning 429s, and the grid filling in steadily reads as progress
   where thirty spinners read as a hang. */
el("en-all").addEventListener("click", async () => {
  const button = el("en-all");
  button.disabled = true;
  const todo = photos.filter((url) => !enhanced[url]);
  let corrected = 0;
  for (let i = 0; i < todo.length; i += 1) {
    note(`Reading ${i + 1} of ${todo.length}…`);
    await enhance(todo[i]);
    if (enhanced[todo[i]]) corrected += 1;
  }
  note(corrected
    ? `${corrected} of ${todo.length} needed correcting.`
    : `All ${todo.length} were already right.`);
  button.disabled = false;
});

render();
