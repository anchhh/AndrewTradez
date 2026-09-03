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

/* Which page a lead card is sitting on, for the profile's Back arrow.

   The same card renders on the Dashboard, the Lead Manager and the outreach
   queue, and opening one always said "from the Lead Manager" -- so Back from
   a project opened on the Dashboard landed somewhere you had not been. Taken
   from the page rather than passed in by every caller: the card is rendered
   BY the page it is on, so the page already knows. */
const CARD_PAGE = {
  "/studio/dashboard": "dashboard",
  "/studio/projects": "projects",
};

function makeRowOpenProfile(row, leadId) {
  row.classList.add("is-clickable");
  row.tabIndex = 0;
  row.setAttribute("role", "link");

  const go = () => {
    const from = CARD_PAGE[window.location.pathname];
    window.location.href = `/studio/leads/${leadId}`
      + (from ? `?from=${from}` : "");
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
  // A chosen thumbnail wins over the listing's own first photo, which is
  // whatever the site happened to put first rather than the best shot.
  const photo = lead.thumbnail_url
    || (project && (project.photos || [])[0])
    || (lead.photo_urls || [])[0]
    || null;

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
          <a class="link-btn" href="/studio/create/video/listing?lead_id=${lead.id}">${project ? "Open Video" : "Create Video"}</a>
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
        <button type="button" class="lead-candidate-drop" data-email="${escapeHtml(candidate.email)}"
                title="Not this one" aria-label="Dismiss ${escapeHtml(candidate.email)}">&times;</button>
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

        // Picking one answers the question, so the reasoning behind the
        // others stops earning its space. Check email brings it all back.
        const cleared = await fetchJSON(`/studio/api/leads/${lead.id}/candidates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        });
        Object.assign(lead, cleared);
        box.classList.add("hidden");
        box.innerHTML = "";

        // Update the address on the card itself. onChanged only re-renders
        // when a filter is active, so without this the card keeps showing the
        // old address until a reload -- which used to be masked by the
        // candidate list re-rendering underneath it.
        const contact = card.querySelector(".lead-card-contact");
        if (contact) contact.textContent = contactLine(lead);

        if (handlers.onChanged) handlers.onChanged(lead);
      });
    });

    box.querySelectorAll(".lead-candidate-drop").forEach((drop) => {
      drop.addEventListener("click", async () => {
        drop.disabled = true;
        const updated = await fetchJSON(`/studio/api/leads/${lead.id}/candidates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remove: drop.dataset.email }),
        });
        Object.assign(lead, updated);
        if (!(lead.email_candidates || []).length) {
          box.classList.add("hidden");
          box.innerHTML = "";
        } else {
          show(lead.email_candidates, message);
        }
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

/* Photos in walkthrough order -- all the exteriors, then the outdoor space,
   then living, kitchen and so on -- rather than the order the listing site
   happened to serve them. Without this, arrowing forward leaves the room you
   are in after one photo and the room directory appears to jump about.

   The rank comes from the label itself (services/rooms.py owns the order), so
   there is no second copy of it here to drift. Ties keep their original
   position, and anything unlabelled sorts to the end. */
function orderPhotos(photos, rooms) {
  const list = (photos || []).filter(Boolean);
  if (!rooms) return list;
  return list
    .map((url, i) => ({ url, i, rank: (rooms[url] && rooms[url].order) ?? 999 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.url);
}

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
        <button type="button" class="lightbox-pick" hidden></button>
      </figcaption>
    </figure>
    <button type="button" class="lightbox-nav lightbox-next" data-lb-next aria-label="Next">&#8250;</button>
    <div class="lightbox-rooms">
      <label class="lightbox-rooms-label" for="lightbox-room-select">Jump to</label>
      <select id="lightbox-room-select" class="lightbox-room-select"></select>
    </div>
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
    else if (e.key === " " && lightboxState.selection) {
      // Space takes the current one, so a whole pass can be done from the
      // keyboard: arrow, space, arrow, space.
      e.preventDefault();
      lightboxState.selection.toggle(lightboxState.photos[lightboxState.index]);
      renderLightbox();
    }
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
  const { photos, index, rooms, selection } = lightboxState;
  const url = photos[index];

  box.querySelector(".lightbox-media").innerHTML = isVideoUrl(url)
    ? `<video src="${escapeHtml(url)}" controls autoplay muted></video>`
    : `<img src="${escapeHtml(url)}" alt="">`;

  box.querySelector(".lightbox-count").textContent = `${index + 1} / ${photos.length}`;
  const room = rooms && rooms[url];
  box.querySelector(".lightbox-room").textContent = room ? room.label : "";

  const pick = box.querySelector(".lightbox-pick");
  if (selection) {
    const on = selection.isSelected(url);
    const what = selection.label || "photo";
    pick.hidden = false;
    pick.className = "lightbox-pick" + (on ? " is-on" : "");
    pick.textContent = on ? `✓ Using this ${what}` : `Use this ${what}`;
    pick.onclick = () => {
      selection.toggle(url);
      renderLightbox();
    };
  } else {
    pick.hidden = true;
    pick.onclick = null;
  }

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

  // A dropdown rather than a strip of chips: fifteen rooms of chips is a wall,
  // and this stays one line however many rooms a listing has.
  const select = box.querySelector(".lightbox-room-select");
  if (order.length > 1) {
    nav.hidden = false;
    const currentEntry = rooms && rooms[url];
    const currentKey = currentEntry ? currentEntry.room : "unsorted";
    select.innerHTML = order
      .map((r) => `<option value="${firstIndex[r.key]}" ${r.key === currentKey ? "selected" : ""}>
                     ${escapeHtml(r.label)} (${counts[r.key]})
                   </option>`)
      .join("");
    // Rebuilt every render, so the handler goes on fresh each time.
    select.onchange = () => {
      lightboxState.index = Number(select.value);
      renderLightbox();
    };
  } else {
    nav.hidden = true;
    select.innerHTML = "";
  }

  const strip = box.querySelector(".lightbox-strip");
  strip.innerHTML = photos.map((u, i) => `
    <button type="button" class="lightbox-thumb ${i === index ? "is-active" : ""}${
      selection && selection.isSelected(u) ? " is-picked" : ""}" data-i="${i}">
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

/* An optional selection hook, so a page that is choosing photos can choose
   them full screen too rather than closing the viewer to tick a box:

     openLightbox(photos, i, rooms, {
       isSelected: (url) => bool,
       toggle: (url) => {},   // flip it, then the caller re-renders its own grid
       label: "room",
     })
*/
function openLightbox(photos, index = 0, rooms = null, selection = null) {
  const raw = (photos || []).filter(Boolean);
  if (!raw.length) return;

  // Reorder, then follow the photo that was clicked to its new position, so
  // the viewer still opens on what the user actually pointed at.
  const wanted = raw[Math.max(0, Math.min(index, raw.length - 1))];
  const list = orderPhotos(raw, rooms);
  const start = Math.max(0, list.indexOf(wanted));

  lightboxState = { photos: list, index: start, rooms, selection };
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

/* ---------------------------------------------------------------
   Compact row

   A card per lead reads well at five and is unusable at three hundred --
   roughly 200px each means scrolling a mile to find anything. This is the
   same lead in one line: enough to recognise and trage it, with the profile
   one click away for everything else.

   Deliberately not a <table>: the rows carry the same selection checkbox,
   status select and outreach toggles as the cards, and reusing those means
   reusing their handlers rather than writing a second set.
   --------------------------------------------------------------- */

/* What the outreach toggles used to show, minus the toggling. They were
   three buttons on every row for something done once per lead; as marks they
   still answer "where is this one up to" at a glance, and the doing moved
   into the menu. A qualified lead keeps its star for the same reason. */
function rowFlagsHtml(lead) {
  const marks = [
    ["email", "E", "Email sent"],
    ["phone", "P", "Phone called"],
    ["video", "V", "Video made"],
  ].filter(([field]) => lead[OUTREACH_KEY[field]]);

  return (lead.qualified ? `<span class="lm-flag is-star" title="Qualified">★</span>` : "")
    + marks.map(([, letter, title]) =>
        `<span class="lm-flag" title="${title}">${letter}</span>`).join("");
}

function leadRowHtml(lead) {
  const meta = STATUS_GROUPS[groupKeyFor(lead)];
  const photo = lead.thumbnail_url || (lead.photo_urls || [])[0] || null;
  const place = [lead.city, lead.state].filter(Boolean).join(", ");

  return `
    <div class="lm-row ${meta.className} ${selectedLeadIds.has(lead.id) ? "is-selected" : ""}">
      <label class="lm-row-select" title="Select this lead">
        <input type="checkbox" class="lead-select-box" ${selectedLeadIds.has(lead.id) ? "checked" : ""}>
      </label>
      <button type="button" class="lm-row-thumb ${photo ? "" : "is-empty"}" title="View photos">
        ${photo ? `<img src="${escapeHtml(photo)}" alt="" loading="lazy">` : ""}
      </button>
      <div class="lm-row-main">
        <span class="lm-row-address">${escapeHtml(lead.address || "Untitled listing")}</span>
        <span class="lm-row-sub">${escapeHtml([place, lead.agent_name].filter(Boolean).join(" · "))}</span>
      </div>
      <span class="lm-row-status" title="${escapeHtml(meta.label)}">${meta.icon}</span>
      <span class="lm-row-flags">${rowFlagsHtml(lead)}</span>
      <button type="button" class="lm-row-menu" aria-haspopup="menu" aria-expanded="false"
              title="More actions" aria-label="More actions">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="3.4" r="1.4"/><circle cx="8" cy="8" r="1.4"/>
          <circle cx="8" cy="12.6" r="1.4"/></svg>
      </button>
      <span class="lm-row-open" aria-hidden="true">›</span>
    </div>`;
}

function wireLeadRow(row, lead, handlers = {}) {
  const changed = () => handlers.onChanged && handlers.onChanged(lead);

  // The whole row opens the profile. makeRowOpenProfile ignores clicks that
  // land on a control (checkbox, status select, the outreach toggles, the
  // thumbnail) and clicks that finish a text selection, so the row is
  // clickable without swallowing what is on it.
  makeRowOpenProfile(row, lead.id);

  const box = row.querySelector(".lead-select-box");
  box.addEventListener("change", () => {
    if (box.checked) selectedLeadIds.add(lead.id);
    else selectedLeadIds.delete(lead.id);
    row.classList.toggle("is-selected", box.checked);
    if (handlers.onSelectionChange) handlers.onSelectionChange();
  });

  const thumb = row.querySelector(".lm-row-thumb");
  if (thumb && (lead.photo_urls || []).length) {
    thumb.addEventListener("click", () =>
      openLightbox(lead.photo_urls, 0, lead.photo_rooms || null));
  }

  const menuBtn = row.querySelector(".lm-row-menu");
  if (menuBtn) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRowMenu(menuBtn, lead, row, handlers);
    });
  }

  return row;
}


/* ---------------------------------------------------------------
   The row menu

   Every per-row action lives here. The row carried a status dropdown, three
   outreach toggles and a star -- five controls on every line, most of them
   used once in a lead's life. They are one button now, and the row shows
   marks instead.

   One menu exists at a time, appended to the body rather than to the row:
   inside the row it would be clipped by the list's overflow and would
   inherit the row's own click-to-open-profile.
   --------------------------------------------------------------- */

let openMenu = null;
let folderCache = null;

function closeRowMenu() {
  if (!openMenu) return;
  openMenu.button.setAttribute("aria-expanded", "false");
  openMenu.node.remove();
  openMenu = null;
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.node.contains(e.target)) closeRowMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRowMenu();
});
// Anchored to a button that scrolls away, so it follows nothing -- close it.
// Except when the scrolling is inside the menu itself, which is scrollable
// and would otherwise shut the moment you reached for an item near the end.
window.addEventListener("scroll", (e) => {
  if (openMenu && openMenu.node.contains(e.target)) return;
  closeRowMenu();
}, true);
window.addEventListener("resize", closeRowMenu);

async function loadFolders() {
  if (folderCache) return folderCache;
  try {
    const body = await fetchJSON("/studio/api/folders");
    folderCache = body.folders || [];
  } catch (err) {
    folderCache = [];
  }
  return folderCache;
}

function menuItem(label, opts = {}) {
  const cls = ["lm-menu-item"];
  if (opts.danger) cls.push("is-danger");
  if (opts.checked) cls.push("is-checked");
  if (opts.indent) cls.push("is-indent");
  return `<button type="button" class="${cls.join(" ")}" data-act="${opts.act || ""}"
            data-arg="${opts.arg == null ? "" : escapeHtml(String(opts.arg))}">
            <span class="lm-menu-tick">${opts.checked ? "✓" : ""}</span>
            <span>${escapeHtml(label)}</span>
          </button>`;
}

async function openRowMenu(button, lead, row, handlers) {
  // Clicking the same button again closes it -- but only if its menu is
  // still on the page. If the node went away without closeRowMenu (a row
  // re-rendered underneath it, say), the stale reference would swallow the
  // next click and the button would look broken.
  const wasMine = openMenu && openMenu.button === button && openMenu.node.isConnected;
  closeRowMenu();
  if (wasMine) return;

  const folders = await loadFolders();

  const node = document.createElement("div");
  node.className = "lm-menu";
  node.setAttribute("role", "menu");
  node.innerHTML = [
    menuItem("Open profile", { act: "open" }),
    '<div class="lm-menu-sep"></div>',
    menuItem(lead.qualified ? "Remove from qualified" : "Mark qualified",
             { act: "qualify", checked: !!lead.qualified }),
    '<div class="lm-menu-label">Status</div>',
    LEAD_STATUSES.map((s) => menuItem(s, {
      act: "status", arg: s, checked: s === lead.status, indent: true,
    })).join(""),
    '<div class="lm-menu-label">Outreach</div>',
    [["email", "Email sent"], ["phone", "Phone called"], ["video", "Video made"]]
      .map(([field, label]) => menuItem(label, {
        act: "outreach", arg: field, checked: !!lead[OUTREACH_KEY[field]], indent: true,
      })).join(""),
    '<div class="lm-menu-label">Folder</div>',
    folders.length
      ? folders.map((f) => menuItem(f.name, {
          act: "folder", arg: f.id, checked: lead.folder_id === f.id, indent: true,
        })).join("")
      : '<div class="lm-menu-note">No folders yet — make one on Projects.</div>',
    lead.folder_id
      ? menuItem("Remove from folder", { act: "folder", arg: "", indent: true })
      : "",
    '<div class="lm-menu-sep"></div>',
    menuItem("Delete lead", { act: "delete", danger: true }),
  ].join("");

  document.body.appendChild(node);

  // Under the button, flipped above it when there is no room below, and
  // clamped to the viewport either way. The menu is tall enough to run off
  // the bottom of the screen from most rows, and a flip alone does not save
  // it -- from a row in the middle of a long list neither side fits, so the
  // last step is what actually keeps it on screen.
  const rect = button.getBoundingClientRect();
  const height = node.offsetHeight;
  const gap = 6;

  node.style.left = Math.max(8, Math.min(rect.right - node.offsetWidth,
                                         window.innerWidth - node.offsetWidth - 8)) + "px";

  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - 8) top = rect.top - height - gap;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  node.style.top = top + "px";

  button.setAttribute("aria-expanded", "true");
  openMenu = { node, button };

  node.querySelectorAll(".lm-menu-item").forEach((item) => {
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runRowAction(item.dataset.act, item.dataset.arg, lead, row, handlers);
    });
  });
}

async function runRowAction(act, arg, lead, row, handlers) {
  const changed = () => handlers.onChanged && handlers.onChanged(lead);

  if (act === "open") {
    window.location.href = `/studio/leads/${lead.id}`;
    return;
  }

  if (act === "delete") {
    // Leads are not soft-deleted, so this one asks first.
    if (!confirm(`Delete ${lead.address || "this lead"}? This cannot be undone.`)) return;
    closeRowMenu();
    await fetchJSON(`/studio/api/leads/${lead.id}`, { method: "DELETE" });
    if (handlers.onDeleted) handlers.onDeleted(lead);
    else row.remove();
    return;
  }

  try {
    if (act === "qualify") {
      Object.assign(lead, await fetchJSON(`/studio/api/leads/${lead.id}/qualify`,
                                          { method: "PATCH" }));
    } else if (act === "status") {
      Object.assign(lead, await fetchJSON(`/studio/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: arg }),
      }));
    } else if (act === "outreach") {
      Object.assign(lead, await fetchJSON(`/studio/api/leads/${lead.id}/outreach`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: arg }),
      }));
    } else if (act === "folder") {
      await fetchJSON("/studio/api/folders/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_ids: [lead.id], folder_id: arg ? Number(arg) : null }),
      });
      lead.folder_id = arg ? Number(arg) : null;
      // The counts on the folder list are now stale.
      folderCache = null;
    }
  } catch (err) {
    alert(err.message || "That didn't work.");
    return;
  }

  closeRowMenu();
  // Redraw the row in place, so its marks match what was just changed even
  // when the page has no onChanged of its own.
  const fresh = document.createElement("div");
  fresh.innerHTML = leadRowHtml(lead);
  const next = wireLeadRow(fresh.firstElementChild, lead, handlers);
  row.replaceWith(next);
  changed();
}

function buildLeadRow(lead, handlers = {}) {
  const host = document.createElement("div");
  host.innerHTML = leadRowHtml(lead);
  return wireLeadRow(host.firstElementChild, lead, handlers);
}

/* ---------------------------------------------------------------
   Lead picker

   Shared by Create Video and Scenery: both start by choosing a lead that
   already has its photos, address and listing details saved. One copy, so
   the two pages cannot drift into behaving differently.

   The cards are the Lead Manager's own leadCardHtml(), but deliberately not
   its wireLeadCard() -- that makes a card open the profile and wires Delete,
   both wrong inside a picker. The controls that would edit or navigate away
   are removed and the card itself picks.
   --------------------------------------------------------------- */

const picker = {
  leads: null,
  loaded: false,
  onPick: null,
};

function pickerMatches(lead, terms) {
  const hay = [
    lead.address, lead.city, lead.state, lead.zip_code,
    lead.agent_name, lead.brokerage, lead.agent_email,
  ].filter(Boolean).join(" ").toLowerCase();
  // Every word must appear, so "belmont pope" finds the lead matching both
  // rather than everything matching either.
  return terms.every((t) => hay.includes(t));
}

function pickerVisible() {
  const val = (id) => (document.getElementById(id) || {}).value || "all";
  const terms = ((document.getElementById("lead-search") || {}).value || "")
    .toLowerCase().split(/\s+/).filter(Boolean);
  const qualified = val("pick-filter-qualified");
  const status = val("pick-filter-status");
  const source = val("pick-filter-source");

  return (picker.leads || []).filter((lead) => {
    if (!pickerMatches(lead, terms)) return false;
    if (qualified !== "all" && String(!!lead.qualified) !== qualified) return false;
    if (status !== "all" && lead.status !== status) return false;
    if (source !== "all" && lead.source !== source) return false;
    return true;
  });
}

function pickerCard(lead) {
  const host = document.createElement("div");
  host.innerHTML = leadCardHtml(lead, {});
  const card = host.firstElementChild;

  card.querySelector(".lead-card-select")?.remove();
  card.querySelector(".lm-delete-btn")?.remove();
  card.querySelector(".lead-find-email")?.remove();
  card.querySelector('a[href^="/studio/create"]')?.remove();

  card.querySelectorAll(".lead-card-checklist button").forEach((b) => {
    b.disabled = true;
    b.style.pointerEvents = "none";
  });

  const photos = (lead.photo_urls || []).length;
  const actions = card.querySelector(".lead-card-actions");
  if (actions) {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn-send lead-use-btn";
    use.textContent = photos ? "Use this lead" : "No photos";
    use.disabled = !photos;
    actions.appendChild(use);
  }

  if (photos) {
    card.classList.add("is-pickable");
    card.addEventListener("click", (e) => {
      if (e.target.closest("a, select, textarea")) return;
      pickerChoose(card, lead);
    });
  } else {
    card.classList.add("is-unpickable");
  }
  return card;
}

function pickerRender() {
  const box = document.getElementById("lead-picker");
  const empty = document.getElementById("lead-picker-empty");
  const count = document.getElementById("lead-count");
  if (!box) return;

  if (!picker.leads || !picker.leads.length) {
    box.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    if (count) count.textContent = "";
    return;
  }
  if (empty) empty.classList.add("hidden");

  const shown = pickerVisible();
  if (count) {
    count.textContent = shown.length === picker.leads.length
      ? `${picker.leads.length} lead${picker.leads.length === 1 ? "" : "s"}`
      : `${shown.length} of ${picker.leads.length} leads`;
  }

  box.innerHTML = "";
  if (!shown.length) {
    box.innerHTML = `<p class="hint">Nothing matches that.</p>`;
    return;
  }
  shown.forEach((lead) => box.appendChild(pickerCard(lead)));
}

async function pickerLoad() {
  if (picker.loaded) return;
  try {
    const res = await fetch("/studio/api/leads");
    picker.leads = await res.json();
    picker.loaded = true;
  } catch (_) {
    const box = document.getElementById("lead-picker");
    if (box) box.innerHTML = `<p class="hint">Couldn't load your leads.</p>`;
    return;
  }
  pickerRender();
}

function pickerOpen() {
  const modal = document.getElementById("lead-modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  document.getElementById("lead-search").focus();
  pickerLoad();
}

function pickerClose() {
  const modal = document.getElementById("lead-modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  document.getElementById("lead-open").focus();
}

async function pickerChoose(card, lead) {
  const btn = card.querySelector(".lead-use-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    const res = await fetch(`/studio/api/leads/${lead.id}/prefill`);
    if (!res.ok) throw new Error((await res.json()).error || "Could not load that lead.");
    const prefill = await res.json();
    pickerClose();
    if (picker.onPick) await picker.onPick(prefill, lead);

    const n = (lead.photo_urls || []).length;
    const summary = document.getElementById("lead-picked-summary");
    if (summary) {
      summary.textContent = `${lead.address} — ${n} photo${n === 1 ? "" : "s"} loaded`;
      summary.classList.add("is-set");
    }
    document.getElementById("lead-open").textContent = "Pick a different lead";
  } catch (err) {
    alert(err.message || "Could not load that lead.");
    if (btn) { btn.disabled = false; btn.textContent = "Use this lead"; }
  }
}

/* `onPick(prefill, lead)` is what the host page does with the chosen lead --
   the only thing that differs between Create Video and Scenery. */
function initLeadPicker(options = {}) {
  const open = document.getElementById("lead-open");
  if (!open) return;
  picker.onPick = options.onPick || null;

  open.addEventListener("click", pickerOpen);
  document.getElementById("lead-modal").querySelectorAll("[data-close]").forEach((n) => {
    n.addEventListener("click", pickerClose);
  });
  document.getElementById("lead-search").addEventListener("input", pickerRender);
  ["pick-filter-qualified", "pick-filter-status", "pick-filter-source"].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.addEventListener("change", pickerRender);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("lead-modal").classList.contains("hidden")) {
      pickerClose();
    }
  });
}
