const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const isVideoUrl = (url) => VIDEO_EXT.test(url);

const OUTREACH_KEY = { email: "outreach_email_sent", phone: "outreach_phone_called", video: "outreach_video_sent" };
const SOURCE_DOMAINS = { zillow: "zillow.com", realtor: "realtor.com", redfin: "redfin.com", homes: "homes.com" };

// Order matters: this is the display order of the status groups on the
// page, most-actionable first. Any status not listed here (there
// shouldn't be any) falls back into "new".
const STATUS_GROUPS = {
  responded: { icon: "🔥", label: "Hot Lead", className: "group-hot" },
  new: { icon: "🆕", label: "New Lead", className: "group-new" },
  contacted: { icon: "📨", label: "Contacted", className: "group-contacted" },
  converted: { icon: "✅", label: "Converted", className: "group-converted" },
  dead: { icon: "📦", label: "Cold Lead", className: "group-cold" },
};
const GROUP_ORDER = ["responded", "new", "contacted", "converted", "dead"];

function sourceBadgeHtml(source) {
  const domain = SOURCE_DOMAINS[source];
  const icon = domain ? `<img class="source-icon" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="">` : "";
  return `<span class="badge badge-source">${icon}${source || "—"}</span>`;
}

function checklistToggleHtml(lead, field, label) {
  const checked = !!lead[OUTREACH_KEY[field]];
  return `<button type="button" class="lm-check-toggle ${checked ? "checked" : "unchecked"}" data-field="${field}">
    <span class="lm-check-icon">${checked ? "✔" : "✕"}</span>${label}
  </button>`;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

function setStatus(message, cls) {
  const el = document.getElementById("leads-status");
  el.textContent = message || "";
  el.className = "status" + (cls ? ` ${cls}` : "");
}

function renderLeadRow(lead, project) {
  const row = document.createElement("div");
  row.className = "lm-row";

  const photo = (project && (project.photos || [])[0]) || (lead.photo_urls || [])[0] || null;
  const thumbHtml = photo
    ? (isVideoUrl(photo) ? `<video src="${photo}" muted></video>` : `<img src="${photo}" alt="">`)
    : `<div class="lm-thumb-empty">No photo</div>`;

  const cityStateZip = [[lead.city, lead.state].filter(Boolean).join(", "), lead.zip_code].filter(Boolean).join(" ");
  const contactBits = [lead.agent_name, lead.agent_phone, lead.agent_email].filter(Boolean).join(" | ");
  const factsBits = [
    lead.beds != null ? `${lead.beds} bd` : null,
    lead.baths != null ? `${lead.baths} ba` : null,
    lead.sqft != null ? `${lead.sqft.toLocaleString()} sqft` : null,
  ].filter(Boolean).join(" • ");

  row.innerHTML = `
    <div class="lm-row-thumb">${thumbHtml}</div>
    <div class="lm-row-info">
      <div class="lm-row-address">${lead.address || "—"}${cityStateZip ? `, ${cityStateZip}` : ""}</div>
      ${contactBits ? `<div class="lm-row-contact">${contactBits}</div>` : ""}
      ${factsBits ? `<div class="lm-row-facts">${factsBits}</div>` : ""}
      ${lead.listing_url ? `<a class="lm-row-url" href="${lead.listing_url}" target="_blank" rel="noopener noreferrer">${lead.listing_url}</a>` : ""}
    </div>
    <div class="lm-row-source">${sourceBadgeHtml(lead.source)}</div>
    <div class="lm-row-checklist">
      ${checklistToggleHtml(lead, "email", "Email sent")}
      ${checklistToggleHtml(lead, "phone", "Phone called")}
      ${checklistToggleHtml(lead, "video", "made/sent video")}
    </div>
    <div class="lm-row-actions">
      <a class="link-btn" href="/studio/create?lead_id=${lead.id}" target="_blank" rel="noopener noreferrer">${project ? "Open Video" : "Create Video"}</a>
      <button class="icon-btn lm-delete-btn" title="Delete lead">&times;</button>
    </div>
  `;

  row.querySelectorAll(".lm-check-toggle").forEach((el) => {
    el.addEventListener("click", async () => {
      const field = el.dataset.field;
      const updated = await fetchJSON(`/studio/api/leads/${lead.id}/outreach`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field }),
      });
      const checked = !!updated[OUTREACH_KEY[field]];
      el.classList.toggle("checked", checked);
      el.classList.toggle("unchecked", !checked);
      el.querySelector(".lm-check-icon").textContent = checked ? "✔" : "✕";
      loadDailyChecklist();
    });
  });

  row.querySelector(".lm-delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete the lead at ${lead.address || "this address"}?`)) return;
    await fetch(`/studio/api/leads/${lead.id}`, { method: "DELETE" });
    loadDashboard();
  });

  return row;
}

async function loadDashboard() {
  const groupsContainer = document.getElementById("lm-groups");
  const empty = document.getElementById("lm-empty");

  let leads = [];
  let projects = [];
  try {
    [leads, projects] = await Promise.all([
      fetchJSON("/studio/api/leads?qualified=true"),
      fetchJSON("/studio/api/projects"),
    ]);
  } catch (err) {
    setStatus("Couldn't load leads/projects.", "error");
    return;
  }

  const projectByLeadId = new Map();
  (projects || []).forEach((p) => {
    if (p.lead_id != null) projectByLeadId.set(p.lead_id, p);
  });

  document.getElementById("stat-active-projects").textContent =
    (projects || []).filter((p) => (p.status || "draft") !== "completed").length;
  document.getElementById("stat-hot-leads").textContent =
    (leads || []).filter((l) => l.status === "responded").length;
  document.getElementById("stat-projects-todo").textContent =
    (leads || []).filter((l) => !projectByLeadId.has(l.id)).length;

  groupsContainer.innerHTML = "";

  if (!leads.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const byStatus = {};
  leads.forEach((lead) => {
    const key = STATUS_GROUPS[lead.status] ? lead.status : "new";
    (byStatus[key] = byStatus[key] || []).push(lead);
  });

  GROUP_ORDER.forEach((statusKey) => {
    const group = byStatus[statusKey];
    if (!group || !group.length) return;
    const meta = STATUS_GROUPS[statusKey];

    const section = document.createElement("section");
    section.className = `lm-group ${meta.className}`;
    section.innerHTML = `<div class="lm-group-header">${meta.icon} ${meta.label.toUpperCase()}</div>`;

    const rowsWrap = document.createElement("div");
    rowsWrap.className = "lm-group-rows";
    group.forEach((lead) => rowsWrap.appendChild(renderLeadRow(lead, projectByLeadId.get(lead.id) || null)));
    section.appendChild(rowsWrap);

    groupsContainer.appendChild(section);
  });
}

async function loadDailyChecklist() {
  const container = document.getElementById("daily-checklist");
  let data;
  try {
    data = await fetchJSON("/studio/api/daily-goals");
  } catch (err) {
    container.innerHTML = `<p class="status error">Couldn't load.</p>`;
    return;
  }

  const rows = [
    { key: "calls", label: "Calls", done: data.calls_done, target: data.calls_target },
    { key: "emails", label: "Emails", done: data.emails_done, target: data.emails_target },
    { key: "videos", label: "Videos", done: data.videos_done, target: data.videos_target },
  ];

  container.innerHTML = rows.map((r) => `
    <div class="daily-checklist-item">
      <div class="daily-checklist-label">${r.label}</div>
      <div class="daily-checklist-progress">
        <span class="daily-checklist-done">${r.done}</span>
        <span class="daily-checklist-sep">/</span>
        <input type="number" min="0" class="daily-checklist-target" data-key="${r.key}" value="${r.target}">
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".daily-checklist-target").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const key = e.target.dataset.key;
      const value = Math.max(0, parseInt(e.target.value, 10) || 0);
      e.target.value = value;
      await fetch("/studio/api/daily-goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [`${key}_target`]: value }),
      });
    });
  });
}

loadDashboard();
loadDailyChecklist();
