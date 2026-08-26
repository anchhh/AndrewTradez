"use strict";

// Points at the local dev backend by default. Change this in Settings if
// you're capturing leads into the deployed site instead
// (https://estly-admin.onrender.com).
const DEFAULT_API_BASE = "http://127.0.0.1:5051";
const DEFAULT_DASHBOARD_BASE = "http://127.0.0.1:5051/studio/dashboard";
const SOURCES = ["zillow", "realtor", "redfin", "homes"];

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
async function collectPhotosFromPage() {
  const MAX = 60;  // a large listing runs to 50-60 photos

  const ogTag = document.querySelector('meta[property="og:image"]');
  const og = ogTag ? ogTag.getAttribute("content") : null;

  const urls = new Set();
  if (og) urls.add(og);
  document.querySelectorAll("img").forEach((img) => {
    const src = img.currentSrc || img.src;
    if (!src || src.indexOf("data:") === 0) return;
    if (img.naturalWidth < 300 || img.naturalHeight < 200) return;
    urls.add(src);
  });

  let list = Array.from(urls).filter((u) => !/\.svg(\?|$)/i.test(u));

  // Narrow to this listing's own photos. Every rule below was derived by
  // counting a real page against the photo count the site itself displays.
  //
  //  Zillow  gallery photos come in "cc_ft" renditions; other listings on the
  //          page appear only as "sr_" (search-result) ones. On a 35-photo
  //          listing this leaves exactly 35.
  //  Redfin  og:image carries the subject's photo id, in one of two URL
  //          shapes, and its own photos are the ones sharing it.
  //  homes   every real photo repeats the address slug from the page URL;
  //          the logo and banners don't.
  if (og && og.indexOf("zillowstatic.com") !== -1) {
    const own = list.filter((u) => u.indexOf("-cc_ft_") !== -1);
    if (own.length) list = own;
  } else {
    const redfin = og && og.match(/\/system_files\/media\/(\d+)_|genMid\.(\d+)_/i);
    if (redfin) {
      const id = redfin[1] || redfin[2];
      const own = list.filter(
        (u) => u.indexOf("/media/" + id + "_") !== -1 || u.toLowerCase().indexOf("genmid." + id + "_") !== -1
      );
      if (own.length) list = own;
    } else {
      const slugMatch = location.pathname.match(/\/(?:property|homedetails)\/([^/]+)/i);
      const slug = slugMatch ? slugMatch[1].toLowerCase() : null;
      if (slug) {
        const own = list.filter((u) => u.toLowerCase().indexOf(slug) !== -1);
        if (own.length) list = own;
      }
    }
  }

  const out = [];
  for (const url of list.slice(0, MAX)) {
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

async function capturePhotos() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return [];
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPhotosFromPage,
    });
    return result || [];
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

async function setSignedIn(email, token) {
  await chrome.storage.local.set({ authToken: token, authEmail: email });
  renderAuth(email);
}

async function signOut() {
  await chrome.storage.local.remove(["authToken", "authEmail"]);
  renderAuth(null);
}

function renderAuth(email) {
  const signedIn = !!email;
  $("signin").hidden = signedIn;
  $("signed-in").hidden = !signedIn;
  if (signedIn) $("signed-in-email").textContent = email;
  $("btn-signout").hidden = !signedIn;
  // Nothing is capturable until we know whose lead it would be.
  const save = $("btn-save");
  if (save) save.disabled = !signedIn;
}

// Verifies the stored token still works; a deleted account or rotated key
// should drop the panel back to the sign-in form rather than failing later
// with a confusing error on save.
async function restoreSession() {
  const { authToken, authEmail } = await chrome.storage.local.get({ authToken: "", authEmail: "" });
  if (!authToken) {
    renderAuth(null);
    return;
  }
  renderAuth(authEmail || "…");
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/studio/api/extension/me`, {
      headers: { "X-Estly-Key": authToken },
    });
    if (!res.ok) {
      await signOut();
      return;
    }
    const body = await res.json();
    if (body.email && body.email !== authEmail) {
      await chrome.storage.local.set({ authEmail: body.email });
    }
    renderAuth(body.email || authEmail);
  } catch (e) {
    // Backend unreachable -- keep the stored session rather than signing the
    // user out because their laptop was offline for a moment.
  }
}

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
      await signOut();
      throw new Error("Your session expired — sign in again above.");
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
  setStatus("Reading photos from the page…");
  const photosBase64 = await capturePhotos();
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
      await signOut();
      throw new Error("Your session expired — sign in again above.");
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

$("signin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("signin-email").value.trim();
  const password = $("signin-password").value;
  const err = $("signin-error");
  const btn = $("signin-submit");
  err.textContent = "";
  btn.disabled = true;
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/studio/api/extension/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Sign-in failed (${res.status})`);
    $("signin-password").value = "";
    await setSignedIn(body.email, body.token);
  } catch (e2) {
    err.textContent = e2.message;
  }
  btn.disabled = false;
});

$("btn-signout").addEventListener("click", signOut);

$("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("btn-pipeline").addEventListener("click", async () => {
  const dashboardBase = await getDashboardBase();
  window.open(dashboardBase, "_blank", "noopener");
});

init();
restoreSession();
setInterval(checkBackend, 8000);
