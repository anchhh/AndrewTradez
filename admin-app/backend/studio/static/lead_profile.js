const OUTREACH_LABELS = [["email", "Email sent"], ["phone", "Phone called"], ["video", "Video made"]];

const LEAD_ID = window.LEAD_ID;
let lead = null;

const el = (id) => document.getElementById(id);

function setStatus(message, cls) {
  const node = el("lead-status");
  node.textContent = message || "";
  node.className = "status" + (cls ? ` ${cls}` : "");
}

/* ---------- pictures ---------- */

function renderPhotos(photos) {
  const hero = el("lp-hero");
  const thumbs = el("lp-thumbs");
  const list = photos || [];

  if (!list.length) {
    hero.innerHTML = `<div class="lp-hero-empty">No photos yet</div>`;
    thumbs.innerHTML = "";
    return;
  }

  const showHero = (url) => {
    hero.innerHTML = isVideoUrl(url)
      ? `<video src="${escapeHtml(url)}" controls muted></video>`
      : `<img src="${escapeHtml(url)}" alt="">`;
  };
  showHero(list[0]);

  thumbs.innerHTML = list
    .map(
      (url, i) => `<button type="button" class="lp-thumb ${i === 0 ? "is-active" : ""}" data-url="${escapeHtml(url)}">
        ${isVideoUrl(url) ? `<video src="${escapeHtml(url)}" muted></video>` : `<img src="${escapeHtml(url)}" alt="">`}
      </button>`
    )
    .join("");

  thumbs.querySelectorAll(".lp-thumb").forEach((btn) => {
    btn.addEventListener("click", () => {
      thumbs.querySelectorAll(".lp-thumb").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      showHero(btn.dataset.url);
    });
  });
}

// Fires automatically on open so a profile already has its pictures, the way
// Create Video pulls them from a pasted URL. The server caches into the lead,
// so this is a no-op read on every visit after the first.
async function pullPhotos(force) {
  const note = el("lp-photo-status");
  const btn = el("lp-refetch");
  note.textContent = force ? "Re-fetching photos…" : "Fetching photos from the listing…";
  btn.disabled = true;

  let data;
  try {
    data = await fetchJSON(`/studio/api/leads/${LEAD_ID}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: !!force }),
    });
  } catch (err) {
    note.textContent = "Couldn't reach the server to fetch photos.";
    btn.disabled = false;
    return;
  }

  btn.disabled = false;
  renderPhotos(data.photos);

  if (data.error) {
    note.textContent = data.blocked
      ? `${data.error} You can still upload photos from Create Video.`
      : data.error;
    note.className = "lp-photo-status is-warn";
  } else if (data.cached) {
    note.textContent = `${(data.photos || []).length} photo${(data.photos || []).length === 1 ? "" : "s"}`;
    note.className = "lp-photo-status";
  } else {
    const bits = [`${data.added} added`];
    if (data.duplicates) bits.push(`${data.duplicates} duplicate${data.duplicates === 1 ? "" : "s"} skipped`);
    if (data.failed) bits.push(`${data.failed} failed`);
    note.textContent = bits.join(" · ");
    note.className = "lp-photo-status";
  }
}

/* ---------- checklist ---------- */

function renderChecklist() {
  const box = el("lp-checklist");
  box.innerHTML = OUTREACH_LABELS.map(([field, label]) => checklistToggleHtml(lead, field, label)).join("");

  box.querySelectorAll(".lm-check-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}/outreach`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: btn.dataset.field }),
      });
      Object.assign(lead, updated);
      renderChecklist();
    });
  });
}

/* ---------- editable contact details ---------- */

/* A listing often doesn't publish the agent's email -- Zillow never does --
   so it gets looked up and typed in here. The search is built from what the
   listing did give us: the agent's name, their brokerage and the city. The
   brokerage is what makes the difference; searching a name alone turns up
   same-name agents in other states, which is how a Pennsylvania appraiser
   nearly ended up filed as a Cincinnati agent. */
function findEmailSearchUrl() {
  const terms = [lead.agent_name, lead.brokerage, lead.city, lead.state, "realtor email"]
    .filter(Boolean)
    .join(" ");
  return "https://duckduckgo.com/?q=" + encodeURIComponent(terms);
}

function wireContactEditing() {
  const emailInput = el("lp-agent-email");
  const brokerInput = el("lp-brokerage");
  const state = el("lp-contact-state");
  const findLink = el("lp-find-email");

  emailInput.value = lead.agent_email || "";
  brokerInput.value = lead.brokerage || "";

  const refreshLink = () => {
    findLink.href = findEmailSearchUrl();
    findLink.classList.toggle("hidden", !lead.agent_name || !!emailInput.value.trim());
  };
  refreshLink();

  const save = async (field, input) => {
    const value = input.value.trim();
    if ((lead[field] || "") === value) return;
    state.textContent = "Saving…";
    try {
      const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (updated.error) throw new Error(updated.error);
      Object.assign(lead, updated);
      state.textContent = "Saved";
      renderLead();
      refreshLink();
    } catch (err) {
      state.textContent = err.message || "Couldn't save.";
    }
  };

  emailInput.addEventListener("blur", () => save("agent_email", emailInput));
  brokerInput.addEventListener("blur", () => save("brokerage", brokerInput));
  [emailInput, brokerInput].forEach((input) =>
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    })
  );
}

/* ---------- notes ---------- */

function wireNotes() {
  const box = el("lp-notes");
  box.value = lead.notes || "";
  attachNotes(box, LEAD_ID, el("lp-notes-state"));
}

/* ---------- video panel ---------- */

function renderVideo(project) {
  const box = el("lp-video");
  const video = project && (project.photos || []).find(isVideoUrl);

  if (video) {
    box.innerHTML = `<video src="${escapeHtml(video)}" controls></video>`;
    return;
  }

  box.innerHTML = `
    <div class="lp-video-empty">
      <div class="lp-video-empty-label">${project ? "Project started — no video yet" : "No project video yet"}</div>
      <a class="cta-btn cta-btn-sm" href="/studio/create?lead_id=${LEAD_ID}">${project ? "Open project" : "Create Video"}</a>
    </div>`;
}

/* ---------- header ---------- */

function renderLead() {
  el("lp-address").textContent = addressLine(lead);
  el("lp-contact").textContent = contactLine(lead);
  el("lp-facts").textContent = [brokerageLine(lead), factsLine(lead)].filter(Boolean).join(" • ");

  const url = el("lp-url");
  if (lead.listing_url) {
    url.href = lead.listing_url;
    url.textContent = lead.listing_url;
    url.classList.remove("hidden");
  } else {
    url.classList.add("hidden");
  }

  el("lp-source").innerHTML = sourceBadgeHtml(lead.source);

  const select = el("lp-status-select");
  select.innerHTML = LEAD_STATUSES.map(
    (s) => `<option value="${s}" ${s === lead.status ? "selected" : ""}>${s}</option>`
  ).join("");
  select.onchange = async (e) => {
    const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: e.target.value }),
    });
    Object.assign(lead, updated);
  };

  const qualify = el("lp-qualify");
  const paintQualify = () => {
    qualify.textContent = lead.qualified ? "Qualified ✓" : "Mark Qualified";
    qualify.classList.toggle("is-qualified", !!lead.qualified);
  };
  paintQualify();
  qualify.onclick = async () => {
    const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}/qualify`, { method: "PATCH" });
    lead.qualified = updated.qualified;
    paintQualify();
  };
}

/* ---------- boot ---------- */

async function load() {
  let projects = [];
  try {
    [lead, projects] = await Promise.all([
      fetchJSON(`/studio/api/leads/${LEAD_ID}`),
      fetchJSON("/studio/api/projects").catch(() => []),
    ]);
  } catch (err) {
    setStatus("Couldn't load this lead.", "error");
    return;
  }

  if (!lead || lead.error) {
    setStatus(lead && lead.error ? lead.error : "Lead not found.", "error");
    return;
  }

  document.title = `${lead.address || "Lead"} — estly Studio`;
  el("lp-body").classList.remove("hidden");

  renderLead();
  wireContactEditing();
  renderChecklist();
  wireNotes();
  renderVideo((projects || []).find((p) => p.lead_id === lead.id) || null);
  renderPhotos(lead.photo_urls);

  el("lp-refetch").addEventListener("click", () => pullPhotos(true));
  pullPhotos(false);
}

load();
