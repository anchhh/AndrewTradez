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
