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

  wireStatRange();
  renderStats();

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

let statRange = "day";

function wireStatRange() {
  const group = document.getElementById("stat-range");
  if (!group) return;
  group.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      statRange = btn.dataset.range;
      group.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("is-on", b === btn));
      renderStats();
    });
  });
}

const set = (id, text) => {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
};

/* Whole dollars where the figure is a headline, cents where it is the
   detail underneath -- cents in a large number are noise, and rounding in a
   small one is a lie. */
const dollars = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const cents = (n) => "$" + n.toLocaleString("en-US", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function renderStats() {
  let s;
  try {
    const res = await fetch("/studio/api/stats?range=" + encodeURIComponent(statRange));
    if (!res.ok) throw new Error("unavailable");
    s = await res.json();
  } catch (err) {
    set("stat-revenue", "—");
    return;
  }

  const m = s.money, a = s.activity, p = s.pipeline;

  set("stat-revenue", dollars(m.revenue));
  // Profit is stated against the spend it came from: a margin alone cannot
  // say whether it is thin because the work was cheap or the price was.
  set("stat-profit", m.revenue || m.spend
    ? `${cents(m.profit)} profit after ${cents(m.spend)} rendering`
    : "Nothing spent or earned");

  set("stat-deals", a.deals_closed);
  set("stat-avg-deal", a.deals_closed ? `${cents(m.avg_deal)} average` : "");

  set("stat-leads-added", a.leads_added);
  set("stat-leads-sub", s.label.toLowerCase());
  // The link carries the period, so the Lead Manager opens on exactly the
  // leads this number counted rather than on all of them.
  const leadsLink = document.getElementById("link-stat-leads-added");
  if (leadsLink) leadsLink.href = "/studio/leads?added=" + encodeURIComponent(s.range);

  const touches = a.emails_sent + a.calls_made + a.videos_sent;
  set("stat-outreach", touches);
  set("stat-outreach-detail", touches
    ? [plural(a.emails_sent, "email", "emails"),
       plural(a.calls_made, "call", "calls"),
       plural(a.videos_sent, "video", "videos")].join(" · ")
    : "Nothing sent " + s.label.toLowerCase());

  // These do not move with the period, so they say "now" rather than
  // borrowing the heading the period cards sit under.
  set("stat-active-projects", p.active_projects);
  set("stat-projects-todo-sub", p.projects_todo
    ? `${p.projects_todo} with no media yet`
    : "All have media made");
  // Counts leads awaiting a reply, because that is what its link opens --
  // a card whose number and destination disagree is worse than no link.
  // The never-contacted count rides along in the sub-line so it stays
  // visible; it is the other half of "who needs an email".
  set("stat-awaiting", p.to_follow_up);
  set("stat-to-contact-sub", p.to_contact
    ? `${p.to_contact} not contacted yet`
    : "Everyone has been contacted");
  set("stat-hot-leads", p.hot_leads);
}
