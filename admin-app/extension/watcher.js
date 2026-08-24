"use strict";

/**
 * Runs on every http/https page automatically (declared content script,
 * not injected on click). This is what lets the side panel update itself
 * as you navigate between listings in the same tab, without re-clicking
 * the toolbar icon each time.
 *
 * Trade-off, spelled out: this is standing access to read text on any
 * page you visit, not the click-gated read the rest of this extension
 * otherwise uses. It only ever reads the current page's own visible
 * text/JSON-LD/tel-mailto links (the same material background.js reads on
 * a toolbar click) and sends that to the extension's own background
 * script -- never to any external server. Nothing is saved to Estly
 * unless you explicitly click Save in the side panel.
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

let lastCapturedHref = null;
let captureTimer = null;

function pushCapture() {
  try {
    chrome.runtime.sendMessage({ type: "ESTLY_PAGE_CAPTURE", raw: extractRawFromPage() });
  } catch (e) {
    // extension context can go away on reload; nothing to do
  }
}

function capture() {
  if (location.href === lastCapturedHref) return;
  lastCapturedHref = location.href;
  pushCapture();
}

// The background script asks for this when the user switches to this tab,
// or when this tab finishes loading while already focused -- neither of
// those changes location.href on their own, so capture() above wouldn't
// otherwise notice. Forces a fresh read even if the URL is unchanged, so
// the panel reflects whatever tab is actually focused without needing a
// manual re-click.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "ESTLY_REQUEST_CAPTURE") {
    lastCapturedHref = location.href;
    pushCapture();
  }
});

function scheduleCapture() {
  clearTimeout(captureTimer);
  // Small delay so SPA route changes (Zillow/Airbnb card-to-card
  // navigation) have time to render the new listing's content first.
  captureTimer = setTimeout(capture, 400);
}

// Initial load
scheduleCapture();

// Full navigations / back-forward
window.addEventListener("popstate", scheduleCapture);

// SPA route changes -- most listing sites swap between properties via
// history.pushState/replaceState without a full page reload or a
// popstate event. Content scripts run in an isolated JS world, so
// patching history.pushState here can't intercept the page's own calls
// to it (a real Chrome extension limitation, not a shortcut) -- polling
// location.href is what actually works, since location itself (unlike a
// monkey-patched function) is the same shared object across worlds.
setInterval(() => {
  if (location.href !== lastCapturedHref) scheduleCapture();
}, 700);
