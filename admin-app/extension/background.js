"use strict";

/**
 * Runs inside the current tab's page context via chrome.scripting.executeScript.
 * Must be fully self-contained (no references to anything outside this
 * function) since it's serialized and injected on demand.
 *
 * This step only GATHERS raw material (visible text, JSON-LD blocks,
 * tel:/mailto: links) -- it doesn't interpret any of it. Interpretation
 * happens in the side panel via parsers.js, which can re-run against this
 * same cached material when the user switches the site tab, with no
 * further page access needed.
 */
function extractRawFromPage() {
  const jsonLd = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      jsonLd.push(JSON.parse(s.textContent));
    } catch (e) {
      // ignore malformed blocks
    }
  });

  const telLinks = Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) =>
    a.getAttribute("href").replace(/^tel:/i, "").trim()
  );
  const mailLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map((a) =>
    a.getAttribute("href").replace(/^mailto:/i, "").split("?")[0].trim()
  );

  function metaContent(prop) {
    const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return el ? el.getAttribute("content") : null;
  }

  const host = location.hostname.replace(/^www\./, "");
  let detectedSource = "manual";
  if (host.indexOf("zillow") !== -1) detectedSource = "zillow";
  else if (host.indexOf("redfin") !== -1) detectedSource = "redfin";
  else if (host.indexOf("homes.com") !== -1) detectedSource = "homes";

  return {
    url: location.href,
    title: document.title,
    ogTitle: metaContent("og:title"),
    bodyText: document.body.innerText || "",
    jsonLd,
    telLinks,
    mailLinks,
    detectedSource,
  };
}

// True only on an actual single-listing detail page, not a search/map
// results page -- e.g. Zillow's split map+list search view lives at the
// same kind of URL shape as a listing and updates its own state (pin
// selection, map pan) without a real navigation, but its content is a
// grid of many listings, not the one the user has "open".
function isListingUrl(host, pathname) {
  if (host.indexOf("zillow") !== -1) return pathname.indexOf("/homedetails/") !== -1;
  // Homes.com's pattern is confirmed against a real listing. Redfin's is
  // still a best-effort guess -- see parsers.js's addressFromRedfinUrl.
  if (host.indexOf("redfin") !== -1) return /\/home\/\d+/.test(pathname);
  if (host.indexOf("homes.com") !== -1) return pathname.indexOf("/property/") !== -1;
  return false;
}

// Tracks the last URL actually captured per tab, so repeated events for
// the exact same page (tabs.onUpdated firing more than once per
// navigation is normal) don't re-inject and re-read the page needlessly.
const lastCapturedUrlByTab = new Map();

async function captureActiveTab(tab, { force = false } = {}) {
  if (!tab.id || !/^https?:/.test(tab.url || "")) {
    console.log("[Estly] background: unsupported tab", tab && tab.url);
    lastCapturedUrlByTab.delete(tab.id);
    await chrome.storage.session.set({ lastCapture: { error: "unsupported", capturedAt: Date.now() } });
    return;
  }

  const { hostname, pathname } = new URL(tab.url);
  if (!isListingUrl(hostname.replace(/^www\./, ""), pathname)) {
    // A real page, just not a listing detail page (e.g. Zillow's map/search
    // view) -- clear instead of trying to parse it as one.
    console.log("[Estly] background: not a listing page, clearing", tab.url);
    lastCapturedUrlByTab.delete(tab.id);
    await chrome.storage.session.set({ lastCapture: null });
    return;
  }

  if (!force && lastCapturedUrlByTab.get(tab.id) === tab.url) {
    console.log("[Estly] background: already captured this exact url, skipping", tab.url);
    return;
  }
  lastCapturedUrlByTab.set(tab.id, tab.url);

  console.log("[Estly] background: capturing", tab.url);
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractRawFromPage,
    });
    console.log("[Estly] background: captured ok", result && result.url);
    await chrome.storage.session.set({ lastCapture: { raw: result, capturedAt: Date.now() } });
  } catch (e) {
    console.warn("[Estly] background: executeScript failed", e);
    await chrome.storage.session.set({
      lastCapture: { error: String((e && e.message) || e), capturedAt: Date.now() },
    });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  // Open first, synchronously in response to the click, so the side panel
  // API's user-gesture requirement is satisfied before any other awaits.
  await chrome.sidePanel.open({ tabId: tab.id });
  await captureActiveTab(tab, { force: true });
});

// Everything below is what makes the panel update itself automatically as
// the user browses between listings, with no content script involved:
// chrome.tabs.onUpdated fires with changeInfo.url for BOTH full page
// navigations and SPA-style history.pushState/replaceState transitions
// (which is how Zillow/Redfin/Homes.com move between listings without a
// full reload), driven by Chrome's own tab-tracking rather than a script
// running inside the page -- so there's nothing that can go stale after
// an extension reload the way a content script can.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  console.log("[Estly] background: tabs.onActivated", tabId);
  chrome.tabs.get(tabId, (tab) => {
    if (tab) captureActiveTab(tab);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url || changeInfo.status === "complete")) {
    console.log("[Estly] background: tabs.onUpdated", tabId, changeInfo, tab.url);
    captureActiveTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => lastCapturedUrlByTab.delete(tabId));
