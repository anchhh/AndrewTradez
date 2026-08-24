"use strict";

const DEFAULT_API_BASE = "http://localhost:5050";

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
  $("f-price").value = data.price != null ? data.price : "";
  $("f-beds").value = data.beds != null ? data.beds : "";
  $("f-baths").value = data.baths != null ? data.baths : "";
  $("f-type").value = data.property_type || "";
  $("f-source").value = data.source || "manual";
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
    price: $("f-price").value ? Number($("f-price").value) : null,
    beds: $("f-beds").value ? Number($("f-beds").value) : null,
    baths: $("f-baths").value ? Number($("f-baths").value) : null,
    property_type: $("f-type").value.trim() || null,
    source: $("f-source").value.trim() || "manual",
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

function renderExtraction(extraction) {
  if (!extraction) {
    $("empty-state").hidden = false;
    $("form").hidden = true;
    $("btn-save").hidden = true;
    setStatus("");
    return;
  }

  if (extraction.error === "unsupported") {
    $("empty-state").hidden = false;
    $("form").hidden = true;
    $("btn-save").hidden = true;
    setStatus("That tab isn't a regular web page — open a listing page and click the icon again.", "error");
    return;
  }

  if (extraction.error) {
    $("empty-state").hidden = false;
    $("form").hidden = true;
    $("btn-save").hidden = true;
    setStatus(`Couldn't read that page: ${extraction.error}`, "error");
    return;
  }

  $("empty-state").hidden = true;
  fillForm(extraction.data);
  $("form").hidden = false;
  $("btn-save").hidden = false;
  setStatus("Auto-filled — review before saving.");
}

async function init() {
  const { lastExtraction } = await chrome.storage.session.get("lastExtraction");
  renderExtraction(lastExtraction);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.lastExtraction) {
    renderExtraction(changes.lastExtraction.newValue);
  }
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

    setStatus(body._merged ? "Matched an existing lead — merged, no duplicate created." : "Saved as a new lead.", "ok");
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

init();
