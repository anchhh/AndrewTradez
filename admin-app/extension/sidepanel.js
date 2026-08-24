"use strict";

const DEFAULT_API_BASE = "http://localhost:5050";
const DEFAULT_DASHBOARD_BASE = "http://localhost:5173";
const SOURCES = ["zillow", "realtor", "airbnb"];

// One-off bridge to the specific Estly demo Artifact (a self-contained,
// localStorage-backed page -- not a real backend). See demo-bridge.js for
// why this needs its own content script instead of a normal fetch().
const DEMO_URL = "https://claude.ai/code/artifact/5727f6c4-e2cf-4cc4-9741-a31b1fa6e1ae";

async function sendToDemoPage(payload) {
  let tabs = await chrome.tabs.query({ url: DEMO_URL + "*" });
  let tab = tabs[0];

  if (!tab) {
    tab = await chrome.tabs.create({ url: DEMO_URL, active: false });
    await new Promise((resolve) => {
      function onUpdated(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    // brief grace period for the content script to attach after 'complete'
    await new Promise((r) => setTimeout(r, 300));
  }

  return chrome.tabs.sendMessage(tab.id, { type: "ESTLY_DEMO_SAVE_LEAD", lead: payload });
}

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
  $("f-price").value = data.price != null ? formatPrice(data.price) : "";
  $("f-beds").value = data.beds != null ? data.beds : "";
  $("f-baths").value = data.baths != null ? data.baths : "";
  $("f-sqft").value = data.sqft != null ? data.sqft : "";
  $("f-type").value = data.property_type || "";
  $("f-source").value = data.source || selectedSource;
  $("f-agent-name").value = data.agent_name || "";
  $("f-agent-email").value = data.agent_email || "";
  $("f-agent-phone").value = data.agent_phone || "";
  $("form").dataset.listingUrl = data.listing_url || "";
}

function readForm() {
  return {
    address: $("f-address").value.trim(),
    city: $("f-city").value.trim() || null,
    state: $("f-state").value.trim() || null,
    zip_code: $("f-zip").value.trim() || null,
    price: parsePriceInput($("f-price").value),
    beds: $("f-beds").value ? Number($("f-beds").value) : null,
    baths: $("f-baths").value ? Number($("f-baths").value) : null,
    sqft: $("f-sqft").value ? Number($("f-sqft").value) : null,
    property_type: $("f-type").value.trim() || null,
    source: selectedSource,
    agent_name: $("f-agent-name").value.trim() || null,
    agent_email: $("f-agent-email").value.trim() || null,
    agent_phone: $("f-agent-phone").value.trim() || null,
    listing_url: $("form").dataset.listingUrl || null,
  };
}

async function getApiBase() {
  const stored = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  return stored.apiBase;
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
    const res = await fetch(`${apiBase}/api/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    el.textContent = `Backend connected (${apiBase})`;
    el.className = "backend-status ok";
  } catch (err) {
    const apiBase = await getApiBase();
    el.textContent = `Backend unreachable at ${apiBase} — is it running? (Settings to change the URL)`;
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

$("f-price").addEventListener("blur", (e) => {
  const parsed = parsePriceInput(e.target.value);
  e.target.value = parsed != null ? formatPrice(parsed) : "";
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = readForm();
  if (!payload.address) {
    setStatus("Address is required.", "error");
    return;
  }

  $("btn-save").disabled = true;
  setStatus("Saving…");

  const results = [];
  let anyError = false;

  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
    results.push(body._merged ? "Backend: merged." : "Backend: saved.");
  } catch (err) {
    results.push(`Backend: ${err.message} — is it running?`);
    anyError = true;
    checkBackend();
  }

  try {
    const demoResult = await sendToDemoPage(payload);
    if (!demoResult || !demoResult.ok) throw new Error((demoResult && demoResult.error) || "no response");
    results.push(demoResult.created ? "Demo page: saved." : "Demo page: merged.");
  } catch (err) {
    results.push(`Demo page: couldn't reach it (${err.message}).`);
    anyError = true;
  }

  setStatus(results.join(" ") + (anyError ? "" : " Click Open Pipeline to view it."), anyError ? "error" : "ok");
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
