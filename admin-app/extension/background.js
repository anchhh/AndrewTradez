"use strict";

/**
 * Runs inside the current tab's page context via chrome.scripting.executeScript.
 * Must be fully self-contained (no references to anything outside this
 * function) since it's serialized and injected on demand -- nothing runs
 * until the user clicks the toolbar icon and this executes once.
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
  else if (host.indexOf("realtor") !== -1) detectedSource = "realtor";
  else if (host.indexOf("airbnb") !== -1) detectedSource = "airbnb";

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

async function captureActiveTab(tab) {
  if (!tab.id || !/^https?:/.test(tab.url || "")) {
    await chrome.storage.session.set({ lastCapture: { error: "unsupported", capturedAt: Date.now() } });
    return;
  }
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractRawFromPage,
    });
    await chrome.storage.session.set({ lastCapture: { raw: result, capturedAt: Date.now() } });
  } catch (e) {
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
  await captureActiveTab(tab);
});
