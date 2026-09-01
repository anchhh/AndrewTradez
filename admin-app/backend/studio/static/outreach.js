/*
 * The outreach review queue.
 *
 * Sending is the only thing in this app that reaches a real person, and the
 * addresses come from research that is sometimes wrong, so every send is one
 * deliberate click with the address shown in the confirmation. Nothing here
 * fires automatically.
 */
const el = (id) => document.getElementById(id);

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = {};
  try {
    body = await res.json();
  } catch (_) {
    /* a non-JSON error page; the status is all we have */
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* ---------- connection banner ---------- */

/* Connection state lives in the corner as a dot: it matters when it is wrong,
   and the rest of the time it should not be the loudest thing on the page.
   The detail is on hover, and clicking re-tests. */

/* Lines are joined rather than written with escapes: a tooltip is the one
   place multi-line strings are unavoidable, and every editing pass through a
   shell has mangled the escapes in them. */
const lines = (...parts) => parts.filter((p) => p !== null && p !== undefined).join("\n");

async function checkConnection() {
  const pip = el("ghl-status");
  if (!pip) return;
  pip.className = "ghl-pip is-checking";
  pip.title = "Checking the GoHighLevel connection…";

  let info;
  try {
    info = await api("/studio/api/outreach/status");
  } catch (err) {
    pip.className = "ghl-pip is-bad";
    pip.title = lines(`Could not check the connection: ${err.message}`, "", "Click to retry.");
    return;
  }

  if (!info.ok) {
    pip.className = "ghl-pip is-bad";
    const fields = (info.expected_fields || []).join(", ");
    pip.title = lines(
      // The server's message already says it isn't connected, so don't say it twice.
      info.error || "GoHighLevel isn't connected.",
      fields ? "" : null,
      fields ? `Once connected, create these custom fields: ${fields}` : null,
      "",
      "Click to retry."
    );
    return;
  }

  const missing = info.custom_fields_missing || [];
  if (missing.length) {
    pip.className = "ghl-pip is-warn";
    pip.title = lines(
      `Connected, but ${missing.length} merge field${missing.length > 1 ? "s are" : " is"} missing:`,
      missing.join(", "),
      "",
      "Emails will send with those left blank. Add them under Settings → Custom Fields.",
      "",
      "Click to re-check."
    );
  } else {
    pip.className = "ghl-pip is-good";
    pip.title = lines(
      "Connected to GoHighLevel. All merge fields present.",
      "",
      "Click to re-check."
    );
  }
}

/* ---------- cards ---------- */

function confidenceBadge(conf, clickable) {
  const cls = { high: "conf-high", direct: "conf-high", low: "conf-low", none: "conf-none" }[conf.level] || "conf-low";
  return clickable
    ? `<button type="button" class="conf-badge ${cls} act-why" title="Why this address?">${esc(conf.label)} <span class="conf-caret">▾</span></button>`
    : `<span class="conf-badge ${cls}">${esc(conf.label)}</span>`;
}

function confidenceDetail(conf) {
  const bits = [];
  (conf.supports || []).forEach((s) => bits.push(`<li class="conf-for">${esc(s)}</li>`));
  (conf.concerns || []).forEach((c) => bits.push(`<li class="conf-against">${esc(c)}</li>`));
  if (!bits.length) return "";
  return `<ul class="conf-list">${bits.join("")}</ul>`;
}

/* One row per lead, matching the Lead Manager. The reasoning behind an
   address is the thing worth reading before sending, but not the thing worth
   reading forty times -- so it collapses, and opens on the badge. */

function outreachRow(item, kind) {
  const lead = item.lead;
  const conf = item.confidence;
  const photo = (lead.photo_urls || [])[0];
  const place = [lead.city, lead.state].filter(Boolean).join(", ");
  const sub = [lead.agent_name, lead.brokerage || place].filter(Boolean).join(" · ");
  const hasWhy = (conf.supports || []).length || (conf.concerns || []).length;

  const right =
    kind === "ready"
      ? `<span class="or-email"><code>${esc(lead.agent_email)}</code></span>
         ${confidenceBadge(conf, hasWhy)}
         <a class="or-video" href="${esc(lead.video_url)}" target="_blank"
            rel="noopener noreferrer" title="Watch the video">▶</a>
         <button class="btn-tiny act-preview" type="button">Preview</button>
         <button class="btn-tiny act-skip" type="button">Skip</button>
         <button class="btn-send act-send" type="button">Send</button>`
      : kind === "waiting"
      ? `<span class="or-blockers">${item.blockers
           .map((b) => `<span class="outreach-blocker">${esc(b)}</span>`)
           .join("")}</span>`
      : `<span class="or-email"><code>${esc(lead.agent_email || "")}</code></span>
         <span class="outreach-sent-mark">Sent${lead.ghl_contact_id ? " · in GHL" : ""}</span>`;

  return `
    <div class="lm-row or-row ${kind === "sent" ? "is-sent" : ""}" data-id="${lead.id}">
      <button type="button" class="lm-row-thumb ${photo ? "" : "is-empty"}" title="View photos">
        ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy">` : ""}
      </button>
      <div class="lm-row-main">
        <a class="lm-row-address" href="/studio/leads/${lead.id}">${esc(lead.address || "Untitled listing")}</a>
        <span class="lm-row-sub">${esc(sub)}</span>
      </div>
      ${right}
    </div>
    ${hasWhy && kind === "ready"
      ? `<div class="or-why" data-for="${lead.id}" hidden>${confidenceDetail(conf)}</div>`
      : ""}
`;
}

const readyCard = (item) => outreachRow(item, "ready");
const waitingRow = (item) => outreachRow(item, "waiting");
const sentRow = (item) => outreachRow(item, "sent");

/* ---------- load + wire ---------- */

let lastQueue = { ready: [], waiting: [], sent: [] };

function findItem(id) {
  return [...lastQueue.ready, ...lastQueue.waiting, ...lastQueue.sent]
    .find((i) => String(i.lead.id) === String(id));
}

async function load() {
  const data = await api("/studio/api/outreach/queue");
  lastQueue = data;

  el("list-ready").innerHTML = data.ready.map(readyCard).join("");
  el("list-waiting").innerHTML = data.waiting.map(waitingRow).join("");
  el("list-sent").innerHTML = data.sent.map(sentRow).join("");

  el("count-ready").textContent = data.ready.length;
  el("count-waiting").textContent = data.waiting.length;
  el("count-sent").textContent = data.sent.length;

  el("empty-ready").hidden = data.ready.length > 0;
  el("empty-waiting").hidden = data.waiting.length > 0;
  el("empty-sent").hidden = data.sent.length > 0;

  el("skipped-note").textContent = data.skipped_count
    ? `${data.skipped_count} lead${data.skipped_count > 1 ? "s" : ""} skipped and hidden from this queue.`
    : "";

  wire();
}

function leadIdOf(node) {
  return node.closest("[data-id]").dataset.id;
}

function wire() {
  // The whole row opens the profile, as in the Lead Manager. Controls on it
  // are skipped by makeRowOpenProfile.
  document.querySelectorAll(".or-row").forEach((row) => {
    makeRowOpenProfile(row, row.dataset.id);
    const thumb = row.querySelector(".lm-row-thumb:not(.is-empty)");
    if (thumb) {
      thumb.addEventListener("click", () => {
        const item = findItem(row.dataset.id);
        if (item) openLightbox(item.lead.photo_urls || [], 0, item.lead.photo_rooms || null);
      });
    }
  });

  // The reasoning behind an address: worth reading once, not forty times.
  document.querySelectorAll(".act-why").forEach((btn) => {
    btn.onclick = () => {
      const id = leadIdOf(btn);
      const why = document.querySelector(`.or-why[data-for="${id}"]`);
      if (!why) return;
      why.hidden = !why.hidden;
      btn.classList.toggle("is-open", !why.hidden);
    };
  });

  document.querySelectorAll(".act-send").forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest(".or-row");
      const address = row.querySelector(".or-email code").textContent;
      const agent = row.querySelector(".lm-row-sub").textContent.split(" · ")[0];
      if (!confirm(`Send the video email to ${agent} at ${address}?

GoHighLevel will deliver it. This can't be unsent.`)) return;

      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        await api(`/studio/api/leads/${leadIdOf(btn)}/outreach/send`, { method: "POST" });
        await load();
        loadStats();
      } catch (err) {
        alert(`Not sent: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "Send";
      }
    };
  });

  document.querySelectorAll(".act-preview").forEach((btn) => {
    btn.onclick = async () => {
      const id = leadIdOf(btn);
      let box = document.querySelector(`.outreach-preview[data-for="${id}"]`);
      if (box) { box.remove(); return; }
      try {
        const result = await api(`/studio/api/leads/${id}/outreach/preview`, { method: "POST" });
        box = document.createElement("pre");
        box.className = "outreach-preview";
        box.dataset.for = id;
        box.textContent = JSON.stringify(result.payload, null, 2);
        btn.closest(".or-row").after(box);
      } catch (err) {
        alert(err.message);
      }
    };
  });

  document.querySelectorAll(".act-skip").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/studio/api/leads/${leadIdOf(btn)}/outreach/skip`, {
          method: "POST",
          body: JSON.stringify({ undo: false }),
        });
        await load();
      } catch (err) {
        alert(err.message);
      }
    };
  });

}

el("ghl-status").onclick = checkConnection;

// Async failures here surface as unhandled rejections rather than anything
// visible, so say so on the page instead of failing silently.
loadStats();

load().catch((err) => {
  el("empty-ready").hidden = false;
  el("empty-ready").textContent = `Could not load the queue: ${err.message}`;
});
checkConnection();

/* ---------- stats ----------
   Two sources side by side: what this app has done, and what GoHighLevel has
   seen. Opens and clicks are deliberately absent -- they live on campaign
   sends and this app sends by tagging a contact for a workflow, which GHL
   does not report on. An honest gap beats a confident zero. */

function statTile(value, label, hint) {
  return `<div class="or-stat" ${hint ? `title="${esc(hint)}"` : ""}>
    <span class="or-stat-value">${esc(value)}</span>
    <span class="or-stat-label">${esc(label)}</span>
  </div>`;
}

async function loadStats() {
  const box = el("or-stats");
  if (!box) return;
  let data;
  try {
    data = await api("/studio/api/outreach/stats");
  } catch (_) {
    box.innerHTML = "";
    return;
  }

  const a = data.app || {};
  const g = data.ghl;

  box.innerHTML = `
    <div class="or-stats-group">
      <span class="or-stats-title">In Estly</span>
      ${statTile(a.leads ?? 0, "leads")}
      ${statTile(a.with_email ?? 0, "with an email")}
      ${statTile(a.with_video ?? 0, "with a video")}
      ${statTile(a.sent ?? 0, "sent")}
    </div>
    ${g
      ? `<div class="or-stats-group">
           <span class="or-stats-title">In GoHighLevel</span>
           ${statTile(g.estly_contacts, "contacts", "Contacts tagged estly-lead")}
           ${statTile(g.video_ready, "emails triggered", "Tagged estly-video-ready, which fires the workflow")}
           ${statTile(g.conversations, g.conversations === 1 ? "conversation" : "conversations")}
           ${statTile(g.replies, "replied", g.replied_names.length ? g.replied_names.join(", ") : "Nobody has written back yet")}
         </div>
         <p class="or-stats-note">
           Opens and clicks aren't shown: those are reported for campaign sends,
           and these go out through a workflow, which GoHighLevel doesn't report
           on through the API. Replies are the number that matters anyway.
         </p>`
      : `<p class="or-stats-note">${esc(data.error || "GoHighLevel stats unavailable.")}</p>`}`;
}
