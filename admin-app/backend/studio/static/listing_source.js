/*
 * Getting photos onto a page: the three options shared by Create Video and
 * Scenery.
 *
 *   1. a lead already captured (leads_shared.js owns that one)
 *   2. paste a listing URL and pick from what the page publishes
 *   3. upload files
 *
 * Both pages need the same three, and having two copies is how they drift
 * into behaving differently. What differs is only what a page does with the
 * result, so that is the callback:
 *
 *   initListingSource({
 *     existingPhotos: () => [url, ...],   // for duplicate detection
 *     onExtracted(data) {},               // title/address/satellite, page's business
 *     onPhotos(urls) {},                  // photos to take
 *   })
 *
 * The markup ids are shared too (listing-url, pick-grid, dropzone-upload and
 * so on), so a page opting in copies the panels and gets the behaviour.
 */

const listingSource = {
  candidates: [],
  selected: new Set(),
  existingPhotos: () => [],
  onExtracted: null,
  onPhotos: null,
};

function lsNode(id) {
  return document.getElementById(id);
}

function lsStatus(node, message, kind) {
  if (!node) return;
  node.textContent = message || "";
  node.className = "status" + (kind ? ` ${kind}` : "");
}

/* ---------- option 2: paste a link ---------- */

async function lsFetchListing() {
  const urlInput = lsNode("listing-url");
  const url = (urlInput.value || "").trim();
  const status = lsNode("fetch-status");
  const previewCard = lsNode("preview-card");
  const pickWrap = lsNode("pick-wrap");

  if (!url) {
    lsStatus(status, "Paste a listing URL first.", "error");
    return;
  }

  lsStatus(status, "Reading the page…");
  if (previewCard) previewCard.classList.add("hidden");
  if (pickWrap) pickWrap.classList.add("hidden");
  listingSource.candidates = [];
  listingSource.selected = new Set();

  let data;
  try {
    const res = await fetch("/studio/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    data = await res.json();
  } catch (err) {
    lsStatus(status, "Network error reaching that URL.", "error");
    return;
  }

  const imageCount = (data.images || []).length;
  lsStatus(status, data.error || `Found ${imageCount} image(s).`, data.error ? "error" : "ok");

  if (data.title || data.image || imageCount) {
    if (previewCard) {
      lsNode("preview-source").textContent = data.source || "listing";
      lsNode("preview-title").textContent = data.title || "(no title found)";
      lsNode("preview-address").textContent = data.address || "";
      lsNode("preview-desc").textContent = data.description || "";
      const img = lsNode("preview-img");
      if (data.image) {
        img.src = data.image;
        img.style.display = "";
      } else {
        img.style.display = "none";
      }
      previewCard.classList.remove("hidden");
    }
    // Title, address, satellite image: what a page does with those differs,
    // so it decides.
    if (listingSource.onExtracted) listingSource.onExtracted(data);
  }

  if (imageCount) {
    listingSource.candidates = data.images;
    data.images.forEach((u) => listingSource.selected.add(u));
    lsRenderPickGrid();
    if (pickWrap) pickWrap.classList.remove("hidden");
  }
}

function lsRenderPickGrid() {
  const grid = lsNode("pick-grid");
  if (!grid) return;
  grid.innerHTML = "";

  listingSource.candidates.forEach((url) => {
    const div = document.createElement("div");
    div.className = "pick-thumb" + (listingSource.selected.has(url) ? " selected" : "");
    div.dataset.url = url;
    div.innerHTML = `<img src="${url}" alt="" loading="lazy"><span class="check"></span>`;
    div.addEventListener("click", () => {
      if (listingSource.selected.has(url)) listingSource.selected.delete(url);
      else listingSource.selected.add(url);
      div.classList.toggle("selected");
      lsUpdatePickNumbers();
    });
    // Candidates that fail to load are icons, trackers or dead links -- drop
    // them from view rather than leaving a broken tile to be chosen.
    div.querySelector("img").addEventListener("error", () => {
      listingSource.selected.delete(url);
      div.remove();
      lsUpdatePickNumbers();
    });
    grid.appendChild(div);
  });

  lsNode("pick-count").textContent =
    `${listingSource.candidates.length} image(s) found on the page — click to deselect any you ` +
    `don't want. Numbers show the order they'll be added in.`;
  lsUpdatePickNumbers();
}

function lsUpdatePickNumbers() {
  const order = [...listingSource.selected];
  lsNode("pick-grid").querySelectorAll(".pick-thumb").forEach((thumb) => {
    const idx = order.indexOf(thumb.dataset.url);
    thumb.querySelector(".check").textContent = idx >= 0 ? String(idx + 1) : "";
  });
}

async function lsAddSelected() {
  const status = lsNode("fetch-status");
  const chosen = listingSource.candidates.filter((u) => listingSource.selected.has(u));
  if (!chosen.length) {
    lsStatus(status, "Select at least one image to add.", "error");
    return;
  }

  const btn = lsNode("add-selected-btn");
  btn.disabled = true;
  btn.textContent = "Adding…";

  try {
    const res = await fetch("/studio/api/import-images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: chosen,
        existing_photos: listingSource.existingPhotos(),
      }),
    });
    const data = await res.json();
    if (listingSource.onPhotos) await listingSource.onPhotos(data.photos || []);

    const notes = [];
    if ((data.failed || []).length) notes.push(`${data.failed.length} couldn't be downloaded`);
    if (data.duplicates) notes.push(`${data.duplicates} skipped as duplicate(s) of a photo you already have`);
    lsStatus(
      status,
      `Added ${(data.photos || []).length} photo(s) to this listing.` +
        (notes.length ? ` (${notes.join(", ")})` : ""),
      "ok"
    );

    lsNode("pick-wrap").classList.add("hidden");
    listingSource.candidates = [];
    listingSource.selected = new Set();
  } catch (err) {
    lsStatus(status, "Could not add the selected images.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add selected photos";
  }
}

/* ---------- option 3: upload ---------- */

async function lsUploadFiles(fileList, dropzoneId) {
  const files = Array.from(fileList).filter(
    (f) => f.type.startsWith("image/") || f.type.startsWith("video/")
  );
  if (!files.length) return;

  const formData = new FormData();
  files.forEach((f) => formData.append("photos", f));
  formData.append("existing_photos", JSON.stringify(listingSource.existingPhotos()));

  const dropzone = lsNode(dropzoneId);
  const label = dropzone.querySelector("p");
  const originalText = label.textContent;
  label.textContent = "Uploading…";

  let data = null;
  try {
    const res = await fetch("/studio/api/upload", { method: "POST", body: formData });
    data = await res.json();
    if (data.photos && listingSource.onPhotos) await listingSource.onPhotos(data.photos);
  } finally {
    if (data && data.duplicates) {
      label.textContent = `Added ${data.photos.length}, skipped ${data.duplicates} duplicate(s)`;
      setTimeout(() => { label.textContent = originalText; }, 2500);
    } else {
      label.textContent = originalText;
    }
  }
}

function lsInitDropzone(dropzoneId, inputId) {
  const zone = lsNode(dropzoneId);
  const input = lsNode(inputId);
  if (!zone || !input) return;

  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    lsUploadFiles(input.files, dropzoneId);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
    })
  );
  zone.addEventListener("drop", (e) => lsUploadFiles(e.dataTransfer.files, dropzoneId));
}

/* ---------- tabs ---------- */

function lsInitTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = lsNode(`tab-${btn.dataset.tab}`);
      if (panel) panel.classList.add("active");
    });
  });
}

function initListingSource(options = {}) {
  listingSource.existingPhotos = options.existingPhotos || (() => []);
  listingSource.onExtracted = options.onExtracted || null;
  listingSource.onPhotos = options.onPhotos || null;

  lsInitTabs();

  const fetchBtn = lsNode("fetch-btn");
  if (fetchBtn) fetchBtn.addEventListener("click", lsFetchListing);
  const addBtn = lsNode("add-selected-btn");
  if (addBtn) addBtn.addEventListener("click", lsAddSelected);

  lsInitDropzone("dropzone-link", "file-input-link");
  lsInitDropzone("dropzone-upload", "file-input-upload");
}
