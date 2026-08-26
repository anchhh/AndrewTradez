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
  shownLeads = shown;
  pruneSelection(shown);

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
          onSelectionChange: () => bulkRefresh && bulkRefresh(),
        }
      )
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

bulkRefresh = initBulkBar(document.getElementById("bulk-bar-host"), {
  getVisibleLeads: () => shownLeads,
  reload: () => loadLeads(),
});

loadLeads();

/* Extension key panel: fetched lazily the first time it's opened, so the
   key isn't sitting in the DOM of a page someone might screen-share. */
(function wireKeyPanel() {
  const panel = document.querySelector(".lm-key");
  if (!panel) return;
  const field = document.getElementById("api-key-value");
  const state = document.getElementById("api-key-state");
  let loaded = false;

  panel.addEventListener("toggle", async () => {
    if (!panel.open || loaded) return;
    try {
      const data = await fetchJSON("/studio/api/my-key");
      field.value = data.api_key || "";
      loaded = true;
    } catch (err) {
      field.value = "";
      state.textContent = "Couldn't load your key.";
    }
  });

  document.getElementById("api-key-copy").addEventListener("click", async () => {
    if (!field.value) return;
    try {
      await navigator.clipboard.writeText(field.value);
      state.textContent = "Copied";
    } catch (err) {
      field.select();
      state.textContent = "Press Ctrl+C to copy";
    }
    setTimeout(() => { state.textContent = ""; }, 2500);
  });
})();
