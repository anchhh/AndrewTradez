/* Lead Manager: one compact row per lead, with filters and sorting. The card
   component the Dashboard uses is deliberately not used here -- at the scale
   this page is for, a card per lead is six times the scrolling for the same
   information. Filtering and sorting run client-side over the set already
   fetched, so changing either is instant and never re-requests. */

let allLeads = [];
let shownLeads = [];
let bulkRefresh = null;

const filters = {
  added: "all",
  qualified: "all",
  status: "all",
  source: "all",
  outreach: "all",
  search: "",
  sort: "newest",
};


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

/* Local calendar boundaries, matching services/stats.py exactly -- the
   dashboard's "leads added" count links here, and a count that does not
   match the list it opens is worse than no link at all. Both run on this
   machine, so "local" means the same thing on each side. */
function addedSince(range) {
  if (range === "all") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));  // Monday
  if (range === "month") d.setDate(1);
  return d;
}

function matchesAdded(lead) {
  const since = addedSince(filters.added || "all");
  if (!since) return true;
  // created_at carries an explicit UTC offset, so this parses correctly.
  return lead.created_at && new Date(lead.created_at) >= since;
}

function visibleLeads() {
  return sortLeads(allLeads.filter((lead) => {
    if (!matchesAdded(lead)) return false;
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
  (filters.added && filters.added !== "all") ||
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

  list.className = "lm-rows";
  list.innerHTML = "";
  shown.forEach((lead) => list.appendChild(buildLeadRow(lead, handlers)));

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

  bind("filter-added", "added");
  bind("filter-qualified", "qualified");
  bind("filter-status", "status");
  bind("filter-source", "source");
  bind("filter-outreach", "outreach");
  bind("filter-search", "search", (v) => v.trim().toLowerCase());
  bind("filter-sort", "sort");

  document.getElementById("filter-reset").addEventListener("click", () => {
    ["filter-added", "filter-qualified", "filter-status", "filter-source",
     "filter-outreach"].forEach((id) => {
      document.getElementById(id).value = "all";
    });
    document.getElementById("filter-search").value = "";
    Object.assign(filters, { added: "all", qualified: "all", status: "all",
                             source: "all", outreach: "all", search: "" });
    render();
  });
}

/* The dashboard's "leads added" card links here with the period it was
   showing, so the list opens on exactly the leads that were counted. */
function applyUrlFilters() {
  const wanted = new URLSearchParams(location.search).get("added");
  const select = document.getElementById("filter-added");
  if (!wanted || !select) return;
  if ([...select.options].some((o) => o.value === wanted)) {
    select.value = wanted;
    filters.added = wanted;
  }
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
applyUrlFilters();

bulkRefresh = initBulkBar(document.getElementById("bulk-bar-host"), {
  getVisibleLeads: () => shownLeads,
  reload: () => loadLeads(),
});

loadLeads();
