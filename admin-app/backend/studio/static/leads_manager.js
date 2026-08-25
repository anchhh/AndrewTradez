const LEAD_STATUSES = ["new", "contacted", "responded", "converted", "dead"];
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const isVideoUrl = (url) => VIDEO_EXT.test(url);

const OUTREACH_KEY = { email: "outreach_email_sent", phone: "outreach_phone_called", video: "outreach_video_sent" };

const SOURCE_DOMAINS = { zillow: "zillow.com", realtor: "realtor.com", redfin: "redfin.com", homes: "homes.com" };

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

function renderRow(lead) {
  const tr = document.createElement("tr");

  const photo = (lead.photo_urls || [])[0] || null;
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

  const statusOptions = LEAD_STATUSES.map(
    (s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`
  ).join("");

  tr.innerHTML = `
    <td class="lm-thumb-cell">${thumbHtml}</td>
    <td class="lm-info-cell">
      <div class="lm-address">${lead.address || "—"}${cityStateZip ? `, ${cityStateZip}` : ""}</div>
      ${contactBits ? `<div class="lm-subline">${contactBits}</div>` : ""}
      ${factsBits ? `<div class="lm-subline">${factsBits}</div>` : ""}
      ${lead.listing_url ? `<a class="lm-listing-url" href="${lead.listing_url}" target="_blank" rel="noopener noreferrer">${lead.listing_url}</a>` : ""}
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
      <a class="link-btn" href="/studio/create?lead_id=${lead.id}" target="_blank" rel="noopener noreferrer">Create Video</a>
      <button class="icon-btn lm-delete-btn" title="Delete lead">&times;</button>
    </td>
  `;

  tr.querySelector(".lead-status-select").addEventListener("change", async (e) => {
    await fetch(`/studio/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: e.target.value }),
    });
  });

  tr.querySelectorAll(".lm-check-toggle").forEach((el) => {
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
    });
  });

  tr.querySelector(".lm-qualify-btn").addEventListener("click", async () => {
    const updated = await fetchJSON(`/studio/api/leads/${lead.id}/qualify`, { method: "PATCH" });
    lead.qualified = updated.qualified;
    const btn = tr.querySelector(".lm-qualify-btn");
    btn.textContent = updated.qualified ? "Qualified ✓" : "Mark Qualified";
    btn.classList.toggle("is-qualified", updated.qualified);
  });

  tr.querySelector(".lm-delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete the lead at ${lead.address || "this address"}?`)) return;
    await fetch(`/studio/api/leads/${lead.id}`, { method: "DELETE" });
    loadLeads();
  });

  return tr;
}

async function loadLeads() {
  const table = document.getElementById("lmg-table");
  const tbody = document.getElementById("lmg-tbody");
  const empty = document.getElementById("lmg-empty");

  let leads;
  try {
    leads = await fetchJSON("/studio/api/leads");
  } catch (err) {
    setStatus("Couldn't load leads.", "error");
    return;
  }

  if (!leads.length) {
    table.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");

  tbody.innerHTML = "";
  leads.forEach((lead) => tbody.appendChild(renderRow(lead)));
}


loadLeads();
