const OUTREACH_LABELS = [["email", "Email sent"], ["phone", "Phone called"], ["video", "Video made"]];

const LEAD_ID = window.LEAD_ID;
let lead = null;
// Kept so the video panel can re-render itself after the link is saved.
let currentProject = null;

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
/* ---------- editable contact details ---------- */

/* A listing often doesn't publish the agent's email -- Zillow never does --
   so it gets looked up and typed in here. Kept editable rather than
   read-only because the research offers options and a person decides. */

let saveContactField = null;

function wireContactEditing() {
  const emailInput = el("lp-agent-email");
  const brokerInput = el("lp-brokerage");
  const state = el("lp-contact-state");
  const findButton = el("lp-find-email");

  emailInput.value = lead.agent_email || "";
  brokerInput.value = lead.brokerage || "";

  findButton.disabled = !lead.agent_name;
  findButton.textContent = lead.agent_email ? "Check email" : "Find email";
  findButton.addEventListener("click", runEmailResearch);

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
      findButton.textContent = lead.agent_email ? "Check email" : "Find email";
      renderLead();
    } catch (err) {
      state.textContent = err.message || "Couldn't save.";
    }
  };

  saveContactField = save;
  emailInput.addEventListener("blur", () => save("agent_email", emailInput));
  brokerInput.addEventListener("blur", () => save("brokerage", brokerInput));
  [emailInput, brokerInput].forEach((input) =>
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    })
  );
}

/* ---------- ranked email candidates ---------- */

/* Ranked email candidates.

   The automatic lookup on capture stores what it found; this shows the same
   list and lets a different one be chosen. Nothing here is a guess dressed up
   as fact -- each option carries the reason it might be this agent's, and the
   strongest signal is that the page carrying the address also showed the
   phone number from the listing. */

function renderCandidates(candidates, note) {
  const box = el("lp-candidates");
  const list = candidates || [];
  if (!list.length && !note) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  if (!list.length) {
    box.innerHTML = `<p class="lp-candidates-note">${escapeHtml(note)}</p>`;
    return;
  }

  box.innerHTML =
    `<p class="lp-candidates-note">${escapeHtml(
      note || "Most likely first. Nothing is sent until you pick one."
    )}</p>` +
    list
      .map(
        (c, i) => `
      <div class="lp-candidate ${c.confident ? "is-confident" : ""} ${
          c.email === lead.agent_email ? "is-current" : ""
        }">
        <div class="lp-candidate-top">
          <span class="lp-candidate-rank">${i + 1}</span>
          <span class="lp-candidate-email">${escapeHtml(c.email)}</span>
          ${c.confident ? '<span class="lp-candidate-badge">confident</span>' : ""}
          ${
            c.email === lead.agent_email
              ? '<span class="lp-candidate-badge is-current-badge">in use</span>'
              : `<button type="button" class="btn-secondary btn-tiny lp-use" data-email="${escapeHtml(
                  c.email
                )}">Use this</button>`
          }
        </div>
        ${(c.supports || []).length
          ? `<ul class="lp-candidate-why for">${c.supports.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
          : ""}
        ${(c.concerns || []).length
          ? `<ul class="lp-candidate-why against">${c.concerns.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
          : ""}
        <div class="lead-candidate-source">source: ${escapeHtml((() => { try { return new URL(c.source).host; } catch (e) { return "unknown"; } })())}</div>
      </div>`
      )
      .join("");

  box.querySelectorAll(".lp-use").forEach((btn) => {
    btn.addEventListener("click", async () => {
      el("lp-agent-email").value = btn.dataset.email;
      await saveContactField("agent_email", el("lp-agent-email"));
      renderCandidates(lead.email_candidates, note);
    });
  });
}

async function runEmailResearch() {
  const button = el("lp-find-email");
  const state = el("lp-contact-state");
  button.disabled = true;
  state.textContent = "Searching…";
  try {
    const found = await fetchJSON(`/studio/api/leads/${LEAD_ID}/find-email`, { method: "POST" });
    if (found.error) throw new Error(found.error);
    lead.email_candidates = found.candidates || [];
    state.textContent = "";
    renderCandidates(
      lead.email_candidates,
      found.blocked
        ? "The search endpoint is rate limiting us right now — worth trying again in a few minutes."
        : lead.email_candidates.length
        ? null
        : "Nothing published for this agent was found."
    );
  } catch (err) {
    state.textContent = err.message || "Search failed.";
  }
  button.disabled = false;
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
  } else {
    box.innerHTML = `
      <div class="lp-video-empty">
        <div class="lp-video-empty-label">${project ? "Project started — no video yet" : "No project video yet"}</div>
        <a class="cta-btn cta-btn-sm" href="/studio/create?lead_id=${LEAD_ID}">${project ? "Open project" : "Create Video"}</a>
      </div>`;
  }

  box.insertAdjacentHTML("beforeend", finishedVideoHtml());
  wireFinishedVideo();
}

/* The finished video, wherever it ended up being hosted. Nothing in this app
   renders video yet, so this is pasted in by hand -- and it is what makes the
   lead sendable, since the outreach email exists to show the agent this. */
function finishedVideoHtml() {
  return `
    <div class="lp-video-link">
      <label class="lp-video-link-label" for="lp-video-url">Finished video link</label>
      <div class="lp-video-link-row">
        <input id="lp-video-url" type="url" placeholder="https://…"
               value="${escapeHtml(lead.video_url || "")}">
        <button id="lp-video-save" class="btn-tiny" type="button">Save</button>
      </div>
      <p class="lp-video-link-hint">${
        lead.video_url
          ? `Ready to send from the <a href="/studio/outreach">outreach queue</a>.`
          : `Paste the link an agent can watch it at. Until then this lead can't be sent.`
      }</p>
    </div>`;
}

function wireFinishedVideo() {
  const input = el("lp-video-url");
  const button = el("lp-video-save");
  if (!input || !button) return;

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_url: input.value.trim() }),
      });
      Object.assign(lead, updated);
      renderVideo(currentProject);
    } catch (err) {
      alert(err.message || "Could not save that link.");
      button.disabled = false;
    }
  });
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
  renderCandidates(lead.email_candidates);
  renderChecklist();
  wireNotes();
  currentProject = (projects || []).find((p) => p.lead_id === lead.id) || null;
  renderVideo(currentProject);
  renderPhotos(lead.photo_urls);

  el("lp-refetch").addEventListener("click", () => pullPhotos(true));
  pullPhotos(false);
}

load();
