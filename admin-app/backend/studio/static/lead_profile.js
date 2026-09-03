const OUTREACH_LABELS = [["email", "Email sent"], ["phone", "Phone called"], ["video", "Video made"]];

const LEAD_ID = window.LEAD_ID;
let lead = null;
// Kept so the video panel can re-render itself after the link is saved.
let currentProject = null;
// Finished renders for this lead, from the job table.
let videoRuns = [];
// Which clip the stage is showing, kept across re-renders.
let videoPlaying = 0;

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
  // Same walkthrough order the viewer uses, so the strip and the fullscreen
  // gallery agree about what comes next.
  const list = orderPhotos(photos || [], (lead && lead.photo_rooms) || null);

  if (!list.length) {
    hero.innerHTML = `<div class="lp-hero-empty">No photos yet</div>`;
    thumbs.innerHTML = "";
    return;
  }

  let heroIndex = 0;
  const showHero = (url) => {
    heroIndex = Math.max(0, list.indexOf(url));
    const isCurrent = (lead.thumbnail_url || list[0]) === url;
    hero.innerHTML = (isVideoUrl(url)
      ? `<video src="${escapeHtml(url)}" controls muted></video>`
      : `<img src="${escapeHtml(url)}" alt="">`) +
      // A listing leads with whatever the site listed first, which is not
      // always the shot worth putting on a card.
      `<button type="button" class="lp-set-thumb ${isCurrent ? "is-current" : ""}"
               data-url="${escapeHtml(url)}" ${isVideoUrl(url) ? "hidden" : ""}>
         ${isCurrent ? "★ Lead thumbnail" : "☆ Use as thumbnail"}
       </button>`;

    const setBtn = hero.querySelector(".lp-set-thumb");
    if (setBtn) {
      setBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isCurrent) return;
        setBtn.textContent = "Saving…";
        try {
          const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ thumbnail_url: url }),
          });
          Object.assign(lead, updated);
          showHero(url);
          markThumbs();
        } catch (err) {
          setBtn.textContent = "Couldn't save";
        }
      });
    }
  };

  /* A star on the strip, so which one is the thumbnail is visible without
     opening each in turn. */
  const markThumbs = () => {
    const chosen = lead.thumbnail_url || list[0];
    thumbs.querySelectorAll(".lp-thumb").forEach((b) => {
      b.classList.toggle("is-thumbnail", b.dataset.url === chosen);
    });
  };

  showHero(lead.thumbnail_url && list.includes(lead.thumbnail_url)
    ? lead.thumbnail_url : list[0]);

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
  markThumbs();
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
          <button type="button" class="lead-candidate-drop lp-drop" data-email="${escapeHtml(c.email)}"
                  title="Not this one" aria-label="Dismiss ${escapeHtml(c.email)}">&times;</button>
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
      // The question is answered; the reasoning behind the rejected options
      // stops earning its space. Check email brings it all back.
      await dropCandidates({ clear: true });
    });
  });

  box.querySelectorAll(".lp-drop").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await dropCandidates({ remove: btn.dataset.email }, note);
    });
  });
}

async function dropCandidates(body, note) {
  try {
    const updated = await fetchJSON(`/studio/api/leads/${LEAD_ID}/candidates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    Object.assign(lead, updated);
  } catch (err) {
    alert(err.message || "Could not update the options.");
    return;
  }
  renderCandidates(lead.email_candidates, (lead.email_candidates || []).length ? note : null);
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

/* The Video tab.
 *
 * It used to read projects.json and say "Project started -- no video yet",
 * which stayed true forever: a render writes its clips to the VideoJob row and
 * never touches the project. So a lead with a finished clip showed no video,
 * which is the one thing this tab exists for.
 *
 * It now shows what was actually rendered for this lead -- every clip from
 * every render, newest run first -- and falls back to the project only to
 * offer a way to start one.
 */
function renderVideo(project) {
  const box = el("lp-video");
  const runs = videoRuns.filter((r) => r.clips && r.clips.length);

  if (!runs.length) {
    const running = videoRuns.some((r) => r.running);
    box.innerHTML = `
      <div class="lp-video-empty">
        <div class="lp-video-empty-label">${
          running ? "Rendering now — clips will appear here"
                  : (project ? "Project started — no clips yet" : "No clips yet")}</div>
        <a class="cta-btn cta-btn-sm" href="/studio/create/render?project=${
          project ? project.id : ""}">${running ? "See progress" : "Make a video"}</a>
      </div>`;
    return;
  }

  const clips = videoClips();
  if (videoPlaying >= clips.length) videoPlaying = 0;

  // One stage and a strip, rather than a grid of equal players grouped by
  // render. Which run a clip came from is bookkeeping; what it looks like is
  // the point, and only one of them can be watched at a time anyway. The
  // per-run cost that used to head each group now lives in the spend panel.
  box.innerHTML = `
    <div class="lp-scenery-head">
      <p class="lp-scenery-note">
        ${clips.length} clip${clips.length === 1 ? "" : "s"} across ${runs.length}
        render${runs.length === 1 ? "" : "s"}. Rendered with
        ${escapeHtml(runs[0].model_label || "the video model")}.
      </p>
      <button type="button" class="btn-capcut btn-tiny" id="lp-capcut">Open in CapCut</button>
      <a class="btn-secondary btn-tiny"
         href="/studio/create/video/clips?lead_id=${lead.id}">All videos</a>
    </div>

    <div class="lp-video-stage">
      <video id="lp-video-main" controls preload="metadata"
             src="${escapeHtml(clips[videoPlaying].video_url)}"></video>
      <figcaption id="lp-video-cap" class="lp-video-cap"></figcaption>
    </div>

    <div class="lp-video-strip" id="lp-video-strip">
      ${clips.map((clip, i) => `
        <button type="button" class="lp-video-thumb ${i === videoPlaying ? "is-on" : ""}"
                data-i="${i}" title="${escapeHtml(videoClipLabel(clip))}">
          <span class="lp-video-thumb-frame">
            <video src="${escapeHtml(clip.video_url)}#t=0.5" preload="metadata" muted></video>
            <span class="lp-video-thumb-n">${i + 1}</span>
          </span>
          <span class="lp-video-thumb-room">${
            escapeHtml(videoClipRoom(clip) || "Unsorted")}</span>
        </button>`).join("")}
    </div>`;

  renderVideoCaption();
  el("lp-video-strip").querySelectorAll(".lp-video-thumb").forEach((btn) => {
    btn.addEventListener("click", () => playClip(Number(btn.dataset.i)));
  });

  const cc = el("lp-capcut");
  if (cc) cc.addEventListener("click", openCapcut);
}

/* Every clip this lead has, newest render first -- flattened, because the
   strip is one row of clips and not a row per render. */
function videoClips() {
  const out = [];
  videoRuns.filter((r) => r.clips && r.clips.length).forEach((run) => {
    run.clips.forEach((clip) => out.push(Object.assign({}, clip, {
      when: sceneryWhen(run), job_id: run.id,
    })));
  });
  return out;
}

/* Which room a clip shows, via the photo it was rendered from. The labels
   are already on the lead from room sorting, so nothing new is computed --
   an unsorted photo just has no room, which is a real state, not an error. */
function videoClipRoom(clip) {
  if (!clip.photo) return "";
  return (((lead && lead.photo_rooms) || {})[clip.photo] || {}).label || "";
}

function videoClipLabel(clip) {
  const move = clip.move ? VIDEO_MOVE_NAMES[clip.move] || clip.move : "";
  return [videoClipRoom(clip), move, clip.duration ? clip.duration + "s" : "",
          clip.when].filter(Boolean).join(" · ");
}

function renderVideoCaption() {
  const clips = videoClips();
  const clip = clips[videoPlaying];
  const cap = el("lp-video-cap");
  if (!clip || !cap) return;
  cap.innerHTML =
    `<span class="lp-video-cap-n">Clip ${videoPlaying + 1} of ${clips.length}</span>` +
    `<span class="lp-video-cap-meta">${escapeHtml(videoClipLabel(clip))}</span>` +
    `<a href="${escapeHtml(clip.video_url)}" download>Download</a>`;
}

/* Swap the stage rather than re-render the section: rebuilding would drop the
   CapCut handler and restart whatever is playing. */
function playClip(i) {
  const clips = videoClips();
  if (!clips[i]) return;
  videoPlaying = i;

  const main = el("lp-video-main");
  main.src = clips[i].video_url;
  // Clicking a thumbnail is a user gesture, so this is allowed to start. It
  // can still be refused (a paused-media preference), which is not an error.
  main.play().catch(() => {});

  el("lp-video-strip").querySelectorAll(".lp-video-thumb").forEach((btn) => {
    btn.classList.toggle("is-on", Number(btn.dataset.i) === i);
  });
  renderVideoCaption();
}

const VIDEO_MOVE_NAMES = {
  push_in: "Push in", pull_out: "Pull out", pan_left: "Pan left",
  pan_right: "Pan right", orbit_left: "Orbit left", orbit_right: "Orbit right",
  rise: "Rise", tilt_up: "Tilt up", static: "Hold",
};

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
  // Renders live on the job table, not in projects.json.
  try {
    const body = await fetchJSON("/studio/api/video/jobs");
    videoRuns = (body.renders || []).filter((r) => r.lead_id === lead.id);
  } catch (err) {
    videoRuns = [];
  }

  const mine = (projects || []).filter((p) => p.lead_id === lead.id);
  // Scenery runs are projects too and are inserted at the top of the list, so
  // the video panel has to say which kind it wants or it shows a staging run.
  currentProject = mine.find((p) => p.kind !== "scenery") || null;
  renderVideo(currentProject);
  renderSpend();
  renderSold();
  renderScenery(mine.filter((p) => p.kind === "scenery"));
  initMediaTabs();
  renderPhotos(lead.photo_urls);
  initRooms();

  el("lp-refetch").addEventListener("click", () => pullPhotos(true));
  pullPhotos(false);
}

load();

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
        ${data.queued
          ? "Sent to Claude. If a session is watching, the rooms will fill in shortly."
          : `Ask Claude to sort lead ${LEAD_ID}.`}
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


/* ---------- staged rooms ----------

   The same panels Scenery finishes on, shown again here. Deliberately not a
   smaller, different summary: what you want on the profile is the thing you
   were looking at when you decided it was good, and a second layout would be
   a second thing to keep in step. stagedRoomPanel is shared for that reason.

   The one difference is that nothing here generates. The style buttons switch
   between looks that already exist; a look that was never made is simply not
   offered, rather than being a button that would start spending. */

let sceneryRuns = [];
let sceneryStyleByRoom = {};

function sceneryWhen(project) {
  const seconds = project.created_at || project.updated_at;
  if (!seconds) return "";
  const then = new Date(seconds * 1000);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return days + " days ago";
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* One entry per original photo, carrying every style ever made for it --
   across runs, because restaging a listing later should add to the room, not
   start a second disconnected list. */
function sceneryRooms() {
  const byPhoto = new Map();
  sceneryRuns.forEach((run) => {
    (run.scenes || []).forEach((scene) => {
      if (!scene.before || !scene.after) return;
      if (!byPhoto.has(scene.before)) {
        byPhoto.set(scene.before, {
          beforeUrl: scene.before,
          label: scene.label || "Room",
          variants: {},
          when: sceneryWhen(run),
        });
      }
      byPhoto.get(scene.before).variants[scene.style] = scene.after;
    });
  });
  return [...byPhoto.values()];
}

function renderScenery(projects) {
  const box = el("lp-scenery");
  const count = el("lp-tab-count");
  if (!box) return;

  sceneryRuns = [...(projects || [])].sort(
    (a, b) => (b.created_at || 0) - (a.created_at || 0)
  );
  const rooms = sceneryRooms();
  const images = rooms.reduce((n, r) => n + Object.keys(r.variants).length, 0);
  if (count) count.textContent = images ? String(images) : "";

  const vcount = el("lp-video-count");
  if (vcount) {
    const clips = videoRuns.reduce((n, r) => n + (r.clips || []).length, 0);
    vcount.textContent = clips ? String(clips) : "";
  }

  if (!rooms.length) {
    box.innerHTML = `
      <div class="lp-scenery-empty">
        <span>No rooms staged for this listing yet.</span>
        <a class="cta-btn cta-btn-sm" href="/studio/create/scenery?lead_id=${LEAD_ID}">Stage rooms</a>
      </div>`;
    return;
  }

  box.innerHTML = `
    <div class="lp-scenery-head">
      <p class="lp-scenery-note">
        ${images} image${images === 1 ? "" : "s"} across ${rooms.length} room${rooms.length === 1 ? "" : "s"}.
        Drag the divider to compare with the original. Every image is virtually
        staged and saved with that notice printed on it.
      </p>
      <a class="btn-secondary btn-tiny" href="/studio/create/scenery?lead_id=${LEAD_ID}">Stage more</a>
    </div>
    <div id="lp-scenery-rooms" class="scn-rooms"></div>`;

  renderSceneryRooms();
}


/* ---------- what this listing has cost ----------

   Priced from the clips that were actually DELIVERED, at today's rates --
   both of which are the server's doing, in clip_cost. A run that failed
   before producing a file is not money spent, and a run priced before the
   1080p rate was corrected is not what was billed. */

function renderSpend() {
  const box = el("lp-spend");
  if (!box) return;

  const runs = videoRuns.filter((r) => (r.clips || []).length);
  const clips = runs.reduce((n, r) => n + r.clips.length, 0);
  const total = runs.reduce((n, r) => n + (r.cost || 0), 0);

  if (!clips) {
    box.innerHTML = `<p class="lp-spend-empty">Nothing rendered yet.</p>`;
    return;
  }

  // Grouped by model, because the two differ by more than 6x and a single
  // figure hides which one the money went to.
  const byModel = new Map();
  runs.forEach((run) => {
    const key = run.model_label || "Unknown model";
    const at = byModel.get(key) || { clips: 0, cost: 0 };
    at.clips += run.clips.length;
    at.cost += run.cost || 0;
    byModel.set(key, at);
  });

  const rows = [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([label, at]) => `
      <li>
        <span class="lp-spend-model">${escapeHtml(label)}</span>
        <span class="lp-spend-count">${at.clips} clip${at.clips === 1 ? "" : "s"}</span>
        <span class="lp-spend-amt">$${at.cost.toFixed(2)}</span>
      </li>`).join("");

  box.innerHTML = `
    <p class="lp-spend-total">$${total.toFixed(2)}</p>
    <p class="lp-spend-sub">
      ${clips} clip${clips === 1 ? "" : "s"} across
      ${runs.length} render${runs.length === 1 ? "" : "s"}
    </p>
    <ul class="lp-spend-rows">${rows}</ul>
    <p class="lp-spend-foot">Staging is free on Gemini, so none of this is Scenery.</p>`;
}


/* Back goes where you came from.

   Read off the link that brought you here rather than document.referrer,
   which is empty on a hard reload and lies after a redirect -- the arrow
   would quietly point at the wrong page in exactly the cases someone is
   most likely to use it. */
const BACK_TO = {
  dashboard: ["/studio/dashboard", "Dashboard"],
  projects: ["/studio/projects", "Projects"],
};

function setBackLink() {
  const link = el("lp-back");
  if (!link) return;
  const params = new URLSearchParams(location.search);
  const where = BACK_TO[params.get("from")];
  if (!where) return;  // the Lead Manager, which the markup already says

  let href = where[0];
  // Projects also remembers which folder was open, so Back lands back inside
  // it rather than at the top of the page.
  const folder = params.get("folder");
  if (params.get("from") === "projects" && folder) {
    href += "?folder=" + encodeURIComponent(folder);
  }
  link.href = href;
  link.innerHTML = "&larr; " + where[1];
}


/* ---------- what this listing earned ----------

   The amount is what the CLIENT PAID for the marketing, not what the house
   sold for. The house's price is already on the lead and is not income;
   confusing the two would report a $525,000 listing as half a million
   dollars of revenue. The label says "Paid by client" for that reason. */

let soldEditing = false;

function leadVideoSpend() {
  return videoRuns.reduce((n, r) => n + (r.cost || 0), 0);
}

function packageList() {
  return window.PACKAGES || [];
}

function renderSold() {
  const box = el("lp-sold");
  if (!box) return;

  const spend = leadVideoSpend();
  const amount = lead.sold_amount;
  const chosen = lead.sold_package;

  // Picking, either because nothing is sold yet or because Change was hit.
  if (soldEditing || amount == null) {
    box.innerHTML = `
      <p class="lp-sold-label">Which package?</p>
      <div class="lp-pkg-list">
        ${packageList().map((pkg) => `
          <button type="button" class="lp-pkg ${pkg.key === chosen ? "is-on" : ""}"
                  data-key="${escapeHtml(pkg.key)}">
            <span class="lp-pkg-name">${escapeHtml(pkg.name)}</span>
            <span class="lp-pkg-price">${money(pkg.price)}</span>
          </button>`).join("")}
      </div>
      ${amount != null ? `
        <div class="lp-sold-actions">
          <button type="button" class="btn-secondary btn-tiny" id="lp-sold-cancel">Cancel</button>
          <button type="button" class="lp-sold-clear" id="lp-sold-clear">Not sold</button>
        </div>` : ""}
      <p id="lp-sold-note" class="lp-sold-note"></p>`;

    box.querySelectorAll(".lp-pkg").forEach((btn) => {
      btn.addEventListener("click", () => saveSold(btn.dataset.key));
    });
    if (amount != null) {
      el("lp-sold-cancel").addEventListener("click", () => {
        soldEditing = false;
        renderSold();
      });
      el("lp-sold-clear").addEventListener("click", () => saveSold(""));
    }
    return;
  }

  const profit = amount - spend;
  box.innerHTML = `
    <p class="lp-sold-total">${money(amount)}</p>
    <p class="lp-sold-sub">${escapeHtml(packageName(chosen))}${
      lead.sold_at ? " · " + sceneryWhen({ created_at: Date.parse(lead.sold_at) / 1000 })
                   : ""}</p>
    <ul class="lp-spend-rows lp-sold-rows">
      <li><span class="lp-spend-model">Spent on video</span>
          <span class="lp-spend-amt">−${money(spend)}</span></li>
      <li class="lp-sold-profit"><span class="lp-spend-model">Profit</span>
          <span class="lp-spend-amt">${money(profit)}</span></li>
    </ul>
    <button type="button" class="lp-sold-editbtn" id="lp-sold-edit">Change</button>`;
  el("lp-sold-edit").addEventListener("click", () => {
    soldEditing = true;
    renderSold();
  });
}

/* The name as it was sold, falling back to the key: a package removed from
   the list later should not blank out a sale that already happened. */
function packageName(key) {
  if (!key) return "Sold";
  const pkg = packageList().find((p) => p.key === key);
  return pkg ? pkg.name : key;
}

/* Thousands separators, and a leading minus outside the dollar sign rather
   than inside it -- "-$4.00", not "$-4.00" -- since profit can go negative
   on a listing that was rendered and never sold. */
function money(n) {
  const sign = n < 0 ? "−" : "";
  return sign + "$" + Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/* `key` is a package key, or "" for not sold. The price is never sent -- the
   server reads it off its own list, so what revenue counts cannot be set by
   the page. */
async function saveSold(key) {
  const note = el("lp-sold-note");
  try {
    const res = await fetch(`/studio/api/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sold_package: key }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Couldn't save that.");
    lead.sold_amount = body.sold_amount;
    lead.sold_at = body.sold_at;
    lead.sold_package = body.sold_package;
    soldEditing = false;
    renderSold();
  } catch (err) {
    if (note) note.textContent = err.message;
  }
}


/* ---------- handing clips to CapCut ----------

   There is no CapCut API, so nothing is sent anywhere: the server writes a
   project into the folder CapCut reads its drafts from, and it appears in the
   project list. Which clips and in what order is the only decision worth
   asking about -- everything after that is what CapCut is for.  */

let capcutPicked = [];

function capcutModal() {
  let box = el("lp-capcut-modal");
  if (box) return box;

  box = document.createElement("div");
  box.id = "lp-capcut-modal";
  box.className = "lead-modal hidden";
  box.innerHTML = `
    <div class="lead-modal-backdrop" data-close></div>
    <div class="lead-modal-panel" role="dialog" aria-modal="true">
      <header class="lead-modal-head">
        <h2>Send clips to CapCut</h2>
        <button type="button" class="lead-modal-x" data-close aria-label="Close">&times;</button>
      </header>
      <p class="hint">
        Tick the clips you want, then put them in order. They land on one
        timeline in CapCut, ready for music, titles and export.
      </p>
      <div id="lp-capcut-list" class="cc-list"></div>
      <div class="cc-actions">
        <span id="lp-capcut-note" class="hint"></span>
        <button type="button" class="btn-send" id="lp-capcut-send" disabled>Send to CapCut</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  box.querySelectorAll("[data-close]").forEach((n) =>
    n.addEventListener("click", () => box.classList.add("hidden")));
  el("lp-capcut-send").addEventListener("click", sendToCapCut);
  return box;
}

function allClips() {
  const out = [];
  videoRuns.forEach((run) => (run.clips || []).forEach((clip) => out.push({
    video_url: clip.video_url,
    // Room first here too: ordering clips into a walkthrough is a question
    // about rooms, and "Push in" three times over says nothing about which.
    label: [videoClipRoom(clip), VIDEO_MOVE_NAMES[clip.move] || clip.move]
      .filter(Boolean).join(" · ") || "clip",
    duration: clip.duration || 5,
    when: sceneryWhen(run),
  })));
  return out;
}

function renderCapcutList() {
  const list = el("lp-capcut-list");
  const clips = allClips();

  list.innerHTML = clips.map((clip) => {
    const at = capcutPicked.indexOf(clip.video_url);
    const on = at >= 0;
    return `
      <div class="cc-row ${on ? "is-on" : ""}" data-url="${escapeHtml(clip.video_url)}">
        <label class="cc-pick">
          <input type="checkbox" ${on ? "checked" : ""}>
          <span class="cc-order">${on ? at + 1 : ""}</span>
        </label>
        <video src="${escapeHtml(clip.video_url)}#t=0.5" preload="metadata" muted></video>
        <span class="cc-meta">
          <span class="cc-name">${escapeHtml(clip.label)}</span>
          <span class="cc-sub">${clip.duration}s · ${escapeHtml(clip.when)}</span>
        </span>
        <span class="cc-move">
          <button type="button" data-dir="-1" ${!on || at === 0 ? "disabled" : ""}
                  title="Earlier">&#9650;</button>
          <button type="button" data-dir="1"
                  ${!on || at === capcutPicked.length - 1 ? "disabled" : ""}
                  title="Later">&#9660;</button>
        </span>
      </div>`;
  }).join("");

  list.querySelectorAll(".cc-row").forEach((row) => {
    const url = row.dataset.url;
    row.querySelector("input").addEventListener("change", () => {
      const at = capcutPicked.indexOf(url);
      // Appended in click order, because click order IS the running order
      // until it is changed -- which is what the arrows are for.
      if (at >= 0) capcutPicked.splice(at, 1);
      else capcutPicked.push(url);
      renderCapcutList();
    });
    row.querySelectorAll(".cc-move button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const at = capcutPicked.indexOf(url);
        const to = at + Number(btn.dataset.dir);
        if (at < 0 || to < 0 || to >= capcutPicked.length) return;
        capcutPicked.splice(to, 0, capcutPicked.splice(at, 1)[0]);
        renderCapcutList();
      });
    });
  });

  const total = capcutPicked.reduce((n, url) => {
    const c = clips.find((x) => x.video_url === url);
    return n + (c ? c.duration : 0);
  }, 0);
  el("lp-capcut-note").textContent = capcutPicked.length
    ? `${capcutPicked.length} clip${capcutPicked.length === 1 ? "" : "s"} · ${total}s`
    : "Nothing picked yet.";
  el("lp-capcut-send").disabled = capcutPicked.length === 0;
}

async function sendToCapCut() {
  const btn = el("lp-capcut-send");
  btn.disabled = true;
  btn.textContent = "Writing…";
  try {
    const res = await fetch("/studio/api/video/capcut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: (lead.address || "estly listing"),
        clips: capcutPicked.map((url) => ({ video_url: url })),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Couldn't write the project.");
    el("lp-capcut-note").innerHTML =
      `<strong>Done.</strong> "${escapeHtml(body.name)}" — ` +
      `${body.clips} clip${body.clips === 1 ? "" : "s"}, ${body.duration}s. ` +
      (body.opened
        ? `CapCut is opening; it's at the top of your project list.`
        : `Open CapCut and it's at the top of your project list.`);
    btn.textContent = "Sent";
  } catch (err) {
    el("lp-capcut-note").textContent = err.message;
    btn.disabled = false;
    btn.textContent = "Send to CapCut";
  }
}

function openCapcut() {
  const box = capcutModal();
  // Default to every clip, in the order they were rendered: for one listing
  // that is usually the running order already.
  capcutPicked = allClips().map((c) => c.video_url);
  renderCapcutList();
  el("lp-capcut-send").textContent = "Send to CapCut";
  box.classList.remove("hidden");
}

function renderSceneryRooms() {
  const list = el("lp-scenery-rooms");
  if (!list) return;
  const rooms = sceneryRooms();
  list.innerHTML = "";

  rooms.forEach((room, index) => {
    const made = Object.keys(room.variants);
    const active = sceneryStyleByRoom[room.beforeUrl] && room.variants[sceneryStyleByRoom[room.beforeUrl]]
      ? sceneryStyleByRoom[room.beforeUrl]
      : made[0];

    list.appendChild(stagedRoomPanel({
      beforeUrl: room.beforeUrl,
      label: room.label,
      variants: room.variants,
      activeStyle: active,
      hint: made.length > 1 ? `${made.length} looks · staged ${room.when}` : `Staged ${room.when}`,
      // Only what exists: an unmade style here would be a button that spends.
      styles: made,
      onStyle: (key) => {
        sceneryStyleByRoom[room.beforeUrl] = key;
        renderSceneryRooms();
      },
      onOpen: () => openStagedCompare({ rooms, index, style: active }),
    }));
  });
}

/* ---------- media tabs ---------- */

/* Before anything is fetched. Back is the arrow someone reaches for WHEN the
   page did not work -- running it after the lead loads meant the one case
   that needs it most, a lead that failed to load, still pointed at the Lead
   Manager. It depends on the URL and nothing else. */
setBackLink();


function initMediaTabs() {
  document.querySelectorAll(".lp-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".lp-tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".lp-media").forEach((m) => m.classList.remove("is-active"));
      tab.classList.add("is-active");
      const panel = el("lp-media-" + tab.dataset.media);
      if (panel) panel.classList.add("is-active");
    });
  });
}
