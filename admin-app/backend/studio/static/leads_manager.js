/* Lead Manager: every lead, with filters. Filtering happens client-side
   over the full set the API returns, so changing a filter is instant and
   never re-fetches; the list is capped at 200 server-side either way. */

let allLeads = [];

const filters = {
  qualified: "all",
  status: "all",
  source: "all",
  outreach: "all",
  search: "",
};

function setStatus(message, cls) {
  const el = document.getElementById("leads-status");
  el.textContent = message || "";
  el.className = "status" + (cls ? ` ${cls}` : "");
}

function matchesOutreach(lead) {
  const email = !!lead.outreach_email_sent;
  const phone = !!lead.outreach_phone_called;
  const video = !!lead.outreach_video_sent;
  switch (filters.outreach) {
    case "none":
      return !email && !phone && !video;
    case "email":
      return email;
    case "phone":
      return phone;
    case "video":
      return video;
    case "incomplete":
      return !(email && phone && video);
    default:
      return true;
  }
}

function matchesSearch(lead) {
  if (!filters.search) return true;
  const haystack = [
    lead.address, lead.city, lead.state, lead.zip_code,
    lead.agent_name, lead.agent_email, lead.agent_phone, lead.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(filters.search);
}

function visibleLeads() {
  return allLeads.filter((lead) => {
    if (filters.qualified !== "all" && String(!!lead.qualified) !== filters.qualified) return false;
    if (filters.status !== "all" && lead.status !== filters.status) return false;
    if (filters.source !== "all" && lead.source !== filters.source) return false;
    if (!matchesOutreach(lead)) return false;
    if (!matchesSearch(lead)) return false;
    return true;
  });
}

function renderRow(lead) {
  const tr = document.createElement("tr");

  const statusOptions = LEAD_STATUSES.map(
    (s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`
  ).join("");

  tr.innerHTML = `
    <td class="lm-thumb-cell">${thumbHtml((lead.photo_urls || [])[0] || null)}</td>
    <td class="lm-info-cell">
      <div class="lm-address">${escapeHtml(addressLine(lead))}</div>
      ${contactLine(lead) ? `<div class="lm-subline">${escapeHtml(contactLine(lead))}</div>` : ""}
      ${factsLine(lead) ? `<div class="lm-subline">${factsLine(lead)}</div>` : ""}
      ${lead.listing_url ? `<a class="lm-listing-url" href="${escapeHtml(lead.listing_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.listing_url)}</a>` : ""}
      ${lead.notes ? `<div class="lm-note-peek" title="${escapeHtml(lead.notes)}">📝 ${escapeHtml(lead.notes)}</div>` : ""}
    </td>
    <td><select class="lead-status-select">${statusOptions}</select></td>
    <td>${sourceBadgeHtml(lead.source)}</td>
    <td class="lm-checklist-cell">
      ${checklistToggleHtml(lead, "email", "Email sent")}
      ${checklistToggleHtml(lead, "phone", "Phone called")}
      ${checklistToggleHtml(lead, "video", "Video made")}
    </td>
    <td class="lm-actions-cell">
      <button type="button" class="btn-secondary btn-tiny lm-qualify-btn ${lead.qualified ? "is-qualified" : ""}">
        ${lead.qualified ? "Qualified ✓" : "Mark Qualified"}
      </button>
      <a class="link-btn" href="/studio/create?lead_id=${lead.id}">Create Video</a>
      <button class="icon-btn lm-delete-btn" title="Delete lead">&times;</button>
    </td>
  `;

  makeRowOpenProfile(tr, lead.id);

  tr.querySelector(".lead-status-select").addEventListener("change", async (e) => {
    const updated = await fetchJSON(`/studio/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: e.target.value }),
    });
    Object.assign(lead, updated);
    // The row may no longer match an active status filter.
    if (filters.status !== "all") render();
  });

  tr.querySelectorAll(".lm-check-toggle").forEach((el) => {
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
      if (filters.outreach !== "all") render();
    });
  });

  tr.querySelector(".lm-qualify-btn").addEventListener("click", async () => {
    const updated = await fetchJSON(`/studio/api/leads/${lead.id}/qualify`, { method: "PATCH" });
    Object.assign(lead, updated);
    const btn = tr.querySelector(".lm-qualify-btn");
    btn.textContent = updated.qualified ? "Qualified ✓" : "Mark Qualified";
    btn.classList.toggle("is-qualified", updated.qualified);
    if (filters.qualified !== "all") render();
  });

  tr.querySelector(".lm-delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete the lead at ${lead.address || "this address"}?`)) return;
    await fetch(`/studio/api/leads/${lead.id}`, { method: "DELETE" });
    loadLeads();
  });

  return tr;
}

function render() {
  const table = document.getElementById("lmg-table");
  const tbody = document.getElementById("lmg-tbody");
  const empty = document.getElementById("lmg-empty");
  const count = document.getElementById("lm-count");

  const shown = visibleLeads();

  tbody.innerHTML = "";
  shown.forEach((lead) => tbody.appendChild(renderRow(lead)));

  const filtering = shown.length !== allLeads.length;
  count.textContent = allLeads.length
    ? filtering
      ? `Showing ${shown.length} of ${allLeads.length} leads`
      : `${allLeads.length} lead${allLeads.length === 1 ? "" : "s"}`
    : "";

  table.classList.toggle("hidden", shown.length === 0);
  empty.classList.toggle("hidden", shown.length !== 0);
  empty.textContent = allLeads.length
    ? "No leads match these filters."
    : "No leads yet — capture one with the Chrome extension.";
}

function wireFilters() {
  const bind = (id, key, transform) => {
    const el = document.getElementById(id);
    const handler = () => {
      filters[key] = transform ? transform(el.value) : el.value;
      render();
    };
    el.addEventListener("change", handler);
    if (el.type === "search") el.addEventListener("input", handler);
  };

  bind("filter-qualified", "qualified");
  bind("filter-status", "status");
  bind("filter-source", "source");
  bind("filter-outreach", "outreach");
  bind("filter-search", "search", (v) => v.trim().toLowerCase());

  document.getElementById("filter-reset").addEventListener("click", () => {
    ["filter-qualified", "filter-status", "filter-source", "filter-outreach"].forEach((id) => {
      document.getElementById(id).value = "all";
    });
    document.getElementById("filter-search").value = "";
    Object.assign(filters, { qualified: "all", status: "all", source: "all", outreach: "all", search: "" });
    render();
  });
}

async function loadLeads() {
  try {
    allLeads = await fetchJSON("/studio/api/leads");
  } catch (err) {
    setStatus("Couldn't load leads.", "error");
    return;
  }
  render();
}

wireFilters();
loadLeads();
