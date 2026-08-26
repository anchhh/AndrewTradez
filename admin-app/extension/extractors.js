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
function bestPerPhoto(urls, keyOf) {
  const groups = new Map();
  urls.forEach((url) => {
    const key = keyOf(url.split("?")[0]).toLowerCase();
    const prev = groups.get(key);
    const better =
      !prev ||
      widthIn(url) > widthIn(prev) ||
      (widthIn(url) === widthIn(prev) && formatRank(url) > formatRank(prev));
    if (better) groups.set(key, url);
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
 * Each photo also appears under sibling rendition directories
 * (genLdpUgcMediaBrowserUrl / ...Comp, or mbpaddedwide / mbphotov3 /
 * midphoto), which differ by directory rather than filename.
 */
const redfinExtractor = {
  id: "redfin",
  handles: (host) => host.indexOf("redfin.") !== -1,
  pick(html, pageUrl, ogImage) {
    const all = allImageUrls(html, pageUrl);
    const marker = String(ogImage || "").match(/\/system_files\/media\/(\d+)_|genMid\.(\d+)_/i);
    if (!marker) return [];
    const id = marker[1] || marker[2];
    const own = all.filter(
      (u) =>
        u.indexOf("/media/" + id + "_") !== -1 ||
        u.toLowerCase().indexOf("genmid." + id + "_") !== -1
    );
    return bestPerPhoto(own, (url) =>
      stripExtension(url)
        .replace(/\/gen[A-Za-z]*MediaBrowserUrl[A-Za-z]*(?=\/)/i, "")
        .replace(/(\/photo\/\d+\/)[a-z0-9]+(\/\d+\/)/i, "$1$2")
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
  module.exports = { pickListingPhotos, extractorFor, allImageUrls, bestPerPhoto };
}
