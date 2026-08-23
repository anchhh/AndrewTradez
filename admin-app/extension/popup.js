"use strict";

const DEFAULT_API_BASE = "http://localhost:5050";

/**
 * Runs inside the current tab's page context via chrome.scripting.executeScript.
 * Must be fully self-contained (no references to anything outside this
 * function) since it's serialized and injected on demand -- nothing runs
 * until the user clicks the extension icon and this executes once.
 *
 * Best-effort extraction only: tries schema.org JSON-LD first (most
 * reliable when a site includes it), then falls back to Open Graph meta
 * tags, then a crude price regex as a last resort. Every field is meant to
 * be reviewed/corrected by the user before saving, not trusted blindly --
 * site markup varies and changes over time.
 */
function extractListingFromPage() {
  function num(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : n;
  }

  const host = location.hostname.replace(/^www\./, "");
  let source = "manual";
  if (host.indexOf("zillow") !== -1) source = "zillow";
  else if (host.indexOf("realtor") !== -1) source = "realtor";
  else if (host.indexOf("airbnb") !== -1) source = "airbnb";

  const data = {
    source: source,
    listing_url: location.href,
    address: null, city: null, state: null, zip_code: null,
    price: null, beds: null, baths: null, sqft: null, property_type: null,
    agent_name: null, agent_email: null, agent_phone: null,
  };

  // 1. schema.org JSON-LD -- most reliable when a site includes it
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(script.textContent);
    } catch (e) {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const addr = item.address;
      if (addr && typeof addr === "object") {
        data.address = data.address || addr.streetAddress || null;
        data.city = data.city || addr.addressLocality || null;
        data.state = data.state || addr.addressRegion || null;
        data.zip_code = data.zip_code || addr.postalCode || null;
      }

      const offers = item.offers;
      if (offers) {
        const offer = Array.isArray(offers) ? offers[0] : offers;
        data.price = data.price || num(offer && offer.price);
      }
      if (item.price != null) data.price = data.price || num(item.price);

      data.beds = data.beds || num(item.numberOfBedrooms || item.numberOfRooms);
      data.baths = data.baths || num(item.numberOfBathroomsTotal || item.numberOfBathrooms);
      if (!data.property_type && typeof item["@type"] === "string") {
        data.property_type = item["@type"];
      }
      if (!data.address && item.name) data.address = item.name;
    }
  }

  // 2. Open Graph meta fallback
  function metaContent(prop) {
    const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return el ? el.getAttribute("content") : null;
  }
  if (!data.address) data.address = metaContent("og:title") || document.title || null;
  if (!data.price) data.price = num(metaContent("product:price:amount") || metaContent("og:price:amount"));

  // 3. Crude last-resort price scan of visible text
  if (!data.price) {
    const match = (document.body.innerText || "").match(/\$[\d,]{5,}/);
    if (match) data.price = num(match[0]);
  }

  return data;
}

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

async function init() {
  setStatus("Reading current page…");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
    setStatus("");
    $("unsupported").hidden = false;
    return;
  }

  let extracted;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractListingFromPage,
    });
    extracted = result;
  } catch (e) {
    setStatus("");
    $("unsupported").hidden = false;
    return;
  }

  fillForm(extracted);
  $("form").hidden = false;
  setStatus("Auto-filled — review before saving.");
}

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
