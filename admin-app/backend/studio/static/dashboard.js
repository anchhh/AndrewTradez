/* Dashboard: qualified leads only, one card each, ordered by status
   priority (hot first). The card itself lives in leads_shared.js so this
   page and the Lead Manager present a lead identically. */

let bulkRefresh = null;
let dashboardLeads = [];

function setStatus(message, cls) {
  const el = document.getElementById("leads-status");
  el.textContent = message || "";
  el.className = "status" + (cls ? ` ${cls}` : "");
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

  renderMoney();

  container.innerHTML = "";

  if (!leads.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const sorted = [...leads].sort(
    (a, b) => GROUP_ORDER.indexOf(groupKeyFor(a)) - GROUP_ORDER.indexOf(groupKeyFor(b))
  );

  dashboardLeads = sorted;
  pruneSelection(sorted);

  sorted.forEach((lead) => {
    container.appendChild(
      buildLeadCard(
        lead,
        { showNotes: true, project: projectByLeadId.get(lead.id) || null },
        {
          onChanged: loadDailyChecklist,
          onDeleted: loadDashboard,
          onSelectionChange: () => bulkRefresh && bulkRefresh(),
        }
      )
    );
  });

  if (bulkRefresh) bulkRefresh();
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

bulkRefresh = initBulkBar(document.getElementById("bulk-bar-host"), {
  getVisibleLeads: () => dashboardLeads,
  reload: () => loadDashboard(),
});

loadDashboard();
loadDailyChecklist();


/* ---------- revenue ----------

   Fetched rather than summed from the leads already on the page: spend is
   priced per delivered clip at the current rates, and a second copy of that
   arithmetic in the browser would drift from the lead profile's. The server
   computes both figures in one place, /api/money. */

async function renderMoney() {
  const value = document.getElementById("stat-revenue");
  const sub = document.getElementById("stat-profit");
  if (!value) return;
  try {
    const res = await fetch("/studio/api/money");
    if (!res.ok) throw new Error("unavailable");
    const money = await res.json();

    // Whole dollars in the headline -- cents in a figure this size are
    // noise -- but exact to the cent underneath, where they are the point.
    const cents = (n) => "$" + n.toLocaleString("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });

    value.textContent = "$" + money.revenue.toLocaleString("en-US", {
      maximumFractionDigits: 0,
    });
    // Spend is shown next to profit because profit alone cannot say whether
    // a thin margin came from charging little or from rendering a lot.
    sub.textContent = money.sold_count
      ? `${cents(money.profit)} profit after ${cents(money.spend)} rendering`
      : `Nothing sold yet · ${cents(money.spend)} spent rendering`;
  } catch (err) {
    value.textContent = "—";
    sub.textContent = "";
  }
}
