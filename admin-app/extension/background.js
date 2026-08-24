"use strict";

/**
 * Runs inside the current tab's page context via chrome.scripting.executeScript.
 * Must be fully self-contained (no references to anything outside this
 * function) since it's serialized and injected on demand -- nothing runs
 * until the user clicks the toolbar icon and this executes once.
 *
 * Extraction order, most reliable first:
 *  1. schema.org JSON-LD -- structured, when a site includes it
 *  2. Open Graph meta tags -- decent fallback for title/price
 *  3. tel:/mailto: links -- sites often wrap an agent's contact info in a
 *     real link even when it's not part of any structured data block
 *  4. "Listed by: Name 555-123-4567" style text patterns -- common on
 *     listing sites, appears only in the visible description text
 *  5. crude last-resort regex scans over page text
 * Every field is meant to be reviewed/corrected by the user before saving,
 * not trusted blindly -- site markup varies and changes over time.
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

  // 1. schema.org JSON-LD
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

  // 3. tel:/mailto: links -- often present even when nothing else is structured
  if (!data.agent_phone) {
    const telLink = document.querySelector('a[href^="tel:"]');
    if (telLink) {
      data.agent_phone = telLink.getAttribute("href").replace(/^tel:/i, "").trim();
    }
  }
  if (!data.agent_email) {
    const mailLink = document.querySelector('a[href^="mailto:"]');
    if (mailLink) {
      data.agent_email = mailLink.getAttribute("href").replace(/^mailto:/i, "").split("?")[0].trim();
    }
  }

  // 4. "Listed by: Name 555-123-4567" style text patterns in the description
  if (!data.agent_name || !data.agent_phone) {
    const text = document.body.innerText || "";
    const match = text.match(
      /(?:Listed by|Listing agent|Presented by|Courtesy of)[:\s]+([A-Za-z.'-]+(?:\s+[A-Za-z.'-]+){0,3})\s*(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})?/i
    );
    if (match) {
      if (!data.agent_name && match[1]) data.agent_name = match[1].trim();
      if (!data.agent_phone && match[2]) data.agent_phone = match[2].trim();
    }
  }

  // 5. crude last-resort scans
  if (!data.agent_phone) {
    const anyPhone = (document.body.innerText || "").match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
    if (anyPhone) data.agent_phone = anyPhone[0];
  }
  if (!data.price) {
    const anyPrice = (document.body.innerText || "").match(/\$[\d,]{5,}/);
    if (anyPrice) data.price = num(anyPrice[0]);
  }

  return data;
}

async function captureActiveTab(tab) {
  if (!tab.id || !/^https?:/.test(tab.url || "")) {
    await chrome.storage.session.set({ lastExtraction: { error: "unsupported", capturedAt: Date.now() } });
    return;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractListingFromPage,
    });
    await chrome.storage.session.set({ lastExtraction: { data: result, capturedAt: Date.now() } });
  } catch (e) {
    await chrome.storage.session.set({
      lastExtraction: { error: String((e && e.message) || e), capturedAt: Date.now() },
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  // Open first, synchronously in response to the click, so the side panel
  // API's user-gesture requirement is satisfied before any other awaits.
  await chrome.sidePanel.open({ tabId: tab.id });
  await captureActiveTab(tab);
});
