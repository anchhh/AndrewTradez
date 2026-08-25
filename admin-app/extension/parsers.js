"use strict";

/**
 * Field-parsing logic, separated from page-reading (background.js).
 * Background.js gathers raw material from the page ONCE per toolbar-icon
 * click (the privileged, permission-gated step); everything here just
 * interprets plain text/JSON already captured, so switching the site tab
 * in the panel can re-parse instantly with no new page access.
 */

const STATE_ABBR = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

function expandState(abbrOrName) {
  if (!abbrOrName) return null;
  const trimmed = String(abbrOrName).trim();
  const full = STATE_ABBR[trimmed.toUpperCase()];
  return full || trimmed;
}

// Zillow's listing URL slug is a structured, guaranteed-present encoding
// of the address -- e.g. .../homedetails/6806-W-3rd-St-UNIT-27-Greeley-CO-80634/...
// -- immune to whatever the page's own DOM/text happens to contain (the
// stray nearby-listing/community-address bleed-through that plagued plain
// text scraping). Parsing it is the single most reliable address source
// available and takes priority over everything else.
const STREET_SUFFIXES = new Set([
  "st", "ave", "rd", "dr", "ln", "ct", "way", "blvd", "pl", "cir", "ter",
  "pkwy", "hwy", "trl", "loop", "pass", "row", "sq", "aly", "byp", "cswy",
  "xing", "expy", "fwy", "walk", "run", "path", "pike", "plz", "sta",
]);
const UNIT_MARKERS = new Set(["unit", "apt", "ste", "bldg", "fl", "rm", "no"]);

function looksLikeUnitToken(tok) {
  return /^\d+[A-Za-z]?$/.test(tok) || /^[A-Za-z]\d*$/.test(tok);
}

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
}

// Shared by any site whose URL slug dumps street+city together as one
// dash-separated run with no delimiter between them (Zillow, Homes.com)
// -- figures out where the street ends and the city begins from the last
// recognizable street-suffix word (St, Ave, Rd, ...) or explicit unit
// marker (UNIT, APT, ...), absorbing a bare unit number/letter that
// immediately follows even with no marker word (these URLs drop
// punctuation like "#", so "...-St-414-City" is a real pattern, not just
// "...-St-UNIT-414-City"). `rest` is just the street+city tokens -- state
// and zip (encoded differently by every site) are stripped by the caller
// first. Returns null if there's nothing left for the city.
function splitStreetAndCity(rest) {
  if (!rest.length) return null;

  let boundary = -1;
  for (let i = 0; i < rest.length; i++) {
    const lower = rest[i].toLowerCase();
    if (STREET_SUFFIXES.has(lower)) {
      boundary = i;
      if (i + 1 < rest.length - 1 && looksLikeUnitToken(rest[i + 1])) {
        boundary = i + 1;
      }
    } else if (UNIT_MARKERS.has(lower)) {
      boundary = Math.min(i + 1, rest.length - 1);
    }
  }
  // No recognizable suffix/marker at all (rare) -- fall back to assuming
  // a single-word city, the common case.
  if (boundary === -1) boundary = rest.length - 2;
  if (boundary < 0) return null;

  const streetTokens = rest.slice(0, boundary + 1);
  const cityTokens = rest.slice(boundary + 1);
  if (!streetTokens.length || !cityTokens.length) return null;

  return { address: streetTokens.join(" "), city: cityTokens.join(" ") };
}

function addressFromZillowUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\/homedetails\/([^/]+)\//);
    if (!m) return null;

    const tokens = m[1].split("-").filter(Boolean);
    if (tokens.length < 4) return null; // not enough for street + city + state + zip
    const zip = tokens[tokens.length - 1];
    const state = tokens[tokens.length - 2];
    if (!/^\d{5}$/.test(zip) || !/^[A-Za-z]{2}$/.test(state)) return null;

    const split = splitStreetAndCity(tokens.slice(0, tokens.length - 2));
    if (!split) return null;
    return {
      address: split.address,
      city: split.city,
      state: expandState(state.toUpperCase()),
      zip_code: zip,
    };
  } catch (e) {
    return null;
  }
}

// Verified against a real Homes.com listing
// (homes.com/property/1829-lincoln-ave-cincinnati-oh/tz89lplxs5q78/):
// slug is <street>-<city>-<ST> all lowercase, with NO zip encoded in the
// URL at all (unlike Zillow) -- zip falls back to page text/JSON-LD.
function addressFromHomesUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\/property\/([^/]+)/);
    if (!m) return null;

    const tokens = m[1].split("-").filter(Boolean);
    if (tokens.length < 3) return null; // need at least street + city + state
    const state = tokens[tokens.length - 1];
    if (!/^[A-Za-z]{2}$/.test(state)) return null;

    const split = splitStreetAndCity(tokens.slice(0, tokens.length - 1));
    if (!split) return null;
    return {
      address: titleCase(split.address),
      city: titleCase(split.city),
      state: expandState(state.toUpperCase()),
      zip_code: null,
    };
  } catch (e) {
    return null;
  }
}

// Best-effort guess at Redfin's URL shape
// (.../<ST>/<City>/<street-slug>-<zip>/home/<id>), not yet verified
// against a real page. Unlike Zillow/Homes.com, the city is already its
// own path segment here, so no suffix-guessing is needed for it -- only
// the trailing zip needs splitting off the street segment.
function addressFromRedfinUrl(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (segments.length < 4) return null;
    const [state, city, streetZip] = segments;
    if (!/^[A-Za-z]{2}$/.test(state)) return null;

    const tokens = streetZip.split("-").filter(Boolean);
    if (tokens.length < 2) return null;
    const zip = tokens[tokens.length - 1];
    if (!/^\d{5}$/.test(zip)) return null;
    const streetTokens = tokens.slice(0, tokens.length - 1);
    if (!streetTokens.length) return null;

    return {
      address: streetTokens.join(" "),
      city: city.replace(/-/g, " ").trim(),
      state: expandState(state.toUpperCase()),
      zip_code: zip,
    };
  } catch (e) {
    return null;
  }
}

// Realtor.com's URL format cleanly delimits street/city/state/zip with
// underscores (.../123-Main-St_City_ST_12345_M12345-67890), so no
// suffix-guessing heuristic is needed -- just split on "_".
function addressFromRealtorUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\/realestateandhomes-detail\/([^/]+)/);
    if (!m) return null;

    const parts = m[1].split("_");
    if (parts.length < 4) return null;
    const [streetPart, cityPart, state, zip] = parts;
    if (!/^\d{5}$/.test(zip) || !/^[A-Za-z]{2}$/.test(state)) return null;

    return {
      address: streetPart.replace(/-/g, " ").trim(),
      city: cityPart.replace(/-/g, " ").trim(),
      state: expandState(state.toUpperCase()),
      zip_code: zip,
    };
  } catch (e) {
    return null;
  }
}

function addressFromListingUrl(url, source) {
  if (source === "zillow") return addressFromZillowUrl(url);
  if (source === "realtor") return addressFromRealtorUrl(url);
  if (source === "redfin") return addressFromRedfinUrl(url);
  if (source === "homes") return addressFromHomesUrl(url);
  return null;
}

function formatPrice(n) {
  if (n == null || isNaN(n)) return "";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function parsePriceInput(str) {
  if (str == null || str === "") return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

const PROPERTY_TYPES = [
  "Single Family", "Condominium", "Condo", "Townhouse", "Multi-Family",
  "Co-op", "Manufactured", "Mobile Home", "Land", "Apartment", "House",
  "Duplex", "Triplex",
];

function findPropertyType(text) {
  for (const type of PROPERTY_TYPES) {
    const escaped = type.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) return type;
  }
  return null;
}

// Matches "5551 29th St #414, Greeley, CO 80634" -- a standard US address.
// Anchored to a single line (^...$/m) so it can't start mid-number inside
// an unrelated price like "$268,000" (a leftmost, unanchored search would
// happily match the "000" in that) and can't bleed into the next line.
const ADDRESS_RE = /^(\d+[\w \t.#'-]*?),[ \t]*([A-Za-z][A-Za-z \t.'-]*?),[ \t]*([A-Z]{2})[ \t]+(\d{5})(?:-\d{4})?$/m;

function findAddress(text) {
  const m = text.match(ADDRESS_RE);
  if (!m) return null;
  return { address: m[1].trim(), city: m[2].trim(), state: expandState(m[3]), zip_code: m[4] };
}

// Zillow's individual listing page keeps the *entire* search-results list
// you came from -- other properties' prices, addresses, beds/baths, agent
// names -- mounted in the page's text, followed by a large city/SEO links
// section and a blob of map price-pin labels, all of it BEFORE the actual
// subject property's own panel even starts. A plain "first match anywhere
// on the page" scan reliably grabs a neighboring listing's data instead of
// the one actually open. The real panel always starts right after a
// literal "Back to search" link (the "< Back to search" control visible
// at the top of the page) -- anchoring every text-based field extraction
// to begin there is what actually fixes this, rather than trying to guess
// a safe window size or exclude specific unrelated sections by name.
const DETAIL_PANEL_START_MARKERS = ["Back to search"];

function primaryContentText(text) {
  for (const marker of DETAIL_PANEL_START_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1) return text.slice(idx + marker.length);
  }
  return text;
}

function findBedsBaths(text) {
  const beds = text.match(/(\d+(?:\.\d+)?)\s*(?:beds?|bd)\b/i);
  const baths = text.match(/(\d+(?:\.\d+)?)\s*(?:baths?|ba)\b/i);
  const sqft = text.match(/([\d,]{3,})\s*(?:sq\s*\.?\s*ft|sqft)\b/i);
  return {
    beds: beds ? parseFloat(beds[1]) : null,
    baths: baths ? parseFloat(baths[1]) : null,
    sqft: sqft ? parseInt(sqft[1].replace(/,/g, ""), 10) : null,
  };
}

const AGENT_NAME_DENYLIST = ["the office", "listing office", "the team", "the agent", "our team", "redfin"];

// Some pages have multiple "Listed by"-style blocks (sponsored widgets,
// nearby listings). Prefer whichever match actually carries a phone number
// -- that's reliably the real listing-agent disclosure, not a placeholder.
function findListedBy(text) {
  const re = /(?:Listed by|Listing agent|Presented by|Courtesy of|Listing provided by)[:\s]+([A-Za-z.'-]+(?:[ \t]+[A-Za-z.'-]+){0,3})[ \t]*(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})?/gi;
  let best = null;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = (match[1] || "").trim();
    const phone = (match[2] || "").trim();
    if (AGENT_NAME_DENYLIST.includes(name.toLowerCase())) continue;
    if (phone) return { name, phone }; // a phone-bearing match wins immediately
    if (!best) best = { name, phone };
  }
  return best;
}

// Redfin's phone/email specifically marked "(agent)" (as opposed to
// "(broker)", or Redfin's own unrelated "Ask a question" number
// elsewhere on the page) is reliably preceded by exactly two lines:
// the agent's personal name, then their brokerage, e.g.:
//   Sean Lohbeck
//   Redfin Corporation
//   513-252-2574 (agent)
//   sean.lohbeck@redfin.com (agent)
// Some listings instead show the name inline on the "Listed by" line
// itself, with the brokerage on its own line right after:
//   Listed by Sue Wahl
//   • Comey & Shepherd
//   •513-543-7836 (agent)
//   •twosues@comey.com (agent)
// Looking at the two lines immediately above the "(agent)" phone --
// stripping a leading "Listed by"/bullet if present -- handles both
// shapes with the same logic, since either way the second line back is
// the name.
function findRedfinAgent(text) {
  const phoneMatch = text.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\s*\(agent\)/i);
  const emailMatch = text.match(/([\w.+-]+@[\w-]+\.[\w.-]+)\s*\(agent\)/i);
  const phone = phoneMatch ? phoneMatch[1].trim() : null;
  const email = emailMatch ? emailMatch[1].trim() : null;

  let name = null;
  if (phoneMatch) {
    const lineStart = text.lastIndexOf("\n", phoneMatch.index - 1);
    const before = lineStart === -1 ? "" : text.slice(0, lineStart);
    const lines = before.split("\n").map((l) => l.trim()).filter(Boolean);
    const candidate = lines.length >= 2 ? lines[lines.length - 2] : null;
    if (candidate) {
      const cleaned = candidate.replace(/^[•\s]*(?:Listed by[:\s]+)?/i, "").trim();
      if (cleaned && /^[A-Za-z]/.test(cleaned) && !AGENT_NAME_DENYLIST.includes(cleaned.toLowerCase())) {
        name = cleaned;
      }
    }
  }

  if (!name) {
    // No "(agent)"-labeled phone found at all -- fall back to a plain
    // "Listed by Name" text match.
    const m = text.match(/Listed by[:\s]+([^\n•]+)/i);
    if (m) {
      const rawName = m[1].trim();
      if (!AGENT_NAME_DENYLIST.includes(rawName.toLowerCase())) name = rawName;
    }
  }

  if (!name && !phone && !email) return null;
  return { name, phone, email };
}

function findAnyPrice(text) {
  const m = text.match(/\$[\d,]{4,}/);
  return m ? parsePriceInput(m[0]) : null;
}

function findAnyPhone(text) {
  const m = text.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
  return m ? m[0] : null;
}

// A JSON-LD entity with these @type values represents the listing agent,
// their brokerage, or page/navigation metadata -- not the property itself.
// Zillow/Realtor pages commonly embed one of these alongside the actual
// listing schema, each with its own "address" (the office's, not the
// home's) -- without this filter, whichever one happens to appear first
// in the page's HTML wins by accident.
const NON_LISTING_JSONLD_TYPES = new Set([
  "organization", "realestateagent", "localbusiness", "person",
  "breadcrumblist", "website", "webpage",
]);

// The opposite problem from NON_LISTING_JSONLD_TYPES: for new-construction
// and condo/apartment listings, Zillow also embeds a "community"/"place"
// entity (the development as a whole, e.g. for its own "About this
// community" section) with ITS OWN address -- the sales office or
// development's address, not the specific unit's. That entity isn't
// reliably typed as Organization/LocalBusiness so the denylist above
// won't catch it. Instead of trying to enumerate every possible
// community-ish @type, prefer whichever candidates ARE clearly typed as a
// single sellable unit when any exist, and only fall back to the full
// (denylist-filtered) pool otherwise.
const RESIDENCE_JSONLD_TYPES = new Set([
  "singlefamilyresidence", "apartment", "house", "condominium", "residence",
  "product", "realestatelisting", "townhouse", "accommodation",
]);

function jsonLdPathname(url, pageUrl) {
  try {
    return new URL(url, pageUrl).pathname.replace(/\/$/, "");
  } catch (e) {
    return null;
  }
}

// Collects every JSON-LD item that could plausibly be "the listing",
// filtering out agent/brokerage/navigation entities, then -- since a page
// can legitimately embed more than one real listing (nearby homes,
// similar listings carousels) -- prefers whichever candidate's own `url`
// field matches the page's own URL. Falls back to the first remaining
// candidate if none match (some pages omit `url` on the listing entity).
function listingJsonLdCandidates(jsonLdList, pageUrl) {
  const candidates = [];
  for (const parsed of jsonLdList || []) {
    const items = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const types = [].concat(item["@type"] || []).map((t) => String(t).toLowerCase());
      if (types.some((t) => NON_LISTING_JSONLD_TYPES.has(t))) continue;
      candidates.push(item);
    }
  }
  if (!candidates.length) return candidates;

  const residenceOnly = candidates.filter((item) => {
    const types = [].concat(item["@type"] || []).map((t) => String(t).toLowerCase());
    return types.some((t) => RESIDENCE_JSONLD_TYPES.has(t));
  });
  const pool = residenceOnly.length ? residenceOnly : candidates;

  const pagePath = jsonLdPathname(pageUrl, pageUrl);
  const matched = pagePath && pool.filter((item) => item.url && jsonLdPathname(item.url, pageUrl) === pagePath);
  return (matched && matched.length) ? matched : pool;
}

function jsonLdAddress(jsonLdList, pageUrl) {
  for (const item of listingJsonLdCandidates(jsonLdList, pageUrl)) {
    const addr = item.address;
    if (addr && typeof addr === "object" && addr.streetAddress) {
      return {
        address: addr.streetAddress,
        city: addr.addressLocality || null,
        state: expandState(addr.addressRegion) || null,
        zip_code: addr.postalCode || null,
      };
    }
  }
  return null;
}

function jsonLdPrice(jsonLdList, pageUrl) {
  for (const item of listingJsonLdCandidates(jsonLdList, pageUrl)) {
    const offers = item.offers;
    if (offers) {
      const offer = Array.isArray(offers) ? offers[0] : offers;
      if (offer && offer.price != null) return parsePriceInput(offer.price);
    }
    if (item.price != null) return parsePriceInput(item.price);
  }
  return null;
}

// ---- per-site parsers ----
// Zillow, Realtor.com, Redfin, and Homes.com are all structurally similar
// for-sale listings with an agent contact block, so they share one parser
// (parseForSaleSite) and differ only in their URL-address-parsing logic.

function parseForSaleSite(raw, source) {
  // Restrict to the subject property's own panel (see
  // DETAIL_PANEL_START_MARKERS above) before running ANY text-based
  // extraction -- address, price, beds/baths, agent info are all
  // otherwise vulnerable to matching a different, nearby listing still
  // sitting in the page's text.
  const text = primaryContentText(raw.bodyText || "");
  // The listing URL itself is the most reliable address source there is --
  // Zillow/Realtor.com encode the full address directly in the URL slug,
  // which is completely immune to whatever the page's DOM/text contains.
  // Page text and JSON-LD are only fallbacks for a URL shape this parser
  // doesn't recognize.
  const urlAddr = addressFromListingUrl(raw.url, source);
  const textAddr = findAddress(text);
  const jsonAddr = jsonLdAddress(raw.jsonLd, raw.url);
  const bb = findBedsBaths(text);
  // Redfin's "Listed by <Brokerage>" / name-on-next-line layout needs its
  // own pattern (see findRedfinAgent) -- fall back to the generic
  // single-line pattern if that doesn't match (e.g. a syndicated MLS
  // listing formatted differently than Redfin's own).
  const listedBy = (source === "redfin" && findRedfinAgent(text)) || findListedBy(text);

  return {
    source,
    listing_url: raw.url,
    address: (urlAddr && urlAddr.address) || (textAddr && textAddr.address) || (jsonAddr && jsonAddr.address) || raw.ogTitle || raw.title || null,
    city: (urlAddr && urlAddr.city) || (textAddr && textAddr.city) || (jsonAddr && jsonAddr.city) || null,
    state: (urlAddr && urlAddr.state) || (textAddr && textAddr.state) || (jsonAddr && jsonAddr.state) || null,
    zip_code: (urlAddr && urlAddr.zip_code) || (textAddr && textAddr.zip_code) || (jsonAddr && jsonAddr.zip_code) || null,
    price: jsonLdPrice(raw.jsonLd, raw.url) || findAnyPrice(text),
    beds: bb.beds,
    baths: bb.baths,
    sqft: bb.sqft,
    property_type: findPropertyType(text),
    agent_name: (listedBy && listedBy.name) || null,
    // A phone/email specifically attributed to the agent (listedBy) beats
    // a generic "first tel:/mailto: link anywhere on the page" grab --
    // Redfin in particular always shows its own "Ask a question" contact
    // number prominently, which is Redfin's, not the listing agent's, and
    // would otherwise win just by being first in the DOM.
    agent_phone: (listedBy && listedBy.phone) || (raw.telLinks && raw.telLinks[0]) || findAnyPhone(text),
    agent_email: (listedBy && listedBy.email) || (raw.mailLinks && raw.mailLinks[0]) || null,
  };
}

function parseZillow(raw) { return parseForSaleSite(raw, "zillow"); }
function parseRealtor(raw) { return parseForSaleSite(raw, "realtor"); }
function parseRedfin(raw) { return parseForSaleSite(raw, "redfin"); }
function parseHomes(raw) { return parseForSaleSite(raw, "homes"); }

const PARSERS = {
  zillow: parseZillow, realtor: parseRealtor, redfin: parseRedfin, homes: parseHomes,
};

const SITE_NOTES = {
  zillow: "Parses the visible address, beds/baths/sqft, and “Listed by” agent info.",
  realtor: "Parses the visible address, beds/baths/sqft, and listing-agent info.",
  redfin: "Address parsed from the listing URL (verified). Agent name reads Redfin's “Listed by … / Name” layout specifically.",
  homes: "Address/city/state parsed from the listing URL. Homes.com doesn't encode zip in the URL, so that field falls back to the page text — double-check it before saving.",
};

if (typeof module !== "undefined") {
  module.exports = {
    STATE_ABBR, expandState, formatPrice, parsePriceInput, findPropertyType,
    findAddress, findBedsBaths, findListedBy, findRedfinAgent, findAnyPrice, findAnyPhone,
    jsonLdAddress, jsonLdPrice, addressFromZillowUrl, addressFromRealtorUrl,
    addressFromRedfinUrl, addressFromHomesUrl, addressFromListingUrl,
    parseZillow, parseRealtor, parseRedfin, parseHomes,
    PARSERS, SITE_NOTES,
  };
}
