/* A page that is one filtered list of leads.

   Drives the closed-deals page: a question the dashboard raises and cannot
   answer in a tile -- "which ones?" It uses the same lead card as the Lead
   Manager, so a lead looks and behaves identically wherever it is met.
   Projects outgrew this and has its own page now.

   Which list is shown comes from window.LIST_MODE, set by the template. */

const LIST_MODES = {
  closed: {
    keep: (lead) => lead.sold_amount != null,
    // Most recent sale first: what just closed is what you want to see.
    sort: (a, b) => String(b.sold_at || "").localeCompare(String(a.sold_at || "")),
    empty: "Nothing sold yet — mark a package on a lead's profile when a client pays.",
  },
};

const cash = (n) => "$" + Number(n || 0).toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

async function loadLeadList() {
  const mode = LIST_MODES[window.LIST_MODE];
  const list = document.getElementById("lmg-list");
  const empty = document.getElementById("lmg-empty");
  const summary = document.getElementById("list-summary");

  let leads = [];
  try {
    leads = await fetchJSON("/studio/api/leads");
  } catch (err) {
    if (summary) summary.textContent = "Couldn't load leads.";
    return;
  }

  const shown = leads.filter(mode.keep).sort(mode.sort);

  list.className = "lm-rows";
  list.innerHTML = "";
  // No handlers: these pages are a way in to a profile, not a place to edit.
  // A change made here would need the list re-filtered under the user, which
  // is what the Lead Manager is for.
  shown.forEach((lead) => list.appendChild(buildLeadRow(lead, {})));

  empty.classList.toggle("hidden", shown.length !== 0);
  empty.textContent = mode.empty;

  if (summary) summary.textContent = summaryFor(window.LIST_MODE, shown);
}

function summaryFor(kind, shown) {
  if (!shown.length) return "";
  if (kind === "closed") {
    const total = shown.reduce((n, l) => n + (l.sold_amount || 0), 0);
    return `${shown.length} client${shown.length === 1 ? "" : "s"} · ${cash(total)} total` +
      ` · ${cash(total / shown.length)} average`;
  }
  return `${shown.length} project${shown.length === 1 ? "" : "s"}`;
}

loadLeadList();
