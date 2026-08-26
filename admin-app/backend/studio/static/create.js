const state = {
  projectId: null,
  name: null,
  extracted: null,
  photos: [], // array of {url} -- confirmed photos/videos for the listing
  candidates: [], // remote image URLs found on the page, pending selection
  selected: new Set(), // subset of candidates currently checked
  satellite: null, // {url} overhead/satellite reference shot, or null
  lat: null,
  lon: null,
  leadId: null, // set when this project originated from an admin-pipeline Lead
};

const el = (id) => document.getElementById(id);
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const isVideoUrl = (url) => VIDEO_EXT.test(url);

const existingProject = window.__PROJECT__ || null;
const wasCompleted = existingProject && existingProject.status === "completed";
const prefillData = window.__PREFILL__ || null;

function setStatus(node, message, kind) {
  node.textContent = message || "";
  node.className = "status" + (kind ? " " + kind : "");
}

function hasContent() {
  return state.photos.length > 0 || !!state.extracted || !!state.name;
}

// Create the draft on first meaningful action, then keep it in sync on every
// change after that -- this is what makes "any project started" show up on
// the dashboard even if the user never explicitly hits Save.
//
// Calls are chained through `autosaveQueue` so two triggers firing back to
// back (e.g. the name field's blur event and a button click in the same
// gesture) never both see projectId as null and create duplicate drafts.
let autosaveQueue = Promise.resolve();

function autosave(extra = {}) {
  autosaveQueue = autosaveQueue.then(() => doAutosave(extra)).catch(() => {});
  return autosaveQueue;
}

async function doAutosave(extra) {
  if (!state.projectId && !hasContent()) return;

  const payload = {
    name: state.name || "Untitled draft",
    url: state.extracted?.url || null,
    source: state.extracted?.source || null,
    address: state.extracted?.address || null,
    title: state.extracted?.title || null,
    description: state.extracted?.description || null,
    photos: state.photos.map((p) => p.url),
    selected_photos: usedPhotos().map((p) => p.url),
    satellite_image: state.satellite?.url || null,
    lat: state.lat,
    lon: state.lon,
    beds: state.extracted?.beds ?? null,
    baths: state.extracted?.baths ?? null,
    sqft: state.extracted?.sqft ?? null,
    property_type: state.extracted?.property_type ?? null,
    lead_id: state.leadId,
    ...extra,
  };

  if (!state.projectId) {
    payload.status = payload.status || "draft";
    const res = await fetch("/studio/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    state.projectId = data.id;
  } else {
    await fetch(`/studio/api/projects/${state.projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}

function prefillFromProject(project) {
  state.projectId = project.id;
  state.name = project.name || null;
  state.extracted = project.url
    ? {
        url: project.url,
        source: project.source,
        address: project.address,
        title: project.title,
        description: project.description,
        beds: project.beds,
        baths: project.baths,
        sqft: project.sqft,
        property_type: project.property_type,
      }
    : null;
  // A project saved before selection existed has no selected_photos; treat
  // every photo as used rather than silently excluding them all.
  const chosen = Array.isArray(project.selected_photos) ? new Set(project.selected_photos) : null;
  state.photos = (project.photos || []).map((url) => ({ url, use: chosen ? chosen.has(url) : true }));
  state.satellite = project.satellite_image ? { url: project.satellite_image } : null;
  state.lat = project.lat ?? null;
  state.lon = project.lon ?? null;
  if (project.url) el("listing-url").value = project.url;
  if (project.address) el("satellite-address").value = project.address;
  renderPhotoGrid();
  renderSatelliteView();
}

// Coming from a Lead in the admin pipeline (/studio/create?lead_id=...):
// seeds this brand-new project with that lead's address/facts, pulls in its
// photos via the same import pipeline a pasted listing link would use, and
// fetches the overhead shot -- so clicking "Create Video" on a lead lands
// on an already-populated project instead of an empty form.
async function applyPrefill(prefill) {
  state.leadId = prefill.lead_id ?? null;
  state.name = prefill.name || null;
  state.extracted = {
    address: prefill.address,
    // autosave reads url/source off state.extracted, so the lead's listing
    // link is carried into the saved project rather than being lost.
    url: prefill.url || null,
    source: prefill.source || null,
    beds: prefill.beds,
    baths: prefill.baths,
    sqft: prefill.sqft,
    property_type: prefill.property_type,
  };
  if (prefill.address) el("satellite-address").value = prefill.address;
  renderSatelliteView();

  // Carry the listing link across so the project keeps its source, and the
  // user never has to paste it a second time.
  if (prefill.url) {
    const urlInput = el("listing-url");
    if (urlInput) urlInput.value = prefill.url;
  }

  await adoptLeadPhotos(prefill);

  if (prefill.address) {
    await fetchSatelliteView();
  }

  await autosave();
}

/* Bring the lead's photos into this project.

   The lead's photos are already saved locally (the profile page pulls them
   from the listing), so their URLs look like /studio/static/uploads/x.jpg.
   Those must be adopted as-is: handing them to /api/import-images made it
   try to HTTP-fetch a path with no host, every one failed, and the project
   opened with an empty photo grid -- which is what made this feel like
   "re-upload everything". Only genuinely remote URLs get downloaded.

   If the lead has no photos yet (its profile was never opened), pull them
   from the listing first using the same endpoint the profile uses. */
async function adoptLeadPhotos(prefill) {
  let photos = prefill.photos || [];

  if (!photos.length && prefill.lead_id) {
    try {
      const res = await fetch(`/studio/api/leads/${prefill.lead_id}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      photos = (await res.json()).photos || [];
    } catch (err) {
      photos = [];
    }
  }
  if (!photos.length) return;

  const isLocal = (url) => url.startsWith("/studio/static/uploads/");
  photos.filter(isLocal).forEach((url) => state.photos.push({ url }));

  const remote = photos.filter((url) => !isLocal(url));
  if (remote.length) {
    try {
      const res = await fetch("/studio/api/import-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: remote, existing_photos: state.photos.map((p) => p.url) }),
      });
      const data = await res.json();
      (data.photos || []).forEach((url) => state.photos.push({ url }));
    } catch (err) {
      // Photos are a nice-to-have here; the lead's address/facts still came through.
    }
  }
  renderPhotoGrid();
}

async function fetchListingInfo() {
  const urlInput = el("listing-url");
  const url = urlInput.value.trim();
  const status = el("fetch-status");
  const previewCard = el("preview-card");
  const pickWrap = el("pick-wrap");

  if (!url) {
    setStatus(status, "Paste a listing URL first.", "error");
    return;
  }

  setStatus(status, "Reading the page…");
  previewCard.classList.add("hidden");
  pickWrap.classList.add("hidden");
  state.candidates = [];
  state.selected = new Set();

  try {
    const res = await fetch("/studio/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    const imageCount = (data.images || []).length;
    if (data.error) {
      setStatus(status, data.error, "error");
    } else {
      setStatus(status, `Found ${imageCount} image(s).`, "ok");
    }

    if (data.title || data.image || imageCount) {
      state.extracted = data;
      el("preview-source").textContent = data.source || "listing";
      el("preview-title").textContent = data.title || "(no title found)";
      el("preview-address").textContent = data.address || "";
      el("preview-desc").textContent = data.description || "";
      const img = el("preview-img");
      if (data.image) {
        img.src = data.image;
        img.style.display = "";
      } else {
        img.style.display = "none";
      }
      previewCard.classList.remove("hidden");

      if (!state.name && data.title) {
        state.name = data.address || data.title.slice(0, 60);
      }
      if (data.address) el("satellite-address").value = data.address;
      if (data.satellite_image) {
        state.satellite = { url: data.satellite_image };
        state.lat = data.lat;
        state.lon = data.lon;
        renderSatelliteView();
      }
      autosave();
    }

    if (imageCount) {
      state.candidates = data.images;
      data.images.forEach((u) => state.selected.add(u));
      renderPickGrid();
      pickWrap.classList.remove("hidden");
    }
  } catch (err) {
    setStatus(status, "Network error reaching that URL.", "error");
  }
}

function renderPickGrid() {
  const grid = el("pick-grid");
  grid.innerHTML = "";
  state.candidates.forEach((url) => {
    const div = document.createElement("div");
    div.className = "pick-thumb" + (state.selected.has(url) ? " selected" : "");
    div.dataset.url = url;
    div.innerHTML = `<img src="${url}" alt="" loading="lazy"><span class="check"></span>`;
    div.addEventListener("click", () => {
      if (state.selected.has(url)) {
        state.selected.delete(url);
      } else {
        state.selected.add(url);
      }
      div.classList.toggle("selected");
      updatePickNumbers();
    });
    // Drop candidates that fail to load (icons/trackers/broken links) from view
    div.querySelector("img").addEventListener("error", () => {
      state.selected.delete(url);
      div.remove();
      updatePickNumbers();
    });
    grid.appendChild(div);
  });
  el("pick-count").textContent = `${state.candidates.length} image(s) found on the page — click to deselect any you don't want. Numbers show the order they'll be added in.`;
  updatePickNumbers();
}

function updatePickNumbers() {
  const order = [...state.selected];
  el("pick-grid")
    .querySelectorAll(".pick-thumb")
    .forEach((thumb) => {
      const idx = order.indexOf(thumb.dataset.url);
      thumb.querySelector(".check").textContent = idx >= 0 ? String(idx + 1) : "";
    });
}

async function addSelectedImages() {
  const status = el("fetch-status");
  const chosen = state.candidates.filter((u) => state.selected.has(u));
  if (!chosen.length) {
    setStatus(status, "Select at least one image to add.", "error");
    return;
  }

  const btn = el("add-selected-btn");
  btn.disabled = true;
  btn.textContent = "Adding…";

  try {
    const res = await fetch("/studio/api/import-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: chosen,
        existing_photos: state.photos.map((p) => p.url),
      }),
    });
    const data = await res.json();
    (data.photos || []).forEach((url) => state.photos.push({ url }));
    renderPhotoGrid();
    await autosave();

    const failedCount = (data.failed || []).length;
    const dupeCount = data.duplicates || 0;
    const notes = [];
    if (failedCount) notes.push(`${failedCount} couldn't be downloaded`);
    if (dupeCount) notes.push(`${dupeCount} skipped as duplicate(s) of a photo you already have`);
    setStatus(
      status,
      `Added ${data.photos.length} photo(s) to this listing.` + (notes.length ? ` (${notes.join(", ")})` : ""),
      "ok"
    );

    el("pick-wrap").classList.add("hidden");
    state.candidates = [];
    state.selected = new Set();
  } catch (err) {
    setStatus(status, "Could not add the selected images.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add selected photos";
  }
}

function renderSatelliteView() {
  const preview = el("satellite-preview");
  const formWrap = el("satellite-form-wrap");
  if (state.satellite) {
    el("satellite-img").src = state.satellite.url;
    preview.classList.remove("hidden");
    formWrap.classList.add("hidden");
  } else {
    preview.classList.add("hidden");
    formWrap.classList.remove("hidden");
  }
}

async function fetchSatelliteView() {
  const address = el("satellite-address").value.trim();
  const status = el("satellite-status");
  if (!address) {
    setStatus(status, "Enter an address first.", "error");
    return;
  }

  const btn = el("satellite-fetch-btn");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  setStatus(status, "");

  try {
    const res = await fetch("/studio/api/satellite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const data = await res.json();
    if (data.error) {
      setStatus(status, data.error, "error");
      return;
    }
    state.satellite = { url: data.satellite_image };
    state.lat = data.lat;
    state.lon = data.lon;
    renderSatelliteView();
    await autosave();
  } catch (err) {
    setStatus(status, "Network error fetching the satellite view.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Get satellite view";
  }
}

function removeSatelliteView() {
  state.satellite = null;
  state.lat = null;
  state.lon = null;
  renderSatelliteView();
  autosave();
}

// Interactive explore map -- same free/keyless Esri World Imagery tiles as
// the static overhead shot, but pannable/zoomable via Leaflet so someone can
// actually look around the property and its surroundings, not just see one
// fixed frame. A hybrid street-labels overlay and fullscreen round it out.
//
// Street View / Google 3D Fly-Around (photorealistic tiles) were prototyped
// here but pulled from this UI -- turns out image-generation models don't
// need pre-rendered frame sequences, just one reference image + a motion
// prompt, so a human-facing explorer wasn't earning its complexity. The
// Google Maps credential/backend plumbing (GOOGLE_MAPS_API_KEY,
// STREETVIEW_ENABLED, /api/streetview-check in app.py) is left in place for
// later backend-only use when training the drone-shot generator.
let leafletMap = null;
let labelsLayer = null;

function buildLeafletMap() {
  leafletMap = L.map("leaflet-map").setView([state.lat, state.lon], 19);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      // Esri's cached imagery tops out around zoom 19 in most
      // suburban/residential areas (denser urban areas sometimes go higher).
      // maxNativeZoom stops requesting tiles that don't exist and upscales
      // the deepest available ones instead of showing blank tiles beyond it.
      maxNativeZoom: 19,
      maxZoom: 21,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    }
  ).addTo(leafletMap);

  // Hybrid overlay: street names and roads on top of the raw satellite
  // imagery -- the same "satellite + labels" combo Google Earth/Maps default
  // to, instead of an unlabeled photo.
  labelsLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 19, maxZoom: 21, attribution: "" }
  ).addTo(leafletMap);

  const marker = L.marker([state.lat, state.lon]).addTo(leafletMap);
  if (state.name || state.extracted?.address) {
    marker.bindPopup(state.name || state.extracted.address);
  }
}

function toggleLabelsLayer(show) {
  if (!leafletMap || !labelsLayer) return;
  if (show) {
    labelsLayer.addTo(leafletMap);
  } else {
    leafletMap.removeLayer(labelsLayer);
  }
}

function toggleMapFullscreen() {
  const box = document.querySelector("#map-modal .map-modal-box");
  if (!document.fullscreenElement) {
    box.requestFullscreen?.() || box.webkitRequestFullscreen?.();
  } else {
    document.exitFullscreen?.() || document.webkitExitFullscreen?.();
  }
  setTimeout(() => leafletMap?.invalidateSize(), 150);
}

function openMapModal() {
  if (state.lat == null || state.lon == null) return;
  el("map-modal").classList.remove("hidden");

  if (!leafletMap) {
    buildLeafletMap();
  } else {
    leafletMap.setView([state.lat, state.lon], 19);
  }

  // The map was initialized (or is being re-shown) inside a container that
  // was just unhidden -- Leaflet needs a beat to measure its real size,
  // otherwise it renders at 0x0 or shows gray tiles until manually nudged.
  setTimeout(() => leafletMap.invalidateSize(), 50);
}

function closeMapModal() {
  el("map-modal").classList.add("hidden");
  if (document.fullscreenElement) document.exitFullscreen?.();
}

function renderPhotoGrid() {
  const grid = el("photo-grid");
  grid.innerHTML = "";

  state.photos.forEach((photo, idx) => {
    const use = photo.use !== false;
    const div = document.createElement("div");
    div.className = "thumb" + (use ? "" : " is-excluded");
    const media = isVideoUrl(photo.url)
      ? `<video src="${photo.url}" muted controls></video><span class="media-badge">Video</span>`
      : `<img src="${photo.url}" alt="">`;
    div.innerHTML = `
      ${media}
      <label class="thumb-use" title="Use this photo in the video">
        <input type="checkbox" ${use ? "checked" : ""}>
      </label>
      <button class="remove" title="Remove from project">&times;</button>`;

    // Excluding keeps the photo in the project but out of the video, so a
    // change of mind doesn't mean importing everything again. Remove is the
    // destructive one.
    div.querySelector(".thumb-use input").addEventListener("change", (e) => {
      photo.use = e.target.checked;
      div.classList.toggle("is-excluded", !e.target.checked);
      updatePhotoCount();
      autosave();
    });
    div.querySelector(".remove").addEventListener("click", () => {
      state.photos.splice(idx, 1);
      renderPhotoGrid();
      autosave();
    });
    grid.appendChild(div);
  });

  el("photo-empty").style.display = state.photos.length ? "none" : "";
  updatePhotoCount();
}

function usedPhotos() {
  return state.photos.filter((p) => p.use !== false);
}

function updatePhotoCount() {
  const label = el("photo-count");
  if (!label) return;
  const total = state.photos.length;
  const used = usedPhotos().length;
  label.textContent = total
    ? used === total
      ? `${total} photo${total === 1 ? "" : "s"}`
      : `${used} of ${total} selected`
    : "";
  const toggle = el("photo-select-all");
  if (toggle) toggle.textContent = used === total && total ? "Deselect all" : "Select all";
}

function wirePhotoSelectAll() {
  const toggle = el("photo-select-all");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const allOn = usedPhotos().length === state.photos.length;
    state.photos.forEach((p) => { p.use = !allOn; });
    renderPhotoGrid();
    autosave();
  });
}

async function uploadFiles(fileList, dropzoneId) {
  const files = Array.from(fileList).filter(
    (f) => f.type.startsWith("image/") || f.type.startsWith("video/")
  );
  if (!files.length) return;

  const formData = new FormData();
  files.forEach((f) => formData.append("photos", f));
  formData.append("existing_photos", JSON.stringify(state.photos.map((p) => p.url)));

  const dropzone = el(dropzoneId);
  const label = dropzone.querySelector("p");
  const originalText = label.textContent;
  label.textContent = "Uploading…";

  let data = null;
  try {
    const res = await fetch("/studio/api/upload", { method: "POST", body: formData });
    data = await res.json();
    if (data.photos) {
      data.photos.forEach((url) => state.photos.push({ url }));
      renderPhotoGrid();
      await autosave();
    }
  } finally {
    if (data && data.duplicates) {
      label.textContent = `Added ${data.photos.length}, skipped ${data.duplicates} duplicate(s)`;
      setTimeout(() => {
        label.textContent = originalText;
      }, 2500);
    } else {
      label.textContent = originalText;
    }
  }
}

// Unified "leaving" modal -- opened by the top Save button, the Back button,
// and a trapped browser-back press alike, so there's always a chance to
// Save, Save as Draft, or Don't Save, no matter how someone tries to leave.
function openLeaveModal() {
  el("modal-name-input").value = state.name || "";
  setStatus(el("modal-status"), "");
  el("name-modal").classList.remove("hidden");
  el("modal-name-input").focus();
}

function closeLeaveModal() {
  el("name-modal").classList.add("hidden");
}

async function finalizeAndLeave(status) {
  const name = el("modal-name-input").value.trim();
  if (status === "completed" && !name) {
    setStatus(el("modal-status"), "Give this project a name first.", "error");
    return;
  }
  if (name) state.name = name;
  await autosave({ status, name: state.name || "Untitled draft" });
  window.location.href = "/studio/dashboard";
}

async function discardAndLeave() {
  if (state.projectId && !wasCompleted) {
    await fetch(`/studio/api/projects/${state.projectId}`, { method: "DELETE" });
  }
  window.location.href = "/studio/dashboard";
}

async function goNext() {
  const status = el("save-status");
  if (!hasContent()) {
    setStatus(status, "Add at least one photo or video first.", "error");
    return;
  }
  await autosave(wasCompleted ? {} : { status: "draft" });
  window.location.href = `/studio/create/style?project=${state.projectId}`;
}

// Trap the browser's native back button so it behaves exactly like clicking
// the in-app Back button -- always offering Save / Save as Draft / Don't Save
// instead of silently navigating away.
function trapBrowserBack() {
  history.pushState(null, "", location.href);
  window.addEventListener("popstate", () => {
    history.pushState(null, "", location.href);
    openLeaveModal();
  });
}

function initDropzone(dropzoneId, fileInputId) {
  const dropzone = el(dropzoneId);
  const fileInput = el(fileInputId);

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => uploadFiles(e.target.files, dropzoneId));

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files, dropzoneId);
  });
}

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      el(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

el("fetch-btn").addEventListener("click", fetchListingInfo);
el("add-selected-btn").addEventListener("click", addSelectedImages);
el("next-btn").addEventListener("click", goNext);
el("back-btn").addEventListener("click", openLeaveModal);
el("listing-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchListingInfo();
});

el("satellite-fetch-btn").addEventListener("click", fetchSatelliteView);
el("satellite-remove-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  removeSatelliteView();
});
el("satellite-address").addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchSatelliteView();
});
el("satellite-img").addEventListener("click", openMapModal);
el("map-modal-close-btn").addEventListener("click", closeMapModal);
el("labels-toggle").addEventListener("change", (e) => toggleLabelsLayer(e.target.checked));
el("map-fullscreen-btn").addEventListener("click", toggleMapFullscreen);

el("save-top-btn").addEventListener("click", openLeaveModal);
el("modal-close-btn").addEventListener("click", closeLeaveModal);
el("modal-discard-btn").addEventListener("click", discardAndLeave);
el("modal-draft-btn").addEventListener("click", () => finalizeAndLeave("draft"));
el("modal-save-btn").addEventListener("click", () => finalizeAndLeave("completed"));
el("modal-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") finalizeAndLeave("completed");
});

initTabs();
initDropzone("dropzone-link", "file-input-link");
initDropzone("dropzone-upload", "file-input-upload");
trapBrowserBack();

if (existingProject) {
  wirePhotoSelectAll();
  prefillFromProject(existingProject);
} else if (prefillData) {
  wirePhotoSelectAll();
  applyPrefill(prefillData);
} else {
  renderSatelliteView();
}
renderPhotoGrid();
