"use strict";

/**
 * Per-site photo extraction.
 *
 * One module per listing site, deliberately isolated: changing how Zillow is
 * read must not be able to affect Redfin or homes.com. Each module declares
 * which hosts it handles and how to pick the subject listing's photos out of
 * a page that also contains other homes.
 *
 * These run in the SIDE PANEL, not in the page. The panel hands them the
 * page's HTML source and its og:image; nothing here touches the DOM, so each
 * rule can be exercised against a saved page.
 *
 * Every rule below was derived by counting a real page against the photo
 * count the site itself prints -- not assumed.
 */

/* ---------------------------------------------------------------- shared -- */

const JUNK_URL_HINTS = [
  "sprite", "icon", "favicon", "logo", "avatar", "placeholder", "blank.gif",
  "pixel.", "1x1.", "spacer.", "tracking", "noscript", "collector",
  "share_thumbnail", "nophoto", "/static/images/",
];

// Image URLs written plainly in the markup or inside an inline JSON blob,
// where "/" is usually escaped as "\/".
const IMAGE_URL_RE = /https?:\/\/[^\s"'()<>\\]+?\.(?:jpg|jpeg|png|webp)/gi;

function allImageUrls(html, pageUrl) {
  const out = new Set();
  const source = String(html || "").replace(/\\\//g, "/");
  let match;
  IMAGE_URL_RE.lastIndex = 0;
  while ((match = IMAGE_URL_RE.exec(source)) !== null) {
    let abs;
    try {
      abs = new URL(match[0], pageUrl).href;
    } catch (e) {
      continue;
    }
    if (/\.svg(\?|$)/i.test(abs)) continue;
    const low = abs.toLowerCase();
    if (JUNK_URL_HINTS.some((hint) => low.indexOf(hint) !== -1)) continue;
    out.add(abs);
  }
  return Array.from(out);
}

const widthIn = (url) => {
  const nums = (url.match(/(\d{3,4})(?=[^\d]*$)/g) || []).map(Number);
  return nums.length ? Math.max.apply(null, nums) : 0;
};

// jpg/png decode everywhere the video pipeline runs; webp is the same photo in
// a fussier container, so break size ties towards the safer format.
const formatRank = (url) => (/\.(jpg|jpeg)$/i.test(url) ? 2 : /\.png$/i.test(url) ? 1 : 0);

/**
 * Collapse the many renditions of one photo down to the best single URL.
 * `keyOf` is site-specific: it must return the same string for two URLs that
 * are the same photograph at different sizes, formats or CDN paths.
 */
function bestPerPhoto(urls, keyOf, scoreOf) {
  const score = scoreOf || ((url) => [widthIn(url), formatRank(url)]);
  const groups = new Map();
  urls.forEach((url) => {
    const key = keyOf(url.split("?")[0]).toLowerCase();
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, url);
      return;
    }
    const a = score(url);
    const b = score(prev);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) {
        if ((a[i] || 0) > (b[i] || 0)) groups.set(key, url);
        return;
      }
    }
  });
  return Array.from(groups.values());
}

const stripExtension = (url) => url.replace(/\.[a-z0-9]+$/i, "");

/* ---------------------------------------------------------------- zillow -- */

/**
 * Zillow serves the listing's own gallery in "cc_ft" renditions. Photos of
 * other homes on the page -- the similar-homes rails -- appear only as "sr_"
 * (search result) renditions. Measured on 6127 W 16th St: 58 distinct photo
 * hashes in the page, exactly 35 with a cc_ft variant, and the page reads
 * "See all 35 photos", with zero overlap between the two sets.
 *
 * The catch is that Zillow is a single-page app: browsing from one listing to
 * another leaves the previous listing's photos in the live DOM, and those are
 * cc_ft too. That is why capturing picked up "images from previous listings"
 * while re-fetching server-side was always right. The panel therefore reads a
 * freshly fetched copy of the page rather than the live DOM -- see
 * readListingSource() in sidepanel.js.
 */
const zillowExtractor = {
  id: "zillow",
  handles: (host) => host.indexOf("zillow.") !== -1,
  pick(html, pageUrl) {
    const gallery = allImageUrls(html, pageUrl).filter((u) => u.indexOf("-cc_ft_") !== -1);
    return bestPerPhoto(gallery, (url) =>
      stripExtension(url).replace(/-cc_ft_\d+$/i, "")
    );
  },
};

/* ---------------------------------------------------------------- redfin -- */

/**
 * Redfin uses two URL shapes depending on the listing, and og:image points
 * into whichever one the subject uses:
 *   /system_files/media/1242747_JPG/item_47.jpg
 *   /photo/158/mbpaddedwide/538/genMid.1890538_0.jpg
 * Both carry an id the subject's photos share and other listings' don't.
 *
 * Each photo also appears under sibling rendition directories that differ by
 * directory rather than filename. A media bundle carries five of them --
 * bare, genFirstLookEmail, genLdpUgcMediaBrowserUrl, ...Comp and
 * genLdpUgcThumb -- so a 56-photo listing arrives as 280 URLs; the /photo/
 * shape uses bigphoto / mbpaddedwide / mbphotov3 / midphoto / bcsphoto.
 */
// Renditions of one Redfin photo, best first. bigphoto is the full-screen
// original; bcsphoto is a small lightbox strip image.
const REDFIN_RENDITION_RANK = ["bigphoto", "mbpaddedwide", "mbphotov3", "midphoto", "bcsphoto"];

const redfinExtractor = {
  id: "redfin",
  handles: (host) => host.indexOf("redfin.") !== -1,
  pick(html, pageUrl, ogImage) {
    const all = allImageUrls(html, pageUrl);
    const marker = String(ogImage || "").match(/\/system_files\/media\/(\d+)_|genMid\.(\d+)_/i);
    if (!marker) return [];
    const id = marker[1] || marker[2];

    // The id sits in the directory for one URL shape and in the filename for
    // the other, and the filename carries a rendition prefix (genMid., genBcs.)
    // on some renditions but not on bigphoto.
    const inFilename = new RegExp("(^|[/.])" + id + "_");
    const own = all.filter((u) => {
      if (u.indexOf("/media/" + id + "_") !== -1) return true;
      return inFilename.test(u.split("/").pop());
    });

    return bestPerPhoto(
      own,
      (url) =>
        stripExtension(url)
          // any gen* segment inside a media bundle is a rendition of one photo
          .replace(/(\/system_files\/media\/[^/]+\/)gen[A-Za-z0-9]+\//i, "$1")
          .replace(/(\/photo\/\d+\/)[a-z0-9]+(\/\d+\/)/i, "$1$2")
          .replace(/\/gen[A-Za-z]+\.(?=\d)/i, "/"),
      (url) => {
        // In a media bundle the un-prefixed path is the original; every gen*
        // sibling is a derived, smaller copy.
        const bundle = url.match(/\/system_files\/media\/[^/]+\/(gen[A-Za-z0-9]+\/)?/i);
        if (bundle) return [bundle[1] ? 1 : 2, formatRank(url)];

        const rendition = (url.match(/\/photo\/\d+\/([a-z0-9]+)\//i) || [])[1] || "";
        const rank = REDFIN_RENDITION_RANK.indexOf(rendition.toLowerCase());
        return [rank === -1 ? 0 : REDFIN_RENDITION_RANK.length - rank, formatRank(url)];
      }
    );
  },
};

/* ----------------------------------------------------------------- homes -- */

/**
 * homes.com repeats the address slug from the page URL in every real photo's
 * filename, and in none of its chrome. Confirmed against a real page: 9
 * candidate images reduce to exactly the 6 property photos, dropping the site
 * logo, a floorplan SVG and a banner.
 *
 * This site refuses the backend outright -- 403 on its pages and on its image
 * CDN -- so the extension is the only thing that can read it at all.
 */
const homesExtractor = {
  id: "homes",
  handles: (host) => host.indexOf("homes.com") !== -1,
  pick(html, pageUrl) {
    const slugMatch = String(pageUrl).match(/\/property\/([^/?#]+)/i);
    if (!slugMatch) return [];
    const slug = slugMatch[1].toLowerCase();
    const own = allImageUrls(html, pageUrl).filter((u) => u.toLowerCase().indexOf(slug) !== -1);
    return bestPerPhoto(own, (url) => stripExtension(url).replace(/-\d+$/, ""));
  },
};

/* --------------------------------------------------------------- generic -- */

/**
 * Anything without a rule of its own. No supported site routes here today --
 * Zillow, Redfin and homes.com each have one -- so this exists for whatever
 * gets added next, and stays cautious on purpose. A gallery normally lives in
 * one directory and og:image is always a photo of the subject, so prefer that
 * directory when it holds more than one image; otherwise stay on og:image's
 * host.
 */
const genericExtractor = {
  id: "generic",
  handles: () => true,
  pick(html, pageUrl, ogImage) {
    const all = allImageUrls(html, pageUrl);
    const og = String(ogImage || "");
    let own = all;
    if (/^https?:/i.test(og)) {
      const directory = og.split("?")[0].replace(/\/[^/]*$/, "/");
      const sameDir = all.filter((u) => u.indexOf(directory) === 0);
      if (sameDir.length > 1) {
        own = sameDir;
      } else {
        try {
          const host = new URL(og).host;
          const sameHost = all.filter((u) => {
            try {
              return new URL(u).host === host;
            } catch (e) {
              return false;
            }
          });
          if (sameHost.length) own = sameHost;
        } catch (e) {
          /* leave the list alone */
        }
      }
    }
    return bestPerPhoto(own, (url) =>
      stripExtension(url).replace(/[-_](\d{3,4})x(\d{3,4})$/i, "")
    );
  },
};

const EXTRACTORS = [zillowExtractor, redfinExtractor, homesExtractor, genericExtractor];

function extractorFor(pageUrl) {
  let host = "";
  try {
    host = new URL(pageUrl).host.toLowerCase();
  } catch (e) {
    host = "";
  }
  return EXTRACTORS.find((e) => e.handles(host)) || genericExtractor;
}

/** Returns { source, photos } for a page's HTML. */
function pickListingPhotos(html, pageUrl, ogImage, max) {
  const extractor = extractorFor(pageUrl);
  const photos = extractor.pick(html, pageUrl, ogImage) || [];
  return { source: extractor.id, photos: photos.slice(0, max || 60) };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { pickListingPhotos, extractorFor, allImageUrls, bestPerPhoto, pickListingAgent };
}

/* ============================================================================
   Agent attribution
   ============================================================================

   Who listed the property, taken from each site's own structured data rather
   than from page text. Two reasons this is worth doing separately:

   The phone shown beside a listing is often the brokerage switchboard, while
   the structured field carries the agent's direct line. On one Redfin listing
   the structured number (513-382-2751) matched the agent's mobile as
   published independently on the web, and on a Zillow listing the structured
   number differed from the one being scraped off the page entirely.

   The brokerage is not captured at all today, and it is the key to finding an
   agent whose email the listing doesn't publish -- Zillow never publishes one.

   As with photos: one module per site, each verified against a real page.
*/

// Site JSON escapes both slashes and ampersands ("Comey & Shepherd").
function decodeJsonText(value) {
  return String(value || "")
    // JSON inside JSON: an escape can arrive with one backslash or two, and
    // it isn't only ampersands -- "Comey \u0026 Shepherd" came back verbatim
    // when this only handled the single-backslash form. Decode any of them.
    .replace(/\\{1,2}u([0-9a-fA-F]{4})/g, (whole, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\+"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function firstJsonString(html, key) {
  const match = new RegExp('"' + key + '"\\s*:\\s*"([^"]{2,120})"').exec(html || "");
  return match ? decodeJsonText(match[1]) : null;
}

const AGENT_RULES = [
  {
    // Zillow's attributionInfo. agentEmail is present but has been null on
    // every listing checked, so email always needs an outside lookup here.
    // On a builder's new-construction listing agentName is null too and the
    // phone is the builder's sales line -- there is no agent to find.
    id: "zillow",
    handles: (host) => host.indexOf("zillow.") !== -1,
    pick(html) {
      const blob = (html || "").slice((html || "").indexOf("attributionInfo"));
      if (!blob) return null;
      const window_ = blob.slice(0, 600);
      return {
        agent_name: firstJsonString(window_, "agentName"),
        agent_phone: firstJsonString(window_, "agentPhoneNumber"),
        agent_email: firstJsonString(window_, "agentEmail"),
        brokerage: firstJsonString(window_, "brokerName"),
      };
    },
  },
  {
    // Redfin names the listing agent specifically. Note brokerageName is
    // "Redfin Corporation" -- the site itself, not the listing's brokerage --
    // so listingBrokerName is the one that means anything.
    id: "redfin",
    handles: (host) => host.indexOf("redfin.") !== -1,
    pick(html) {
      return {
        agent_name: firstJsonString(html, "listingAgentName"),
        agent_phone: firstJsonString(html, "listingAgentNumber"),
        agent_email: null,
        brokerage:
          firstJsonString(html, "listingBrokerName") || firstJsonString(html, "brokerName"),
      };
    },
  },
];

/**
 * Structured agent details for a listing, or null when the site has no rule
 * yet. homes.com is deliberately absent: no real page has been available to
 * derive one from, and guessing at page structure is what has gone wrong
 * before -- it keeps using the existing text parsing until then.
 */
function pickListingAgent(html, pageUrl) {
  let host = "";
  try {
    host = new URL(pageUrl).host.toLowerCase();
  } catch (e) {
    return null;
  }
  const rule = AGENT_RULES.find((r) => r.handles(host));
  if (!rule) return null;

  const found = rule.pick(decodeJsonText === null ? html : String(html || "")) || {};
  const clean = {};
  ["agent_name", "agent_phone", "agent_email", "brokerage"].forEach((field) => {
    const value = found[field];
    // "null" arrives as the literal word when the JSON value is null.
    if (value && value !== "null") clean[field] = value;
  });
  if (!Object.keys(clean).length) return null;
  clean.source = rule.id;
  return clean;
}
