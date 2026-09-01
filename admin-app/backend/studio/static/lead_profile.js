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

  let heroIndex = 0;
  const showHero = (url) => {
    heroIndex = Math.max(0, list.indexOf(url));
    hero.innerHTML = isVideoUrl(url)
      ? `<video src="${escapeHtml(url)}" controls muted></video>`
      : `<img src="${escapeHtml(url)}" alt="">`;
  };
  showHero(list[0]);

  hero.onclick = (e) => {
    // A video in the hero has its own controls; clicking those shouldn't
    // yank the user into a lightbox.
    if (e.target.tagName === "VIDEO") return;
    openLightbox(list, heroIndex, (lead && lead.photo_rooms) || null);
  };
  hero.classList.add("is-zoomable");

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

  // Outside the video frame: .lp-video is a fixed 16:9 centred flex box, so
  // anything appended inside it gets squeezed alongside the player.
  const linkBox = el("lp-video-link-box");
  if (linkBox) {
    linkBox.innerHTML = finishedVideoHtml();
    wireFinishedVideo();
  }
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
  initGenerator(lead.photo_urls);
  initRooms();

  el("lp-refetch").addEventListener("click", () => pullPhotos(true));
  pullPhotos(false);
}

load();

/* ---------- video generator ----------
   Generating spends real money per clip, so the cost is shown before the
   button and nothing starts without a click. Progress is polled from the job
   row rather than guessed, because a clip takes minutes and a spinner that
   says nothing is worse than a count. */

let genStatus = null;
let genPollTimer = null;

function selectedGenPhotos() {
  return [...document.querySelectorAll(".lp-gen-photo input:checked")].map((i) => i.value);
}

function updateGenCost() {
  const box = el("lp-gen-cost");
  if (!box || !genStatus) return;
  const count = selectedGenPhotos().length;
  const seconds = Number(el("lp-gen-seconds").value) || 0;
  const total = count * seconds * genStatus.cost_per_second;

  el("lp-gen-go").disabled = !count || genStatus.busy;
  box.textContent = count
    ? `${count} clip${count === 1 ? "" : "s"} × ${seconds}s ≈ $${total.toFixed(2)}`
    : "No photos selected";
}

function renderGenPhotos(photos) {
  const box = el("lp-gen-photos");
  if (!box) return;
  box.innerHTML = (photos || []).map((url, i) => `
    <label class="lp-gen-photo">
      <input type="checkbox" value="${escapeHtml(url)}">
      <img src="${escapeHtml(url)}" alt="">
      <span class="lp-gen-photo-n">${i + 1}</span>
    </label>`).join("");
  box.querySelectorAll("input").forEach((i) => i.addEventListener("change", updateGenCost));
}

function renderGenJob(job) {
  const progress = el("lp-gen-progress");
  const results = el("lp-gen-results");
  if (!progress || !results) return;

  if (!job) {
    progress.classList.add("hidden");
    results.innerHTML = "";
    return;
  }

  const running = job.status === "queued" || job.status === "running";
  progress.classList.toggle("hidden", !running);
  if (running) {
    progress.innerHTML = `
      <span class="lp-gen-spin"></span>
      Generating clip ${Math.min(job.clips_done + 1, job.clips_total)} of ${job.clips_total}…
      <button type="button" id="lp-gen-cancel" class="btn-tiny">Cancel</button>`;
    const cancel = el("lp-gen-cancel");
    if (cancel) cancel.onclick = () => cancelGenJob(job.id);
  }

  const done = (job.clips || []).filter((c) => c.video_url);
  const failed = (job.clips || []).filter((c) => c.status === "failed");

  let html = "";
  if (job.status === "failed" && !done.length) {
    html += `<p class="lp-gen-error">Failed: ${escapeHtml(job.error || "unknown error")}</p>`;
  }
  if (failed.length) {
    html += `<p class="lp-gen-error">${failed.length} clip${failed.length === 1 ? "" : "s"} failed: ${escapeHtml(failed[0].error || "")}</p>`;
  }
  if (done.length) {
    html += `<div class="lp-gen-clips">` + done.map((c) => `
      <figure class="lp-gen-clip">
        <video src="${escapeHtml(c.video_url)}" controls preload="metadata"></video>
        <figcaption>
          <button type="button" class="btn-tiny lp-gen-use" data-url="${escapeHtml(c.video_url)}">
            Use as finished video
          </button>
        </figcaption>
      </figure>`).join("") + `</div>`;
    if (done.length > 1) {
      html += `<p class="hint">Stitching several clips into one video isn't built yet — for now each is separate.</p>`;
    }
  }
  results.innerHTML = html;

  results.querySelectorAll(".lp-gen-use").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_url: btn.dataset.url }),
        });
        Object.assign(lead, updated);
        renderVideo(currentProject);
      } catch (err) {
        alert(err.message || "Could not save that.");
        btn.disabled = false;
      }
    };
  });

  // Keep polling only while there is something to watch.
  clearTimeout(genPollTimer);
  if (running) genPollTimer = setTimeout(pollGenJob, 4000);
}

async function pollGenJob() {
  try {
    const { job } = await fetchJSON(`/studio/api/leads/${LEAD_ID}/video/job`);
    renderGenJob(job);
  } catch (_) {
    /* transient; the next poll can pick it up */
  }
}

async function cancelGenJob(jobId) {
  try {
    await fetchJSON(`/studio/api/video/jobs/${jobId}/cancel`, { method: "POST" });
    await pollGenJob();
  } catch (err) {
    alert(err.message);
  }
}

async function startGenJob() {
  const photos = selectedGenPhotos();
  const seconds = Number(el("lp-gen-seconds").value) || 5;
  const cost = (photos.length * seconds * genStatus.cost_per_second).toFixed(2);

  if (!confirm(`Generate ${photos.length} clip${photos.length === 1 ? "" : "s"} for about $${cost}?\n\nThis charges your Atlas Cloud account.`)) return;

  const btn = el("lp-gen-go");
  btn.disabled = true;
  try {
    const { job } = await fetchJSON(`/studio/api/leads/${LEAD_ID}/video/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        photos,
        duration: seconds,
        resolution: el("lp-gen-resolution").value,
        prompt: el("lp-gen-prompt").value,
      }),
    });
    renderGenJob(job);
  } catch (err) {
    alert(err.message || "Could not start the generator.");
  } finally {
    btn.disabled = false;
  }
}

async function initGenerator(photos) {
  const state = el("lp-gen-state");
  const body = el("lp-gen-body");
  if (!state || !body) return;

  try {
    genStatus = await fetchJSON("/studio/api/video/status");
  } catch (_) {
    state.textContent = "Couldn't check the generator.";
    return;
  }

  if (!genStatus.configured) {
    state.textContent = "Not connected";
    state.className = "lp-gen-state is-warn";
    body.classList.add("hidden");
    // A broken config file is a different problem from a missing one, and
    // saying so saves hunting for a key that is already in the file.
    el("lp-gen-results").innerHTML = genStatus.config_error
      ? `<p class="lp-gen-error">${escapeHtml(genStatus.config_error)}</p>`
      : `<p class="hint">Add an Atlas Cloud key to <code>studio/atlascloud.json</code> to enable this.</p>`;
    return;
  }

  state.textContent = genStatus.model;
  body.classList.remove("hidden");

  renderGenPhotos(photos);
  el("lp-gen-prompt").value = genStatus.default_prompt || "";
  el("lp-gen-seconds").min = genStatus.min_duration;
  el("lp-gen-seconds").max = genStatus.max_duration;
  el("lp-gen-seconds").addEventListener("input", updateGenCost);
  el("lp-gen-go").onclick = startGenJob;
  updateGenCost();

  await pollGenJob();
}

/* ---------- photos grouped by room ----------
   Sorting happens automatically when a lead is captured; this just shows the
   result, and offers a re-run for leads captured before it existed or whose
   photos were re-fetched afterwards. Anything the classifier skipped stays
   visible under "Unsorted" rather than disappearing. */

let roomsPollTimer = null;
let roomsSortRunning = false;

function renderRooms(data) {
  const box = el("lp-rooms");
  if (!box) return;

  if (!data.photo_count) {
    box.innerHTML = "";
    return;
  }
  // Not connected is not a dead end: Claude can read the photos and write the
  // labels back without any API key, which is the free route.

  const pending = data.photo_count - data.sorted_count;
  const groups = (data.groups || []).filter((g) => g.room !== "unsorted" || g.photos.length);

  const keepResults = el("lp-rooms-results");
  const carried = keepResults ? keepResults.innerHTML : "";

  box.innerHTML = `
    <div class="lp-rooms-head">
      <span class="lp-rooms-title">By room</span>
      <span class="lp-rooms-note">
        ${data.sorted_count} of ${data.photo_count} sorted${pending > 0 ? "" : ""}
      </span>
      ${pending > 0 ? `<button type="button" id="lp-rooms-go" class="btn-tiny">Sort ${pending} photos</button>` : ""}
    </div>
    ${groups.map((g) => `
      <details class="lp-room" ${g.room === "unsorted" ? "" : "open"}>
        <summary>
          ${escapeHtml(g.label)}
          <span class="lp-room-count">${g.photos.length}</span>
        </summary>
        <div class="lp-room-grid" data-room="${escapeHtml(g.room)}">
          ${g.photos.map((u, i) => `<button type="button" data-i="${i}"><img src="${escapeHtml(u)}" alt="" loading="lazy"></button>`).join("")}
        </div>
      </details>`).join("")}
    <div id="lp-rooms-results">${carried}</div>`;

  // Opening from a room group shows that room's photos, not the whole
  // gallery -- you clicked "Kitchen", you want the kitchen.
  box.querySelectorAll(".lp-room-grid").forEach((grid) => {
    const group = groups.find((g) => g.room === grid.dataset.room);
    if (!group) return;
    grid.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        // The full gallery, positioned at this photo -- the viewer's room
        // directory then lets you move on to another room, which scoping it
        // to one group would prevent.
        const all = lead.photo_urls || [];
        const url = group.photos[Number(btn.dataset.i)];
        openLightbox(all, Math.max(0, all.indexOf(url)), lead.photo_rooms || null);
      });
    });
  });

  const go = el("lp-rooms-go");
  if (go) {
    go.onclick = () => (data.configured ? sortViaApi(go) : sortViaSheets(go));
  }
}

/* With a key configured the app sorts the photos itself, in the background. */
async function sortViaApi(button) {
  button.disabled = true;
  button.textContent = "Sorting…";
  try {
    await fetchJSON(`/studio/api/leads/${LEAD_ID}/rooms`, { method: "POST" });
    roomsSortRunning = true;
    pollRooms(true);
  } catch (err) {
    alert(err.message || "Could not start sorting.");
    button.disabled = false;
  }
}

/* Without one, it does the part a button can do: builds the contact sheets and
   hands them over. Something still has to look at the photos, and that part is
   Claude reading these three images rather than the app paying per photo. */
async function sortViaSheets(button) {
  button.disabled = true;
  button.textContent = "Building sheets…";
  let data;
  try {
    data = await fetchJSON(`/studio/api/leads/${LEAD_ID}/rooms/sheets`, { method: "POST" });
  } catch (err) {
    alert(err.message || "Could not build the contact sheets.");
    button.disabled = false;
    button.textContent = "Sort photos";
    return;
  }

  el("lp-rooms-results").innerHTML = `
    <div class="lp-sheets">
      <p class="lp-sheets-note">
        <strong>${data.sheets.length} contact sheet${data.sheets.length === 1 ? "" : "s"} ready</strong>
        — ${data.photo_count} photos, numbered.
        Ask Claude to sort lead ${LEAD_ID} and it will read these and fill the rooms in.
      </p>
      <div class="lp-sheets-grid">
        ${data.sheets.map((u, i) => `
          <a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" title="Open sheet ${i + 1}">
            <img src="${escapeHtml(u)}" alt="Contact sheet ${i + 1}">
          </a>`).join("")}
      </div>
    </div>`;

  button.disabled = false;
  button.textContent = "Rebuild sheets";
}

async function pollRooms(keepGoing) {
  clearTimeout(roomsPollTimer);
  let data;
  try {
    data = await fetchJSON(`/studio/api/leads/${LEAD_ID}/rooms`);
  } catch (_) {
    return;
  }
  renderRooms(data);
  // Only while a sort is actually running. Polling merely because photos are
  // unsorted would hit the server every five seconds forever on a lead nobody
  // is sorting, and rebuild this panel each time.
  if (keepGoing && roomsSortRunning && data.sorted_count < data.photo_count) {
    roomsPollTimer = setTimeout(() => pollRooms(true), 5000);
  } else if (data.sorted_count >= data.photo_count) {
    roomsSortRunning = false;
  }
}

function initRooms() {
  // A freshly captured lead may still be sorting in the background, so watch
  // briefly; roomsSortRunning stops it once nothing is in flight.
  roomsSortRunning = true;
  pollRooms(true);
  setTimeout(() => { roomsSortRunning = false; }, 60000);
}
