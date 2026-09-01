/* Shared lead-UI helpers used by the Dashboard, Lead Manager and lead
   profile. Plain globals rather than ES modules, matching the rest of
   Studio's static JS. Loaded before each page's own script. */

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const isVideoUrl = (url) => VIDEO_EXT.test(url);

const LEAD_STATUSES = ["new", "contacted", "responded", "converted", "dead"];

const OUTREACH_KEY = {
  email: "outreach_email_sent",
  phone: "outreach_phone_called",
  video: "outreach_video_sent",
};

const SOURCE_DOMAINS = {
  zillow: "zillow.com",
  realtor: "realtor.com",
  redfin: "redfin.com",
  homes: "homes.com",
};

// Display order and labels for the status groups, most-actionable first.
const STATUS_GROUPS = {
  responded: { icon: "🔥", label: "Hot Lead", className: "group-hot" },
  new: { icon: "🆕", label: "New Lead", className: "group-new" },
  contacted: { icon: "📨", label: "Contacted", className: "group-contacted" },
  converted: { icon: "✅", label: "Converted", className: "group-converted" },
  dead: { icon: "📦", label: "Cold Lead", className: "group-cold" },
};
const GROUP_ORDER = ["responded", "new", "contacted", "converted", "dead"];

const groupKeyFor = (lead) => (STATUS_GROUPS[lead.status] ? lead.status : "new");

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function sourceBadgeHtml(source) {
  const domain = SOURCE_DOMAINS[source];
  const icon = domain
    ? `<img class="source-icon" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="">`
    : "";
  return `<span class="badge badge-source">${icon}${escapeHtml(source || "—")}</span>`;
}

function checklistToggleHtml(lead, field, label) {
  const checked = !!lead[OUTREACH_KEY[field]];
  return `<button type="button" class="lm-check-toggle ${checked ? "checked" : "unchecked"}" data-field="${field}">
    <span class="lm-check-icon">${checked ? "✔" : "✕"}</span>${label}
  </button>`;
}

function thumbHtml(url) {
  if (!url) return `<div class="lm-thumb-empty">No photo</div>`;
  return isVideoUrl(url)
    ? `<video src="${escapeHtml(url)}" muted></video>`
    : `<img src="${escapeHtml(url)}" alt="">`;
}

function addressLine(lead) {
  const cityStateZip = [
    [lead.city, lead.state].filter(Boolean).join(", "),
    lead.zip_code,
  ]
    .filter(Boolean)
    .join(" ");
  return (lead.address || "—") + (cityStateZip ? `, ${cityStateZip}` : "");
}

function contactLine(lead) {
  return [lead.agent_name, lead.agent_phone, lead.agent_email].filter(Boolean).join(" | ");
}

function brokerageLine(lead) {
  return lead.brokerage || "";
}

function factsLine(lead) {
  return [
    lead.beds != null ? `${lead.beds} bd` : null,
    lead.baths != null ? `${lead.baths} ba` : null,
    lead.sqft != null ? `${lead.sqft.toLocaleString()} sqft` : null,
  ]
    .filter(Boolean)
    .join(" • ");
}

/* Makes a whole row open the lead's profile, while leaving the controls
   inside it usable -- a click on a button, link, select or textarea is the
   user operating that control, not asking to navigate. Also ignores a click
   that ends a text selection. */
const INTERACTIVE = "a, button, select, input, textarea, label, option";

function makeRowOpenProfile(row, leadId) {
  row.classList.add("is-clickable");
  row.tabIndex = 0;
  row.setAttribute("role", "link");

  const go = () => {
    window.location.href = `/studio/leads/${leadId}`;
  };

  row.addEventListener("click", (e) => {
    if (e.target.closest(INTERACTIVE)) return;
    if (String(window.getSelection())) return;
    go();
  });

  row.addEventListener("keydown", (e) => {
    if (e.target !== row) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
}

/* Debounced autosave for a lead's notes box. Saves 700ms after typing
   stops, flushes on blur, and falls back to sendBeacon on unload so
   navigating away mid-pause never loses the text. */
function attachNotes(textarea, leadId, stateEl) {
  let timer = null;
  let lastSaved = textarea.value;

  const setState = (text) => {
    if (stateEl) stateEl.textContent = text;
  };

  const save = async () => {
    const value = textarea.value;
    if (value === lastSaved) return;
    setState("Saving…");
    try {
      await fetch(`/studio/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: value }),
      });
      lastSaved = value;
      setState("Saved");
    } catch (err) {
      setState("Couldn't save — your text is still here, try again.");
    }
  };

  textarea.addEventListener("input", () => {
    setState("");
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  });

  textarea.addEventListener("blur", () => {
    clearTimeout(timer);
    save();
  });

  window.addEventListener("beforeunload", () => {
    if (textarea.value !== lastSaved) {
      navigator.sendBeacon?.(
        `/studio/api/leads/${leadId}`,
        new Blob([JSON.stringify({ notes: textarea.value })], { type: "application/json" })
      );
    }
  });
}

/* ---------------------------------------------------------------
   Lead card -- the single presentation of a lead, shared by the
   Dashboard and the Lead Manager so the two pages can't drift apart.

   opts:
     showStatusSelect  status dropdown in the actions column
     showQualify       Mark Qualified button
     showNotes         notes box in the card footer
     project           linked project, if any (changes the video label)
   --------------------------------------------------------------- */

function leadCardHtml(lead, opts = {}) {
  const meta = STATUS_GROUPS[groupKeyFor(lead)];
  const project = opts.project || null;
  const photo = (project && (project.photos || [])[0]) || (lead.photo_urls || [])[0] || null;

  const statusSelect = opts.showStatusSelect
    ? `<select class="lead-status-select" aria-label="Lead status">${LEAD_STATUSES.map(
        (s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`
      ).join("")}</select>`
    : "";

  const qualify = opts.showQualify
    ? `<button type="button" class="btn-secondary btn-tiny lm-qualify-btn ${lead.qualified ? "is-qualified" : ""}">
         ${lead.qualified ? "Qualified ✓" : "Mark Qualified"}
       </button>`
    : "";

  const notes = opts.showNotes
    ? `<footer class="lead-card-notes">
         <textarea class="lm-notes-input" rows="2" placeholder="notes"></textarea>
         <div class="lm-notes-state"></div>
       </footer>`
    : "";

  return `
    <article class="lead-card ${meta.className}">
      <header class="lead-card-head">
        <label class="lead-card-select" title="Select this lead">
          <input type="checkbox" class="lead-select-box" ${selectedLeadIds.has(lead.id) ? "checked" : ""}>
        </label>
        <span class="lead-card-status">${meta.icon} ${meta.label.toUpperCase()}</span>
        ${sourceBadgeHtml(lead.source)}
      </header>
      <div class="lead-card-body">
        <div class="lead-card-media">${photo
          ? `<button type="button" class="lead-card-media-btn" title="View photos">${thumbHtml(photo)}</button>`
          : thumbHtml(photo)}</div>
        <div class="lead-card-info">
          <h3 class="lead-card-address">${escapeHtml(addressLine(lead))}</h3>
          ${contactLine(lead) ? `<div class="lead-card-contact">${escapeHtml(contactLine(lead))}</div>` : ""}
          ${brokerageLine(lead) ? `<div class="lead-card-facts">${escapeHtml(brokerageLine(lead))}</div>` : ""}
          ${factsLine(lead) ? `<div class="lead-card-facts">${factsLine(lead)}</div>` : ""}
          ${lead.listing_url ? `<a class="lead-card-url" href="${escapeHtml(lead.listing_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.listing_url)}</a>` : ""}
        </div>
        <div class="lead-card-checklist">
          ${checklistToggleHtml(lead, "email", "Email sent")}
          ${checklistToggleHtml(lead, "phone", "Phone called")}
          ${checklistToggleHtml(lead, "video", "Video made")}
        </div>
        <div class="lead-card-actions">
          ${statusSelect}
          ${lead.agent_name
            ? `<button type="button" class="link-btn lead-find-email">${
                lead.agent_email ? "Check email" : "Find email"
              }</button>`
            : ""}
          ${qualify}
          <a class="link-btn" href="/studio/create?lead_id=${lead.id}">${project ? "Open Video" : "Create Video"}</a>
          <button class="icon-btn lm-delete-btn" title="Delete lead">&times;</button>
        </div>
      </div>
      <div class="lead-card-candidates hidden"></div>
      ${notes}
    </article>`;
}

/* Wires a rendered card. `handlers` may supply onChanged (called after any
   update, so a filtered list can re-evaluate) and onDeleted. */
function wireLeadCard(card, lead, handlers = {}) {
  const changed = () => handlers.onChanged && handlers.onChanged(lead);

  makeRowOpenProfile(card.querySelector(".lead-card-body"), lead.id);

  // The thumbnail opens the whole gallery rather than the profile. It is a
  // button, so makeRowOpenProfile's interactive-element check skips it and no
  // event needs stopping.
  const media = card.querySelector(".lead-card-media-btn");
  if (media) {
    media.addEventListener("click", () => {
      openLightbox(lead.photo_urls || [], 0, lead.photo_rooms || null);
    });
  }

  const box = card.querySelector(".lead-select-box");
  if (box) {
    card.classList.toggle("is-selected", selectedLeadIds.has(lead.id));
    box.addEventListener("change", () => {
      if (box.checked) selectedLeadIds.add(lead.id);
      else selectedLeadIds.delete(lead.id);
      card.classList.toggle("is-selected", box.checked);
      if (handlers.onSelectionChange) handlers.onSelectionChange();
    });
  }

  card.querySelectorAll(".lm-check-toggle").forEach((el) => {
    el.addEventListener("click", async () => {
      const field = el.dataset.field;
      const updated = await fetchJSON(`/studio/api/leads/${lead.id}/outreach`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field }),
      });
      Object.assign(lead, updated);
      const checked = !!updated[OUTREACH_KEY[field]];
      el.classList.toggle("checked", checked);
      el.classList.toggle("unchecked", !checked);
      el.querySelector(".lm-check-icon").textContent = checked ? "✔" : "✕";
      changed();
    });
  });

  const select = card.querySelector(".lead-status-select");
  if (select) {
    select.addEventListener("change", async (e) => {
      const updated = await fetchJSON(`/studio/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: e.target.value }),
      });
      Object.assign(lead, updated);
      changed();
    });
  }

  const qualify = card.querySelector(".lm-qualify-btn");
  if (qualify) {
    qualify.addEventListener("click", async () => {
      const updated = await fetchJSON(`/studio/api/leads/${lead.id}/qualify`, { method: "PATCH" });
      Object.assign(lead, updated);
      qualify.textContent = updated.qualified ? "Qualified ✓" : "Mark Qualified";
      qualify.classList.toggle("is-qualified", !!updated.qualified);
      changed();
    });
  }

  card.querySelector(".lm-delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete the lead at ${lead.address || "this address"}?`)) return;
    await fetch(`/studio/api/leads/${lead.id}`, { method: "DELETE" });
    if (handlers.onDeleted) handlers.onDeleted(lead);
  });

  wireFindEmail(card, lead, handlers);

  const notes = card.querySelector(".lm-notes-input");
  if (notes) {
    notes.value = lead.notes || "";
    attachNotes(notes, lead.id, card.querySelector(".lm-notes-state"));
  }
}

function buildLeadCard(lead, opts = {}, handlers = {}) {
  const host = document.createElement("div");
  host.innerHTML = leadCardHtml(lead, opts);
  const card = host.firstElementChild;
  wireLeadCard(card, lead, handlers);
  return card;
}


/* ---------------------------------------------------------------
   Bulk selection

   selectedLeadIds is module state so a re-render (a filter change, a
   status edit) can restore the ticks it just threw away. It is pruned to
   the leads actually on screen on every render -- selecting a lead, then
   filtering it out of view, then hitting Delete should not delete
   something the user can no longer see.
   --------------------------------------------------------------- */

const selectedLeadIds = new Set();

function pruneSelection(visibleLeads) {
  const visible = new Set(visibleLeads.map((l) => l.id));
  [...selectedLeadIds].forEach((id) => {
    if (!visible.has(id)) selectedLeadIds.delete(id);
  });
}

async function bulkAction(action, value) {
  return fetchJSON("/studio/api/leads/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [...selectedLeadIds], action, value }),
  });
}

/* Renders the bulk toolbar into `host` and returns a refresh() to call
   whenever the selection or the visible list changes. `reload` re-fetches
   the page's data after an action lands. */
function initBulkBar(host, { getVisibleLeads, reload }) {
  host.innerHTML = `
    <div class="bulk-bar hidden">
      <label class="bulk-all">
        <input type="checkbox" class="bulk-all-box">
        <span class="bulk-all-label">Select all</span>
      </label>
      <span class="bulk-count"></span>
      <div class="bulk-actions">
        <select class="bulk-status" aria-label="Move selected to status">
          <option value="">Move to…</option>
          ${LEAD_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join("")}
        </select>
        <button type="button" class="btn-secondary btn-tiny bulk-qualify">Mark qualified</button>
        <button type="button" class="btn-secondary btn-tiny bulk-unqualify">Unqualify</button>
        <button type="button" class="btn-secondary btn-tiny bulk-delete">Delete</button>
        <button type="button" class="btn-secondary btn-tiny bulk-clear">Clear</button>
      </div>
      <span class="bulk-state"></span>
    </div>`;

  const bar = host.querySelector(".bulk-bar");
  const allBox = host.querySelector(".bulk-all-box");
  const count = host.querySelector(".bulk-count");
  const state = host.querySelector(".bulk-state");
  const statusSelect = host.querySelector(".bulk-status");

  const refresh = () => {
    const visible = getVisibleLeads();
    const n = selectedLeadIds.size;
    bar.classList.toggle("has-selection", n > 0);
    bar.classList.toggle("hidden", visible.length === 0);
    count.textContent = n ? `${n} selected` : "";
    allBox.checked = n > 0 && n === visible.length;
    allBox.indeterminate = n > 0 && n < visible.length;
    host.querySelectorAll(".bulk-actions button, .bulk-status").forEach((el) => {
      el.disabled = n === 0;
    });
  };

  const run = async (label, fn) => {
    state.textContent = label;
    try {
      const res = await fn();
      state.textContent = res && res.error ? res.error : "";
      selectedLeadIds.clear();
      await reload();
    } catch (err) {
      state.textContent = "That didn't go through — nothing was changed.";
    }
  };

  allBox.addEventListener("change", () => {
    const visible = getVisibleLeads();
    selectedLeadIds.clear();
    if (allBox.checked) visible.forEach((l) => selectedLeadIds.add(l.id));
    reload({ keepSelection: true });
  });

  statusSelect.addEventListener("change", async () => {
    const value = statusSelect.value;
    if (!value) return;
    statusSelect.value = "";
    await run(`Moving ${selectedLeadIds.size}…`, () => bulkAction("status", value));
  });

  host.querySelector(".bulk-qualify").addEventListener("click", () =>
    run(`Qualifying ${selectedLeadIds.size}…`, () => bulkAction("qualify", true))
  );
  host.querySelector(".bulk-unqualify").addEventListener("click", () =>
    run(`Unqualifying ${selectedLeadIds.size}…`, () => bulkAction("qualify", false))
  );

  host.querySelector(".bulk-delete").addEventListener("click", async () => {
    const n = selectedLeadIds.size;
    if (!n) return;
    if (!confirm(`Delete ${n} lead${n === 1 ? "" : "s"}? This can't be undone.`)) return;
    await run(`Deleting ${n}…`, () => bulkAction("delete"));
  });

  host.querySelector(".bulk-clear").addEventListener("click", () => {
    selectedLeadIds.clear();
    reload({ keepSelection: true });
  });

  return refresh;
}

/* ---------------------------------------------------------------
   Finding an agent's email, in the app.

   The research runs on the backend -- search, open the results, read the
   addresses off the pages -- and comes back ranked with the reason for each.
   Nothing is written until one is chosen: a wrong address means a stranger
   gets the first approach about someone else's listing.
   --------------------------------------------------------------- */

function sourceHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return "unknown";
  }
}

function candidateRowHtml(candidate, index, currentEmail) {
  const inUse = candidate.email === currentEmail;
  return `
    <div class="lead-candidate ${candidate.confident ? "is-confident" : ""}">
      <div class="lead-candidate-top">
        <span class="lead-candidate-rank">${index + 1}</span>
        <span class="lead-candidate-email">${escapeHtml(candidate.email)}</span>
        ${candidate.confident ? '<span class="lead-candidate-badge">confident</span>' : ""}
        ${
          inUse
            ? '<span class="lead-candidate-badge is-inuse">in use</span>'
            : `<button type="button" class="btn-secondary btn-tiny lead-candidate-use" data-email="${escapeHtml(candidate.email)}">Use this</button>`
        }
      </div>
      ${(candidate.supports || []).length
        ? `<ul class="lead-candidate-why for">${candidate.supports
            .map((r) => `<li>${escapeHtml(r)}</li>`)
            .join("")}</ul>`
        : ""}
      ${(candidate.concerns || []).length
        ? `<ul class="lead-candidate-why against">${candidate.concerns
            .map((r) => `<li>${escapeHtml(r)}</li>`)
            .join("")}</ul>`
        : ""}
      <div class="lead-candidate-source">source: ${escapeHtml(sourceHost(candidate.source))}</div>
    </div>`;
}

function wireFindEmail(card, lead, handlers) {
  const button = card.querySelector(".lead-find-email");
  const box = card.querySelector(".lead-card-candidates");
  if (!button || !box) return;

  const show = (candidates, message) => {
    box.classList.remove("hidden");
    const list = candidates || [];
    box.innerHTML =
      (message ? `<p class="lead-candidates-note">${escapeHtml(message)}</p>` : "") +
      list.map((c, i) => candidateRowHtml(c, i, lead.agent_email)).join("");

    box.querySelectorAll(".lead-candidate-use").forEach((use) => {
      use.addEventListener("click", async () => {
        use.disabled = true;
        const updated = await fetchJSON(`/studio/api/leads/${lead.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_email: use.dataset.email }),
        });
        Object.assign(lead, updated);
        if (handlers.onChanged) handlers.onChanged(lead);
        show(list, message);
      });
    });
  };

  // Anything a previous run already found shows without asking again.
  if ((lead.email_candidates || []).length) show(lead.email_candidates, null);

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Searching…";
    try {
      const found = await fetchJSON(`/studio/api/leads/${lead.id}/find-email`, { method: "POST" });
      if (found.error) throw new Error(found.error);
      lead.email_candidates = found.candidates || [];
      show(
        lead.email_candidates,
        found.blocked
          ? "The search is rate limiting us right now - worth trying again in a few minutes."
          : lead.email_candidates.length
          ? null
          : "Nothing published for this agent was found."
      );
    } catch (err) {
      show([], err.message || "Search failed.");
    }
    button.disabled = false;
    button.textContent = "Find email";
  });
}

/* ---------------------------------------------------------------
   Fullscreen photo viewer

   Shared by the Lead Manager, the Dashboard and the lead profile, so a
   photo behaves the same wherever it is clicked. One overlay is built
   once and reused; opening it is just handing it a list and a starting
   index.

   Room labels, where a lead has them, are shown alongside the counter --
   the sorting work is only useful if it is visible where the photos are.
   --------------------------------------------------------------- */

let lightboxState = null;

function ensureLightbox() {
  let box = document.getElementById("photo-lightbox");
  if (box) return box;

  box = document.createElement("div");
  box.id = "photo-lightbox";
  box.className = "lightbox hidden";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = `
    <div class="lightbox-backdrop" data-lb-close></div>
    <button type="button" class="lightbox-x" data-lb-close aria-label="Close">&times;</button>
    <button type="button" class="lightbox-nav lightbox-prev" data-lb-prev aria-label="Previous">&#8249;</button>
    <figure class="lightbox-stage">
      <div class="lightbox-media"></div>
      <figcaption class="lightbox-caption">
        <span class="lightbox-count"></span>
        <span class="lightbox-room"></span>
      </figcaption>
    </figure>
    <button type="button" class="lightbox-nav lightbox-next" data-lb-next aria-label="Next">&#8250;</button>
    <nav class="lightbox-rooms" aria-label="Jump to a room"></nav>
    <div class="lightbox-strip"></div>`;
  document.body.appendChild(box);

  box.querySelectorAll("[data-lb-close]").forEach((n) =>
    n.addEventListener("click", closeLightbox));
  box.querySelector("[data-lb-prev]").addEventListener("click", () => stepLightbox(-1));
  box.querySelector("[data-lb-next]").addEventListener("click", () => stepLightbox(1));

  document.addEventListener("keydown", (e) => {
    if (!lightboxState) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "ArrowRight") stepLightbox(1);
  });

  // Wheel and swipe, so "scroll through" works the way it reads.
  let wheelLock = 0;
  box.addEventListener("wheel", (e) => {
    if (!lightboxState) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 220) return;      // one photo per gesture, not fifty
    wheelLock = now;
    stepLightbox(Math.sign(e.deltaY || e.deltaX));
  }, { passive: false });

  let touchX = null;
  box.addEventListener("touchstart", (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
  box.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) stepLightbox(dx < 0 ? 1 : -1);
    touchX = null;
  }, { passive: true });

  return box;
}

function renderLightbox() {
  const box = ensureLightbox();
  const { photos, index, rooms } = lightboxState;
  const url = photos[index];

  box.querySelector(".lightbox-media").innerHTML = isVideoUrl(url)
    ? `<video src="${escapeHtml(url)}" controls autoplay muted></video>`
    : `<img src="${escapeHtml(url)}" alt="">`;

  box.querySelector(".lightbox-count").textContent = `${index + 1} / ${photos.length}`;
  const room = rooms && rooms[url];
  box.querySelector(".lightbox-room").textContent = room ? room.label : "";

  const single = photos.length < 2;
  box.querySelector(".lightbox-prev").hidden = single;
  box.querySelector(".lightbox-next").hidden = single;

  const nav = box.querySelector(".lightbox-rooms");
  const order = [];
  const counts = {};
  const firstIndex = {};
  photos.forEach((u, i) => {
    const entry = rooms && rooms[u];
    const key = entry ? entry.room : "unsorted";
    if (!(key in counts)) {
      counts[key] = 0;
      firstIndex[key] = i;
      order.push({ key, label: entry ? entry.label : "Unsorted" });
    }
    counts[key] += 1;
  });

  // Only worth showing when there is more than one room to move between.
  if (order.length > 1) {
    const currentEntry = rooms && rooms[url];
    const currentKey = currentEntry ? currentEntry.room : "unsorted";
    nav.hidden = false;
    nav.innerHTML = order.map((r) => `
      <button type="button" class="lightbox-room-chip ${r.key === currentKey ? "is-active" : ""}"
              data-i="${firstIndex[r.key]}">
        ${escapeHtml(r.label)} <span class="lightbox-chip-count">${counts[r.key]}</span>
      </button>`).join("");
    nav.querySelectorAll(".lightbox-room-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        lightboxState.index = Number(btn.dataset.i);
        renderLightbox();
      });
    });
    const activeChip = nav.querySelector(".is-active");
    if (activeChip) activeChip.scrollIntoView({ block: "nearest", inline: "center" });
  } else {
    nav.hidden = true;
    nav.innerHTML = "";
  }

  const strip = box.querySelector(".lightbox-strip");
  strip.innerHTML = photos.map((u, i) => `
    <button type="button" class="lightbox-thumb ${i === index ? "is-active" : ""}" data-i="${i}">
      ${isVideoUrl(u) ? `<video src="${escapeHtml(u)}" muted></video>`
                      : `<img src="${escapeHtml(u)}" alt="" loading="lazy">`}
    </button>`).join("");
  strip.querySelectorAll(".lightbox-thumb").forEach((btn) => {
    btn.addEventListener("click", () => {
      lightboxState.index = Number(btn.dataset.i);
      renderLightbox();
    });
  });
  const active = strip.querySelector(".is-active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
}

function stepLightbox(direction) {
  if (!lightboxState || !direction) return;
  const n = lightboxState.photos.length;
  // Wraps, so the end of a 57-photo gallery isn't a dead stop.
  lightboxState.index = (lightboxState.index + direction + n) % n;
  renderLightbox();
}

function openLightbox(photos, index = 0, rooms = null) {
  const list = (photos || []).filter(Boolean);
  if (!list.length) return;

  lightboxState = { photos: list, index: Math.max(0, Math.min(index, list.length - 1)), rooms };
  const box = ensureLightbox();
  box.classList.remove("hidden");
  box.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  renderLightbox();
}

function closeLightbox() {
  const box = document.getElementById("photo-lightbox");
  if (!box) return;
  box.classList.add("hidden");
  box.setAttribute("aria-hidden", "true");
  box.querySelector(".lightbox-media").innerHTML = "";  // stop any playing video
  document.body.style.overflow = "";
  lightboxState = null;
}
