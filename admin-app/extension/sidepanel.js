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
/**
 * Advances a listing's photo carousel so its images actually load.
 *
 * homes.com keeps most of a gallery out of both the served HTML and the DOM:
 * a 30-photo listing had 6 in its source and 11 rendered. The photos are in a
 * carousel on the page, and they load as ordinary <img> tags once you page
 * through it -- but the carousel is JavaScript-driven, not natively
 * scrollable, so setting scrollLeft only breaks its rendering (measured: 10
 * photos before, 10 after, and the strip went blank). Clicking its next
 * control is what actually advances it.
 *
 * The control is found by role rather than by a brittle site-specific
 * selector: anything button-like whose label, class or title reads as
 * "next"/"forward"/"right". Whichever candidate actually yields new photos is
 * the real one. Runs only for homes.com; Zillow and Redfin give up their
 * galleries in the page source and never need this.
 *
 * Injected, so it must be fully self-contained.
 */
async function advanceCarousel(matchText) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = new Set();
  const collect = () => {
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (src && src.indexOf("data:") !== 0 && src.toLowerCase().indexOf(matchText) !== -1) {
        found.add(src);
      }
    });
  };
  collect();

  const labelOf = (el) => {
    const cls =
      el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "";
    return ((el.getAttribute("aria-label") || "") + " " + cls + " " + (el.title || "")).toLowerCase();
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const ARROW_SELECTOR =
    '[class*="chevron-right" i], [class*="chevronright" i], [class*="arrow-right" i],' +
    '[class*="arrowright" i], [class*="next" i], [class*="forward" i]';

  // Confine the search to the photo strip, by geometry rather than by DOM
  // structure. Walking up from a photo does not work here: homes.com renders
  // each photo in its own subtree, so the first ancestor holding several of
  // them is <html> itself -- which put the whole page back in scope and let
  // the next-listing arrow be clicked, moving the tab to another property.
  //
  // The union of the listing photos' boxes is the strip. An arrow that
  // advances it sits on or beside that strip; next-listing and unrelated
  // controls sit elsewhere on the page.
  const listingImages = Array.prototype.slice
    .call(document.querySelectorAll("img"))
    .filter((img) => {
      const src = img.currentSrc || img.src || "";
      return src.toLowerCase().indexOf(matchText) !== -1;
    });

  const boxes = listingImages
    .map((img) => img.getBoundingClientRect())
    .filter((r) => r.width > 40 && r.height > 40);

  // No visible photos means no reliable strip to aim at. Paging blind is what
  // navigated the tab away, so do nothing rather than guess.
  if (!boxes.length) return Array.from(found);

  const strip = boxes.reduce(
    (acc, r) => ({
      left: Math.min(acc.left, r.left),
      top: Math.min(acc.top, r.top),
      right: Math.max(acc.right, r.right),
      bottom: Math.max(acc.bottom, r.bottom),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  );

  const PAD = 80; // an arrow may overhang the edge of the strip
  const onStrip = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return (
      cx >= strip.left - PAD &&
      cx <= strip.right + PAD &&
      cy >= strip.top - PAD &&
      cy <= strip.bottom + PAD
    );
  };

  // Anything inside a link to a different property is next-listing
  // navigation, whatever it looks like.
  const leavesListing = (el) => {
    const link = el.closest("a[href]");
    if (!link) return false;
    const href = link.getAttribute("href") || "";
    return href.indexOf("/property/") !== -1 && href.indexOf(matchText) === -1;
  };

  const byClass = Array.prototype.slice.call(document.querySelectorAll(ARROW_SELECTOR));
  const byRole = Array.prototype.slice
    .call(document.querySelectorAll('button, [role="button"]'))
    .filter((el) => /next|forward|right|arrow/.test(labelOf(el)));

  // A click on the icon bubbles to whichever ancestor carries the handler,
  // which is how a real click works too. Promote only to a button -- never to
  // an <a>: doing that navigated off the listing to an unrelated article.
  const candidates = [];
  byClass.concat(byRole).forEach((el) => {
    if (!visible(el) || !onStrip(el) || leavesListing(el)) return;
    const target = el.closest('button, [role="button"]') || el;
    if (candidates.indexOf(target) === -1) candidates.push(target);
  });
  candidates.length = Math.min(candidates.length, 3);

  // Belt and braces: whatever we click, do not let it navigate. A carousel
  // control that is really a link, or one nested inside a promo link, would
  // otherwise take the tab elsewhere mid-capture.
  const blockNavigation = (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    // preventDefault only: it cancels the navigation while still letting the
    // carousel's own handler run. stopPropagation would kill the paging too
    // whenever the arrow happens to sit inside a link.
    if (link) event.preventDefault();
  };
  window.addEventListener("click", blockNavigation, true);

  // The anchor guard cannot stop a single-page-app router, which moves the
  // page by calling history.pushState directly. Hold those still while paging
  // and restore them afterwards.
  const realPushState = history.pushState;
  const realReplaceState = history.replaceState;
  history.pushState = function () {};
  history.replaceState = function () {};

  // The page states how many photos the listing has ("30 photos"). Where it
  // does, that is a hard stop: reaching it means never clicking past the end
  // of the gallery at all, which is where the next-listing navigation lives.
  // Take the largest number stated, not the first: a page can mention a
  // smaller count elsewhere ("6 photos of the kitchen"), and stopping on that
  // would truncate the capture. Overshooting the real count is harmless --
  // the idle check still ends the loop.
  let expected = 0;
  const counts = (document.body.innerText || "").match(/(\d{1,3})\s*(?:photos|images)/gi) || [];
  counts.forEach((text) => {
    const n = parseInt(text, 10);
    if (n > expected && n <= 300) expected = n;
  });

  const startedAt = location.href;
  try {
  for (const control of candidates) {
    let idle = 0;
    // Two unproductive clicks, not four. Every click past the end of the
    // gallery is one that can trip homes.com's next-listing navigation, which
    // moved the tab onto another property after a successful capture -- and a
    // panel then showing a different listing invites saving the wrong lead.
    // Cutting the tolerance risks mistaking a slow-loading photo for the end,
    // so the wait per click goes up to compensate.
    for (let i = 0; i < 40 && idle < 2; i++) {
      if (expected && found.size >= expected) break;
      const before = found.size;
      try {
        control.click();
      } catch (e) {
        break;
      }
      await sleep(260);
      collect();
      // Stop early once clicking stops producing anything new: either the
      // carousel has wrapped around or this control was the wrong one.
      idle = found.size > before ? 0 : idle + 1;
      // If the page moved anyway, stop immediately: anything read from here
      // belongs to a different listing.
      if (location.href !== startedAt) return Array.from(found);
    }
  }
  } finally {
    window.removeEventListener("click", blockNavigation, true);
    history.pushState = realPushState;
    history.replaceState = realReplaceState;
  }
  return Array.from(found);
}

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

  // The rendered <img> tags, always collected. They belong to the listing
  // actually on screen, so they are safe to use where the fetched source
  // falls short -- but never as a substitute for it on a single-page app,
  // where document.documentElement also holds every listing visited earlier
  // in this tab. See how `material` is chosen in capturePhotos().
  let domUrls = [];
  {
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
 * Injected to read chosen images and hand back their bytes.
 *
 * Runs in the page so requests carry the site's own origin and cookies, which
 * is what makes this work at all for a site whose CDN refuses our backend.
 * The catch is that a page-context fetch is still subject to CORS, and a
 * listing's photos usually live on a different host than the listing itself
 * (images.homes.com vs www.homes.com). Where that host sends no CORS headers
 * the read fails, so each URL reports back individually and the panel retries
 * the failures from the extension, which host_permissions exempt from CORS.
 */
async function fetchImagesAsDataUrls(urls) {
  const out = [];
  for (const url of urls) {
    let data = null;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.indexOf("image/") === 0 && blob.size >= 3000) {
          data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      }
    } catch (e) {
      // CORS, or the image simply didn't load -- the panel will retry it
    }
    out.push({ url: url, data: data });
  }
  return out;
}

/** Same read, but from the extension, where host_permissions grant
 *  cross-origin access without the site needing to send CORS headers. */
async function fetchFromExtension(urls) {
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
      // nothing more to try for this one
    }
  }
  return out;
}

async function capturePhotos(onProgress) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return [];

    // homes.com hides most of its gallery until the carousel is paged
    // through, so advance it first -- as a separate injection, because an
    // injected function is serialised on its own and cannot call another.
    let carouselUrls = [];
    const tabUrl = tab.url || "";
    if (/homes\.com/i.test(tabUrl)) {
      const slugMatch = tabUrl.match(/\/property\/([^/?#]+)/i);
      if (slugMatch) {
        const paged = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: advanceCarousel,
          args: [slugMatch[1].toLowerCase()],
        });
        carouselUrls = (paged && paged[0] && paged[0].result) || [];
        console.log(`[Estly] homes: carousel yielded ${carouselUrls.length} photos`);
      }
    }

    const [{ result: page }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readListingSource,
    });
    if (!page) return [];

    // Per-site rules live in extractors.js so changing one site can't affect
    // another. In degraded mode the rendered image URLs stand in for the page
    // source, so the same per-site filter still applies to them.
    // homes.com withholds most of its gallery from the HTML: measured on a
    // 30-photo listing the served page carried 6 of them while the rendered
    // page carried 11. Merging both gets what is actually reachable. Safe
    // here specifically because the homes rule filters on the address slug
    // from the current URL, so an image left over from another listing
    // cannot survive it -- untrue of Zillow, whose live DOM holds
    // indistinguishable photos from every listing visited in the tab.
    const host = (() => { try { return new URL(page.href).host; } catch (e) { return ""; } })();
    const mergeDom = host.indexOf("homes.com") !== -1;

    const material = page.fresh
      ? mergeDom
        ? page.html + "\n" + page.domUrls.concat(carouselUrls).join("\n")
        : page.html
      : page.domUrls.concat(carouselUrls).join("\n");
    if (!material) return [];
    const { source, photos } = pickListingPhotos(material, page.href, page.og, 60);
    console.log(
      `[Estly] ${source} extractor picked ${photos.length} photos` +
        (page.fresh ? "" : " (degraded: page re-fetch failed, on-screen images only)")
    );
    if (!photos.length) return [];

    if (onProgress) onProgress(photos.length);

    // homes.com serves its photos from images.homes.com with no
    // Access-Control-Allow-Origin, so a read from the page is refused every
    // time -- confirmed in a real console: "net::ERR_FAILED 200 (OK)", the CDN
    // answered and the browser blocked it. Going straight to the extension
    // skips thirty guaranteed failures and thirty console errors. Zillow and
    // Redfin allow the page read, so they keep it.
    if (source === "homes") {
      const direct = await fetchFromExtension(photos);
      console.log(`[Estly] homes: read ${direct.length} of ${photos.length} images from the extension`);
      return direct;
    }

    const scripted = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchImagesAsDataUrls,
      args: [photos],
    });
    const results = scripted && scripted[0] ? scripted[0].result : null;

    const collected = (results || []).filter((r) => r && r.data).map((r) => r.data);
    const blocked = (results || []).filter((r) => r && !r.data).map((r) => r.url);
    if (blocked.length) {
      console.log(`[Estly] ${blocked.length} images unreadable from the page (CORS?), retrying from the extension`);
      const rescued = await fetchFromExtension(blocked);
      console.log(`[Estly] recovered ${rescued.length} of ${blocked.length}`);
      collected.push.apply(collected, rescued);
    }
    return collected;
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
  // `found` is what the site's gallery holds; photosBase64 is what we managed
  // to read. Reporting both in the panel means diagnosing a bad capture never
  // requires opening DevTools on the side panel.
  let found = 0;
  const photosBase64 = await capturePhotos((n) => {
    found = n;
    setStatus(`Downloading ${n} photos…`);
  });
  if (photosBase64.length) payload.photos_base64 = photosBase64;
  setStatus(found ? `Saving ${photosBase64.length} of ${found} photos…` : "Saving…");

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
    const photoNote = found
      ? ` ${photosBase64.length} of ${found} photos.`
      : " No photos found on this page.";
    setStatus(
      (body._merged ? "Merged into existing lead." : "Saved.") +
        photoNote +
        " Click Open Pipeline to view it.",
      photosBase64.length === found ? "ok" : "warn"
    );
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
