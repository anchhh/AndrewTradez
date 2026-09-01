/* Lead Manager: every lead as a card, with filters. Same card component the
   Dashboard uses, plus the status dropdown and Mark Qualified button that
   only make sense here. Filtering runs client-side over the set already
   fetched, so changing a filter is instant and never re-requests. */

let allLeads = [];
let shownLeads = [];
let bulkRefresh = null;

const filters = {
  qualified: "all",
  status: "all",
  source: "all",
  outreach: "all",
  search: "",
  sort: "newest",
};

/* Cards read well at five leads and are unusable at three hundred, so the
   view is a choice and the choice is remembered. Compact is the default once
   there are enough leads for it to matter. */
const VIEW_KEY = "estly.leadView";
let view = "cards";

function loadView(leadCount) {
  let stored = null;
  try { stored = localStorage.getItem(VIEW_KEY); } catch (_) { /* private window */ }
  view = stored || (leadCount > 12 ? "compact" : "cards");
}

function setView(next) {
  view = next;
  try { localStorage.setItem(VIEW_KEY, next); } catch (_) { /* not worth failing over */ }
  document.getElementById("view-compact").classList.toggle("is-active", next === "compact");
  document.getElementById("view-cards").classList.toggle("is-active", next === "cards");
  render();
}

const SORTERS = {
  newest: (a, b) => (b.created_at || "").localeCompare(a.created_at || ""),
  oldest: (a, b) => (a.created_at || "").localeCompare(b.created_at || ""),
  address: (a, b) => (a.address || "").localeCompare(b.address || ""),
  agent: (a, b) => (a.agent_name || "~").localeCompare(b.agent_name || "~"),
  // Leads with no price sort last either way rather than pretending to be 0.
  "price-high": (a, b) => (b.price || -1) - (a.price || -1),
  "price-low": (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
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
  return sortLeads(allLeads.filter((lead) => {
    if (filters.qualified !== "all" && String(!!lead.qualified) !== filters.qualified) return false;
    if (filters.status !== "all" && lead.status !== filters.status) return false;
    if (filters.source !== "all" && lead.source !== filters.source) return false;
    if (!matchesOutreach(lead)) return false;
    if (!matchesSearch(lead)) return false;
    return true;
  }));
}

function sortLeads(list) {
  const cmp = SORTERS[filters.sort] || SORTERS.newest;
  return [...list].sort(cmp);
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
  shownLeads = shown;
  pruneSelection(shown);

  const handlers = {
    // A change can move a lead out of the current filter, so re-evaluate the
    // list instead of leaving a stale card behind.
    onChanged: () => {
      if (anyFilterActive()) render();
      else updateCount(shown.length);
    },
    onDeleted: loadLeads,
    onSelectionChange: () => bulkRefresh && bulkRefresh(),
  };

  list.className = view === "compact" ? "lm-rows" : "lead-card-list";
  list.innerHTML = "";
  shown.forEach((lead) => {
    list.appendChild(
      view === "compact"
        ? buildLeadRow(lead, handlers)
        : buildLeadCard(lead, { showStatusSelect: true, showQualify: true, showNotes: true }, handlers)
    );
  });

  if (bulkRefresh) bulkRefresh();

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
  const base =
    shownCount !== allLeads.length
      ? `Showing ${shownCount} of ${allLeads.length} leads`
      : `${allLeads.length} lead${allLeads.length === 1 ? "" : "s"}`;
  // The server caps the fetch; say so rather than quietly showing a subset.
  count.textContent = allLeads.length >= 2000
    ? `${base} — only the most recent 2000 are loaded`
    : base;
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
  bind("filter-sort", "sort");

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
  loadView(allLeads.length);
  setView(view);
}

wireFilters();
document.getElementById("view-compact").addEventListener("click", () => setView("compact"));
document.getElementById("view-cards").addEventListener("click", () => setView("cards"));

bulkRefresh = initBulkBar(document.getElementById("bulk-bar-host"), {
  getVisibleLeads: () => shownLeads,
  reload: () => loadLeads(),
});

loadLeads();
