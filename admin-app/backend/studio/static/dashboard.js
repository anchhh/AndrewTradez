/* Dashboard: qualified leads only. Each lead is its own card -- its own
   status header, its own row, its own notes box -- rather than several
   leads sharing one group header, so a lead reads as a single unit. Cards
   stay ordered by status priority (hot first). */

function setStatus(message, cls) {
  const el = document.getElementById("leads-status");
  el.textContent = message || "";
  el.className = "status" + (cls ? ` ${cls}` : "");
}

function renderLeadCard(lead, project) {
  const meta = STATUS_GROUPS[groupKeyFor(lead)];

  const card = document.createElement("section");
  card.className = `lm-group lm-card ${meta.className}`;
  card.innerHTML = `
    <div class="lm-group-header">${meta.icon} ${meta.label.toUpperCase()}</div>
    <div class="lm-group-rows">
      <div class="lm-row">
        <div class="lm-row-thumb">${thumbHtml((project && (project.photos || [])[0]) || (lead.photo_urls || [])[0] || null)}</div>
        <div class="lm-row-info">
          <div class="lm-row-address">${escapeHtml(addressLine(lead))}</div>
          ${contactLine(lead) ? `<div class="lm-row-contact">${escapeHtml(contactLine(lead))}</div>` : ""}
          ${factsLine(lead) ? `<div class="lm-row-facts">${factsLine(lead)}</div>` : ""}
          ${lead.listing_url ? `<a class="lm-row-url" href="${escapeHtml(lead.listing_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.listing_url)}</a>` : ""}
        </div>
        <div class="lm-row-source">${sourceBadgeHtml(lead.source)}</div>
        <div class="lm-row-checklist">
          ${checklistToggleHtml(lead, "email", "Email sent")}
          ${checklistToggleHtml(lead, "phone", "Phone called")}
          ${checklistToggleHtml(lead, "video", "made/sent video")}
        </div>
        <div class="lm-row-actions">
          <a class="link-btn" href="/studio/create?lead_id=${lead.id}">${project ? "Open Video" : "Create Video"}</a>
          <button class="icon-btn lm-delete-btn" title="Delete lead">&times;</button>
        </div>
      </div>
    </div>
    <div class="lm-card-notes">
      <textarea class="lm-notes-input" rows="2" placeholder="notes"></textarea>
      <div class="lm-notes-state"></div>
    </div>
  `;

  const row = card.querySelector(".lm-row");
  makeRowOpenProfile(row, lead.id);

  card.querySelectorAll(".lm-check-toggle").forEach((el) => {
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

  card.querySelector(".lm-delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete the lead at ${lead.address || "this address"}?`)) return;
    await fetch(`/studio/api/leads/${lead.id}`, { method: "DELETE" });
    loadDashboard();
  });

  const notes = card.querySelector(".lm-notes-input");
  notes.value = lead.notes || "";
  attachNotes(notes, lead.id, card.querySelector(".lm-notes-state"));

  return card;
}

async function loadDashboard() {
  const container = document.getElementById("lm-groups");
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

  container.innerHTML = "";

  if (!leads.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const sorted = [...leads].sort(
    (a, b) => GROUP_ORDER.indexOf(groupKeyFor(a)) - GROUP_ORDER.indexOf(groupKeyFor(b))
  );
  sorted.forEach((lead) =>
    container.appendChild(renderLeadCard(lead, projectByLeadId.get(lead.id) || null))
  );
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

  container.innerHTML = rows
    .map(
      (r) => `
    <div class="daily-checklist-item">
      <div class="daily-checklist-label">${r.label}</div>
      <div class="daily-checklist-progress">
        <span class="daily-checklist-done">${r.done}</span>
        <span class="daily-checklist-sep">/</span>
        <input type="number" min="0" class="daily-checklist-target" data-key="${r.key}" value="${r.target}">
      </div>
    </div>
  `
    )
    .join("");

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
