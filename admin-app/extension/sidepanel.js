"use strict";

const DEFAULT_API_BASE = "http://localhost:5050";
const DEFAULT_DASHBOARD_BASE = "http://localhost:5173";
const SOURCES = ["zillow", "realtor", "airbnb"];

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

async function init() {
  const { lastCapture } = await chrome.storage.session.get("lastCapture");
  renderTabs();
  renderCapture(lastCapture);
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

  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);

    setStatus(
      (body._merged ? "Matched an existing lead — merged, no duplicate created." : "Saved as a new lead.") +
        " Click Open Pipeline to view it.",
      "ok"
    );
  } catch (err) {
    setStatus(
      `${err.message} — check the backend is running and the API URL in Settings.`,
      "error"
    );
  } finally {
    $("btn-save").disabled = false;
  }
});

$("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

$("btn-pipeline").addEventListener("click", async () => {
  const dashboardBase = await getDashboardBase();
  window.open(dashboardBase, "_blank", "noopener");
});

init();
