/* Lead Manager: every lead as a card, with filters. Same card component the
   Dashboard uses, plus the status dropdown and Mark Qualified button that
   only make sense here. Filtering runs client-side over the set already
   fetched, so changing a filter is instant and never re-requests. */

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
  return [
    lead.address, lead.city, lead.state, lead.zip_code,
    lead.agent_name, lead.agent_email, lead.agent_phone, lead.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(filters.search);
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

const anyFilterActive = () =>
  filters.qualified !== "all" ||
  filters.status !== "all" ||
  filters.source !== "all" ||
  filters.outreach !== "all" ||
  !!filters.search;

function render() {
  const list = document.getElementById("lmg-list");
  const empty = document.getElementById("lmg-empty");
  const count = document.getElementById("lm-count");

  const shown = visibleLeads();

  list.innerHTML = "";
  shown.forEach((lead) => {
    list.appendChild(
      buildLeadCard(
        lead,
        { showStatusSelect: true, showQualify: true, showNotes: true },
        {
          // A change can move a lead out of the current filter, so
          // re-evaluate the list instead of leaving a stale card behind.
          onChanged: () => {
            if (anyFilterActive()) render();
            else updateCount(shown.length);
          },
          onDeleted: loadLeads,
        }
      )
    );
  });

  updateCount(shown.length);
  empty.classList.toggle("hidden", shown.length !== 0);
  empty.textContent = allLeads.length
    ? "No leads match these filters."
    : "No leads yet — capture one with the Chrome extension.";
}

function updateCount(shownCount) {
  const count = document.getElementById("lm-count");
  if (!allLeads.length) {
    count.textContent = "";
    return;
  }
  count.textContent =
    shownCount !== allLeads.length
      ? `Showing ${shownCount} of ${allLeads.length} leads`
      : `${allLeads.length} lead${allLeads.length === 1 ? "" : "s"}`;
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
