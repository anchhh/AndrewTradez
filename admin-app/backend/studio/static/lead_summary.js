/* The top of Lead management: where the pipeline stands, what has been done
   lately, and the switch between the lead list and the send queue.

   It fetches its own copy of the leads rather than reading the list script's
   state. The two scripts share a global scope but not their variables, and
   reaching into another file's `let` to save one request is the kind of
   coupling that breaks silently when either file is edited. */

const STATUS_META = [
  ["new",       "New",       "#c9a227"],
  ["contacted", "Contacted", "#4a7fb5"],
  ["responded", "Responded", "#ef5a2b"],
  ["converted", "Converted", "#3f8f5f"],
  ["dead",      "Dead",      "#9a938a"],
];

let summaryRange = "month";

/* ---------- the donut ----------

   Drawn as one circle per slice with a dash gap, which needs no library and
   scales cleanly. r=60 so the circumference is a round-ish 377; every slice
   is a fraction of that. */
function donut(counts, total) {
  const R = 60, C = 2 * Math.PI * R;
  let offset = 0;

  const rings = STATUS_META.map(([key, , colour]) => {
    const n = counts[key] || 0;
    if (!n) return "";
    const len = (n / total) * C;
    const ring = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${colour}"
      stroke-width="18" stroke-dasharray="${len} ${C - len}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"></circle>`;
    offset += len;
    return ring;
  }).join("");

  return `
    <svg viewBox="0 0 140 140" class="lm-donut" role="img"
         aria-label="Leads by status">
      <circle cx="70" cy="70" r="60" fill="none" stroke="var(--line)" stroke-width="18"></circle>
      ${rings}
      <text x="70" y="66" class="lm-donut-num">${total}</text>
      <text x="70" y="84" class="lm-donut-cap">leads</text>
    </svg>`;
}

function legend(counts, total) {
  return STATUS_META.map(([key, label, colour]) => {
    const n = counts[key] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return `
      <li class="lm-legend-row${n ? "" : " is-zero"}">
        <span class="lm-swatch" style="background:${colour}"></span>
        <span class="lm-legend-name">${label}</span>
        <span class="lm-legend-n">${n}</span>
        <span class="lm-legend-pct">${pct}%</span>
      </li>`;
  }).join("");
}

async function renderSummary() {
  const box = document.getElementById("lm-summary");
  if (!box) return;

  let leads = [], stats = null;
  try {
    const [a, b] = await Promise.all([
      fetch("/studio/api/leads").then((r) => r.json()),
      fetch("/studio/api/stats?range=" + encodeURIComponent(summaryRange))
        .then((r) => r.json()),
    ]);
    leads = Array.isArray(a) ? a : [];
    stats = b;
  } catch (err) {
    box.innerHTML = `<p class="hint">Couldn't load the summary.</p>`;
    return;
  }

  const counts = {};
  leads.forEach((l) => {
    const key = STATUS_META.some(([k]) => k === l.status) ? l.status : "new";
    counts[key] = (counts[key] || 0) + 1;
  });
  const total = leads.length;

  const a = stats.activity || {}, p = stats.pipeline || {};
  const tiles = [
    ["Leads added", a.leads_added, stats.label ? stats.label.toLowerCase() : ""],
    ["Emails sent", a.emails_sent, "in the same period"],
    ["Awaiting reply", p.to_follow_up, "contacted, no answer"],
    ["Responded", p.hot_leads, "waiting on you"],
  ];

  box.innerHTML = `
    <div class="lm-summary-chart">
      ${total ? donut(counts, total)
              : `<p class="hint">No leads captured yet.</p>`}
      <ul class="lm-legend">${total ? legend(counts, total) : ""}</ul>
    </div>

    <div class="lm-summary-stats">
      <div class="lm-range" id="summary-range" role="group" aria-label="Period">
        ${[["day", "Today"], ["week", "This week"], ["month", "This month"],
           ["all", "All time"]].map(([key, label]) => `
          <button type="button" data-range="${key}"
                  class="${key === summaryRange ? "is-on" : ""}">${label}</button>`).join("")}
      </div>
      <div class="lm-summary-grid">
        ${tiles.map(([label, value, note]) => `
          <div class="lm-stat">
            <div class="lm-stat-label">${label}</div>
            <div class="lm-stat-value">${value == null ? "—" : value}</div>
            <div class="lm-stat-sub">${note}</div>
          </div>`).join("")}
      </div>
    </div>`;

  document.getElementById("summary-range").querySelectorAll("button")
    .forEach((btn) => btn.addEventListener("click", () => {
      summaryRange = btn.dataset.range;
      renderSummary();
    }));

  const leadCount = document.getElementById("tab-count-leads");
  if (leadCount) leadCount.textContent = total ? total : "";
}

/* ---------- the two panels ---------- */

function showTab(name, remember = true) {
  const wanted = name === "outreach" ? "outreach" : "leads";
  document.getElementById("panel-leads").hidden = wanted !== "leads";
  document.getElementById("panel-outreach").hidden = wanted !== "outreach";
  document.querySelectorAll(".lm-tabs .task-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === wanted);
    tab.setAttribute("aria-selected", String(tab.dataset.tab === wanted));
  });

  if (!remember) return;
  // Kept in the URL so a refresh, or a link sent to yourself, lands on the
  // same panel. replaceState rather than push: switching tabs is not a
  // separate place, and Back should leave the page.
  const url = new URL(location.href);
  if (wanted === "leads") url.searchParams.delete("tab");
  else url.searchParams.set("tab", "outreach");
  history.replaceState(null, "", url);
}

document.querySelectorAll(".lm-tabs .task-tab").forEach((tab) => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});

const params = new URLSearchParams(location.search);
// A focus from the dashboard is a request for the queue, whether or not the
// link also said which tab.
showTab(params.get("tab") === "outreach" || params.get("focus") ? "outreach" : "leads",
        false);

renderSummary();
