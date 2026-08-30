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

async function checkConnection() {
  const box = el("ghl-status");
  const text = box.querySelector(".ghl-status-text");
  box.className = "ghl-status ghl-status-checking";
  text.textContent = "Checking the GoHighLevel connection…";

  let info;
  try {
    info = await api("/studio/api/outreach/status");
  } catch (err) {
    box.className = "ghl-status ghl-status-bad";
    text.textContent = `Could not check the connection: ${err.message}`;
    return;
  }

  if (!info.ok) {
    box.className = "ghl-status ghl-status-bad";
    const fields = (info.expected_fields || []).map((f) => `<code>${esc(f)}</code>`).join(", ");
    text.innerHTML =
      `<strong>GoHighLevel isn't connected.</strong> ${esc(info.error || "")}` +
      (fields ? `<br>Once connected, create these custom fields in GHL: ${fields}` : "");
    return;
  }

  const missing = info.custom_fields_missing || [];
  if (missing.length) {
    box.className = "ghl-status ghl-status-warn";
    text.innerHTML =
      `<strong>Connected</strong>, but ${missing.length} merge field${missing.length > 1 ? "s are" : " is"} ` +
      `missing in GHL: ${missing.map((f) => `<code>${esc(f)}</code>`).join(", ")}.<br>` +
      `Emails will send with those left blank. Add them under Settings → Custom Fields.`;
  } else {
    box.className = "ghl-status ghl-status-good";
    text.innerHTML = `<strong>Connected to GoHighLevel.</strong> All merge fields present.`;
  }
}

/* ---------- cards ---------- */

function confidenceBadge(conf) {
  const cls = { high: "conf-high", direct: "conf-high", low: "conf-low", none: "conf-none" }[conf.level] || "conf-low";
  return `<span class="conf-badge ${cls}">${esc(conf.label)}</span>`;
}

function confidenceDetail(conf) {
  const bits = [];
  (conf.supports || []).forEach((s) => bits.push(`<li class="conf-for">${esc(s)}</li>`));
  (conf.concerns || []).forEach((c) => bits.push(`<li class="conf-against">${esc(c)}</li>`));
  if (!bits.length) return "";
  return `<ul class="conf-list">${bits.join("")}</ul>`;
}

function readyCard(item) {
  const lead = item.lead;
  const conf = item.confidence;
  const photo = (lead.photo_urls || [])[0];

  return `
    <article class="lead-card outreach-card" data-id="${lead.id}">
      <div class="lead-card-head">
        <a class="lead-card-address" href="/studio/leads/${lead.id}">${esc(lead.address || "Untitled listing")}</a>
        ${confidenceBadge(conf)}
      </div>
      <div class="lead-card-body">
        <div class="lead-card-media">
          ${photo ? `<img src="${esc(photo)}" alt="">` : `<div class="lead-card-media-empty"></div>`}
        </div>
        <div class="lead-card-info">
          <p class="lead-card-contact">
            <strong>${esc(lead.agent_name || "Unknown agent")}</strong>
            ${lead.brokerage ? ` · ${esc(lead.brokerage)}` : ""}
          </p>
          <p class="outreach-to">To: <code>${esc(lead.agent_email)}</code></p>
          ${confidenceDetail(conf)}
          <p class="outreach-video">
            Video: <a href="${esc(lead.video_url)}" target="_blank" rel="noopener noreferrer">${esc(lead.video_url)}</a>
          </p>
        </div>
      </div>
      <div class="lead-card-actions">
        <button class="btn-tiny act-preview" type="button">Preview payload</button>
        <button class="btn-tiny act-skip" type="button">Skip</button>
        <button class="btn-send act-send" type="button">Send via GoHighLevel</button>
      </div>
      <pre class="outreach-preview" hidden></pre>
    </article>`;
}

function waitingRow(item) {
  const lead = item.lead;
  const needsVideo = item.blockers.includes("no finished video for this listing");
  return `
    <div class="outreach-row" data-id="${lead.id}">
      <div class="outreach-row-main">
        <a href="/studio/leads/${lead.id}">${esc(lead.address || "Untitled listing")}</a>
        <span class="outreach-row-agent">${esc(lead.agent_name || "no agent")}</span>
      </div>
      <div class="outreach-row-blockers">
        ${item.blockers.map((b) => `<span class="outreach-blocker">${esc(b)}</span>`).join("")}
      </div>
      ${needsVideo ? `
        <div class="outreach-row-video">
          <input class="video-input" type="url" placeholder="Paste the finished video link…"
                 value="${esc(lead.video_url || "")}">
          <button class="btn-tiny act-save-video" type="button">Save</button>
        </div>` : ""}
    </div>`;
}

function sentRow(item) {
  const lead = item.lead;
  return `
    <div class="outreach-row outreach-row-sent" data-id="${lead.id}">
      <div class="outreach-row-main">
        <a href="/studio/leads/${lead.id}">${esc(lead.address || "Untitled listing")}</a>
        <span class="outreach-row-agent">${esc(lead.agent_name || "")} · ${esc(lead.agent_email || "")}</span>
      </div>
      <span class="outreach-sent-mark">Sent${lead.ghl_contact_id ? " · in GHL" : ""}</span>
    </div>`;
}

/* ---------- load + wire ---------- */

async function load() {
  const data = await api("/studio/api/outreach/queue");

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
  document.querySelectorAll(".act-send").forEach((btn) => {
    btn.onclick = async () => {
      const card = btn.closest(".outreach-card");
      const address = card.querySelector(".outreach-to code").textContent;
      const agent = card.querySelector(".lead-card-contact strong").textContent;
      if (!confirm(`Send the video email to ${agent} at ${address}?\n\nGoHighLevel will deliver it. This can't be unsent.`)) return;

      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        await api(`/studio/api/leads/${leadIdOf(btn)}/outreach/send`, { method: "POST" });
        await load();
      } catch (err) {
        alert(`Not sent: ${err.message}`);
        btn.disabled = false;
        btn.textContent = "Send via GoHighLevel";
      }
    };
  });

  document.querySelectorAll(".act-preview").forEach((btn) => {
    btn.onclick = async () => {
      const box = btn.closest(".outreach-card").querySelector(".outreach-preview");
      if (!box.hidden) {
        box.hidden = true;
        return;
      }
      try {
        const result = await api(`/studio/api/leads/${leadIdOf(btn)}/outreach/preview`, { method: "POST" });
        box.textContent = JSON.stringify(result.payload, null, 2);
        box.hidden = false;
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

  document.querySelectorAll(".act-save-video").forEach((btn) => {
    btn.onclick = async () => {
      const input = btn.closest(".outreach-row-video").querySelector(".video-input");
      btn.disabled = true;
      try {
        await api(`/studio/api/leads/${leadIdOf(btn)}`, {
          method: "PATCH",
          body: JSON.stringify({ video_url: input.value.trim() }),
        });
        await load();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    };
  });
}

el("ghl-test").onclick = checkConnection;

// Async failures here surface as unhandled rejections rather than anything
// visible, so say so on the page instead of failing silently.
load().catch((err) => {
  el("empty-ready").hidden = false;
  el("empty-ready").textContent = `Could not load the queue: ${err.message}`;
});
checkConnection();
