"use strict";

// Points at the local dev backend by default. Change this in Settings if
// you're capturing leads into the deployed site instead
// (https://estly-admin.onrender.com).
const DEFAULT_API_BASE = "http://127.0.0.1:5051";
const DEFAULT_DASHBOARD_BASE = "http://127.0.0.1:5051/studio/dashboard";
const SOURCES = ["zillow", "redfin", "homes"];

let currentRaw = null; // last-captured raw page material, cached for instant tab switching
let selectedSource = "zillow";

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}

function fillForm(data) {
  $("f-address").value = data.address || "";
  $("f-city").value = data.city || "";
  $("f-state").value = data.state || "";
  $("f-zip").value = data.zip_code || "";
  $("f-beds").value = data.beds != null ? data.beds : "";
  $("f-baths").value = data.baths != null ? data.baths : "";
  $("f-sqft").value = data.sqft != null ? data.sqft : "";
  $("f-type").value = data.property_type || "";
  $("f-source").value = data.source || selectedSource;
  $("f-agent-name").value = data.agent_name || "";
  $("f-agent-email").value = data.agent_email || "";
  $("f-agent-phone").value = data.agent_phone || "";
  $("f-listing-url").value = data.listing_url || "";
}

function readForm() {
  return {
    address: $("f-address").value.trim(),
    city: $("f-city").value.trim() || null,
    state: $("f-state").value.trim() || null,
    zip_code: $("f-zip").value.trim() || null,
    beds: $("f-beds").value ? Number($("f-beds").value) : null,
    baths: $("f-baths").value ? Number($("f-baths").value) : null,
    sqft: $("f-sqft").value ? Number($("f-sqft").value) : null,
    property_type: $("f-type").value.trim() || null,
    source: selectedSource,
    agent_name: $("f-agent-name").value.trim() || null,
    agent_email: $("f-agent-email").value.trim() || null,
    agent_phone: $("f-agent-phone").value.trim() || null,
    listing_url: $("f-listing-url").value.trim() || null,
  };
}


/**
 * Injected into the listing page to collect its photos and hand back the
 * actual bytes as data: URLs.
 *
 * Reading the bytes here rather than server-side is not an optimisation --
 * homes.com's CDN returns 403 to our backend for both the page and every
 * image, so this is the only path that works at all for that site. It also
 * spares every other site a second fetch of what this browser already has.
 *
 * Must be fully self-contained: it's serialised and injected on demand.
 */
/**
 * Injected into the listing page. Returns the page's own HTML *as the server
 * would send it*, plus its og:image.
 *
 * It re-fetches location.href rather than reading document.documentElement,
 * because these sites are single-page apps: browsing from one listing to the
 * next leaves the previous listing's photos in the live DOM, and on Zillow
 * those are indistinguishable from the current one's. Re-fetching gives the
 * markup for exactly one listing -- the same clean input the backend gets,
 * which is why re-fetching from the Lead Manager was always right -- while
 * still running in the browser, which can reach pages that refuse the server.
 *
 * Falls back to the live DOM if the fetch fails, which is better than nothing.
 *
 * Must be fully self-contained: it's serialised and injected on demand.
 */
async function readListingSource() {
  const ogTag = document.querySelector('meta[property="og:image"]');
  const og = ogTag ? ogTag.getAttribute("content") : null;

  let html = null;
  try {
    const res = await fetch(location.href, { credentials: "include", cache: "no-store" });
    if (res.ok) html = await res.text();
  } catch (e) {
    /* handled below */
  }

  // Degraded mode. If the re-fetch failed we must NOT fall back to
  // document.documentElement: on a single-page app it holds photos from every
  // listing visited in this tab, and on Zillow those are indistinguishable
  // from the current one's. Measured on two real pages concatenated, that
  // leaks 25 of another listing's photos. The rendered <img> tags belong to
  // the listing actually on screen, so they're fewer but never wrong.
  let domUrls = [];
  if (!html) {
    const seen = new Set();
    document.querySelectorAll("img, source").forEach((el) => {
      [el.currentSrc, el.getAttribute("src"), el.getAttribute("data-src")].forEach((u) => {
        if (u && u.indexOf("data:") !== 0) seen.add(u);
      });
      const srcset = el.getAttribute("srcset");
      if (srcset) {
        const last = srcset.split(",").pop().trim().split(/\s+/)[0];
        if (last) seen.add(last);
      }
    });
    domUrls = Array.from(seen);
  }

  return { href: location.href, og: og, html: html, domUrls: domUrls, fresh: !!html };
}

/**
 * Injected to read chosen images and hand back their bytes. Fetching here
 * rather than server-side is what makes homes.com work at all -- its CDN
 * refuses the backend -- and spares every other site a second download.
 */
async function fetchImagesAsDataUrls(urls) {
  const out = [];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.type.indexOf("image/") !== 0 || blob.size < 3000) continue;
      out.push(
        await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        })
      );
    } catch (e) {
      // one unreachable image shouldn't lose the rest
    }
  }
  return out;
}

async function capturePhotos(onProgress) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return [];

    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readListingSource,
    });
    if (!page) return [];

    // Per-site rules live in extractors.js so changing one site can't affect
    // another. In degraded mode the rendered image URLs stand in for the page
    // source, so the same per-site filter still applies to them.
    const material = page.fresh ? page.html : page.domUrls.join("\n");
    if (!material) return [];
    const { source, photos } = pickListingPhotos(material, page.href, page.og, 60);
    console.log(
      `[Estly] ${source} extractor picked ${photos.length} photos` +
        (page.fresh ? "" : " (degraded: page re-fetch failed, on-screen images only)")
    );
    if (!photos.length) return [];

    if (onProgress) onProgress(photos.length);
    const [{ result: data }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchImagesAsDataUrls,
      args: [photos],
    });
    return data || [];
  } catch (e) {
    console.warn("[Estly] sidepanel: photo capture failed", e);
    return [];
  }
}

async function getApiBase() {
  const stored = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  return stored.apiBase;
}

async function getToken() {
  const { authToken } = await chrome.storage.local.get({ authToken: "" });
  return authToken;
}

// The extension signs in as a Studio account and keeps that account's token,
// so it no longer holds a shared password that opens the whole admin API and
// every captured lead is attributed to whoever is signed in.
async function getAuthHeaders() {
  const token = await getToken();
  return token ? { "X-Estly-Key": token } : {};
}

// Sign-in is not required while this install has a single account -- the
// backend attributes captures to it. The token plumbing stays because the
// moment a second account exists that guess stops being safe and signing in
// becomes necessary again; getAuthHeaders() sends a token if one was stored.

async function getDashboardBase() {
  const stored = await chrome.storage.sync.get({ dashboardBase: DEFAULT_DASHBOARD_BASE });
  return stored.dashboardBase;
}

function renderTabs() {
  SOURCES.forEach((s) => {
    $(`tab-${s}`).classList.toggle("active", s === selectedSource);
  });
  $("site-note").textContent = SITE_NOTES[selectedSource] || "";
}

function applyParser() {
  if (!currentRaw) return;
  const parser = PARSERS[selectedSource];
  const parsed = parser(currentRaw);
  fillForm(parsed);
}

function renderCapture(capture) {
  if (!capture) {
    currentRaw = null;
    $("empty-state").hidden = false;
    $("form").hidden = true;
    $("btn-save").hidden = true;
    setStatus("");
    return;
  }

  if (capture.error === "unsupported") {
    currentRaw = null;
    $("empty-state").hidden = false;
    $("form").hidden = true;
    $("btn-save").hidden = true;
    setStatus("That tab isn't a regular web page — open a listing page and click the icon again.", "error");
    return;
  }

  if (capture.error) {
    currentRaw = null;
    $("empty-state").hidden = false;
    $("form").hidden = true;
    $("btn-save").hidden = true;
    setStatus(`Couldn't read that page: ${capture.error}`, "error");
    return;
  }

  currentRaw = capture.raw;
  selectedSource = SOURCES.includes(capture.raw.detectedSource) ? capture.raw.detectedSource : "zillow";
  renderTabs();

  $("empty-state").hidden = true;
  applyParser();
  $("form").hidden = false;
  $("btn-save").hidden = false;
  setStatus("Auto-filled — review before saving.");
}

async function checkBackend() {
  const el = $("backend-status");
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/health`, { headers: await getAuthHeaders() });
    if (res.status === 401) {
      throw new Error("The backend refused the capture — check Settings, or sign in if this install has more than one account.");
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    el.textContent = `Backend connected (${apiBase})`;
    el.className = "backend-status ok";
  } catch (err) {
    const apiBase = await getApiBase();
    el.textContent = `Backend unreachable at ${apiBase}: ${err.message} (Settings to change)`;
    el.className = "backend-status error";
  }
}

async function init() {
  const { lastCapture } = await chrome.storage.session.get("lastCapture");
  renderTabs();
  renderCapture(lastCapture);
  checkBackend();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.lastCapture) {
    console.log("[Estly] sidepanel: lastCapture changed", changes.lastCapture.newValue);
    renderCapture(changes.lastCapture.newValue);
  }
});

SOURCES.forEach((s) => {
  $(`tab-${s}`).addEventListener("click", () => {
    if (!currentRaw) {
      selectedSource = s;
      renderTabs();
      return;
    }
    selectedSource = s;
    renderTabs();
    applyParser();
    setStatus(`Re-parsed as ${s} — no new page read.`);
  });
});

// Pressing Enter in any text field submits an HTML form by default --
// without this, correcting a field and hitting Enter (an easy habit while
// reviewing the auto-filled data) would save the lead immediately,
// without ever clicking "Save to Estly". Saving should only ever happen
// from that explicit click.
$("form").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = readForm();
  if (!payload.address) {
    setStatus("Address is required.", "error");
    return;
  }

  $("btn-save").disabled = true;
  setStatus("Reading photos from the listing…");
  const photosBase64 = await capturePhotos((n) => setStatus(`Downloading ${n} photos…`));
  if (photosBase64.length) payload.photos_base64 = photosBase64;
  setStatus(photosBase64.length ? `Saving with ${photosBase64.length} photos…` : "Saving…");

  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await getAuthHeaders()) },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      throw new Error("The backend refused the capture — check Settings, or sign in if this install has more than one account.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
    setStatus((body._merged ? "Merged into existing lead." : "Saved.") + " Click Open Pipeline to view it.", "ok");
  } catch (err) {
    setStatus(err.message, "error");
    checkBackend();
  }

  $("btn-save").disabled = false;
});

$("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("btn-pipeline").addEventListener("click", async () => {
  const dashboardBase = await getDashboardBase();
  window.open(dashboardBase, "_blank", "noopener");
});

init();
setInterval(checkBackend, 8000);
