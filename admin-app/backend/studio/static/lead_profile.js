const LEAD_STATUSES = ["new", "contacted", "responded", "converted", "dead"];
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const isVideoUrl = (url) => VIDEO_EXT.test(url);

const OUTREACH_KEY = { email: "outreach_email_sent", phone: "outreach_phone_called", video: "outreach_video_sent" };
const OUTREACH_LABELS = [["email", "Email sent"], ["phone", "Phone called"], ["video", "Video made"]];
const SOURCE_DOMAINS = { zillow: "zillow.com", realtor: "realtor.com", redfin: "redfin.com", homes: "homes.com" };

const LEAD_ID = window.LEAD_ID;
let lead = null;

const el = (id) => document.getElementById(id);

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

function setStatus(message, cls) {
  const node = el("lead-status");
  node.textContent = message || "";
  node.className = "status" + (cls ? ` ${cls}` : "");
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---------- pictures ---------- */

function renderPhotos(photos) {
  const hero = el("lp-hero");
  const thumbs = el("lp-thumbs");
  const list = photos || [];

  if (!list.length) {
    hero.innerHTML = `<div class="lp-hero-empty">No photos yet</div>`;
    thumbs.innerHTML = "";
    return;
  }

  const showHero = (url) => {
    hero.innerHTML = isVideoUrl(url)
      ? `<video src="${escapeHtml(url)}" controls muted></video>`
      : `<img src="${escapeHtml(url)}" alt="">`;
  };
  showHero(list[0]);

  thumbs.innerHTML = list
    .map(
      (url, i) => `<button type="button" class="lp-thumb ${i === 0 ? "is-active" : ""}" data-url="${escapeHtml(url)}">
        ${isVideoUrl(url) ? `<video src="${escapeHtml(url)}" muted></video>` : `<img src="${escapeHtml(url)}" alt="">`}
      </button>`
    )
    .join("");

  thumbs.querySelectorAll(".lp-thumb").forEach((btn) => {
    btn.addEventListener("click", () => {
      thumbs.querySelectorAll(".lp-thumb").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      showHero(btn.dataset.url);
    });
  });
}

// Fires automatically on open so a profile already has its pictures, the way
// Create Video pulls them from a pasted URL. The server caches into the lead,
// so this is a no-op read on every visit after the first.
async function pullPhotos(force) {
  const note = el("lp-photo-status");
  const btn = el("lp-refetch");
  note.textContent = force ? "Re-fetching photos…" : "Fetching photos from the listing…";
  btn.disabled = true;

  let data;
  try {
    data = await fetchJSON(`/studio/api/leads/${LEAD_ID}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: !!force }),
    });
  } catch (err) {
    note.textContent = "Couldn't reach the server to fetch photos.";
    btn.disabled = false;
    return;
  }

  btn.disabled = false;
  renderPhotos(data.photos);

  if (data.error) {
    note.textContent = data.blocked
      ? `${data.error} You can still upload photos from Create Video.`
      : data.error;
    note.className = "lp-photo-status is-warn";
  } else if (data.cached) {
    note.textContent = `${(data.photos || []).length} photo${(data.photos || []).length === 1 ? "" : "s"}`;
    note.className = "lp-photo-status";
  } else {
    const bits = [`${data.added} added`];
    if (data.duplicates) bits.push(`${data.duplicates} duplicate${data.duplicates === 1 ? "" : "s"} skipped`);
    if (data.failed) bits.push(`${data.failed} failed`);
    note.textContent = bits.join(" · ");
    note.className = "lp-photo-status";
  }
}

/* ---------- checklist ---------- */

function renderChecklist() {
  const box = el("lp-checklist");
  box.innerHTML = OUTREACH_LABELS.map(([field, label]) => {
    const checked = !!lead[OUTREACH_KEY[field]];
    return `<button type="button" class="lm-check-toggle ${checked ? "checked" : "unchecked"}" data-field="${field}">
      <span class="lm-check-icon">${checked ? "✔" : "✕"}</span>${label}
    </button>`;
  }).join("");

  box.querySelectorAll(".lm-check-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}/outreach`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: btn.dataset.field }),
      });
      Object.assign(lead, updated);
      renderChecklist();
    });
  });
}

/* ---------- notes ---------- */

// Debounced so typing doesn't fire a request per keystroke, and flushed on
// blur/unload so a note is never lost by navigating away mid-pause.
function wireNotes() {
  const box = el("lp-notes");
  const state = el("lp-notes-state");
  box.value = lead.notes || "";

  let timer = null;
  let lastSaved = box.value;

  const save = async () => {
    const value = box.value;
    if (value === lastSaved) return;
    state.textContent = "Saving…";
    try {
      await fetch(`/studio/api/leads/${LEAD_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: value }),
      });
      lastSaved = value;
      lead.notes = value;
      state.textContent = "Saved";
    } catch (err) {
      state.textContent = "Couldn't save — your text is still here, try again.";
    }
  };

  box.addEventListener("input", () => {
    state.textContent = "";
    clearTimeout(timer);
    timer = setTimeout(save, 700);
  });
  box.addEventListener("blur", () => {
    clearTimeout(timer);
    save();
  });
  window.addEventListener("beforeunload", () => {
    if (box.value !== lastSaved) {
      navigator.sendBeacon?.(
        `/studio/api/leads/${LEAD_ID}`,
        new Blob([JSON.stringify({ notes: box.value })], { type: "application/json" })
      );
    }
  });
}

/* ---------- video panel ---------- */

function renderVideo(project) {
  const box = el("lp-video");
  const video = project && (project.photos || []).find(isVideoUrl);

  if (video) {
    box.innerHTML = `<video src="${escapeHtml(video)}" controls></video>`;
    return;
  }

  box.innerHTML = `
    <div class="lp-video-empty">
      <div class="lp-video-empty-label">${project ? "Project started — no video yet" : "No project video yet"}</div>
      <a class="cta-btn cta-btn-sm" href="/studio/create?lead_id=${LEAD_ID}">${project ? "Open project" : "Create Video"}</a>
    </div>`;
}

/* ---------- header ---------- */

function renderLead() {
  const cityStateZip = [[lead.city, lead.state].filter(Boolean).join(", "), lead.zip_code].filter(Boolean).join(" ");
  el("lp-address").textContent = (lead.address || "—") + (cityStateZip ? `, ${cityStateZip}` : "");

  el("lp-contact").textContent = [lead.agent_name, lead.agent_phone, lead.agent_email].filter(Boolean).join(" | ");
  el("lp-facts").textContent = [
    lead.beds != null ? `${lead.beds} bd` : null,
    lead.baths != null ? `${lead.baths} ba` : null,
    lead.sqft != null ? `${lead.sqft.toLocaleString()} sqft` : null,
  ].filter(Boolean).join(" • ");

  const url = el("lp-url");
  if (lead.listing_url) {
    url.href = lead.listing_url;
    url.textContent = lead.listing_url;
    url.classList.remove("hidden");
  } else {
    url.classList.add("hidden");
  }

  const domain = SOURCE_DOMAINS[lead.source];
  el("lp-source").innerHTML = `<span class="badge badge-source">${
    domain ? `<img class="source-icon" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="">` : ""
  }${escapeHtml(lead.source || "—")}</span>`;

  const select = el("lp-status-select");
  select.innerHTML = LEAD_STATUSES.map(
    (s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`
  ).join("");
  select.onchange = async (e) => {
    const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: e.target.value }),
    });
    Object.assign(lead, updated);
  };

  const qualify = el("lp-qualify");
  const paintQualify = () => {
    qualify.textContent = lead.qualified ? "Qualified ✓" : "Mark Qualified";
    qualify.classList.toggle("is-qualified", !!lead.qualified);
  };
  paintQualify();
  qualify.onclick = async () => {
    const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}/qualify`, { method: "PATCH" });
    lead.qualified = updated.qualified;
    paintQualify();
  };
}

/* ---------- boot ---------- */

async function load() {
  let projects = [];
  try {
    [lead, projects] = await Promise.all([
      fetchJSON(`/studio/api/leads/${LEAD_ID}`),
      fetchJSON("/studio/api/projects").catch(() => []),
    ]);
  } catch (err) {
    setStatus("Couldn't load this lead.", "error");
    return;
  }

  if (!lead || lead.error) {
    setStatus(lead && lead.error ? lead.error : "Lead not found.", "error");
    return;
  }

  document.title = `${lead.address || "Lead"} — estly Studio`;
  el("lp-body").classList.remove("hidden");

  renderLead();
  renderChecklist();
  wireNotes();
  renderVideo((projects || []).find((p) => p.lead_id === lead.id) || null);
  renderPhotos(lead.photo_urls);

  el("lp-refetch").addEventListener("click", () => pullPhotos(true));
  pullPhotos(false);
}

load();
