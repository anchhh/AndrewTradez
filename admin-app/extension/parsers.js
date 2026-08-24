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

const AGENT_NAME_DENYLIST = ["the office", "listing office", "the team", "the agent", "our team"];

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

function findAnyPrice(text) {
  const m = text.match(/\$[\d,]{4,}/);
  return m ? parsePriceInput(m[0]) : null;
}

// Nightly rates are small numbers ($142) that findAnyPrice's 4-digit
// minimum (there to avoid grabbing e.g. "$243/sqft" on a sale listing)
// would wrongly reject, so anchor to the word "night" instead.
function findNightlyPrice(text) {
  const m = text.match(/\$([\d,]+)\s*(?:\/)?\s*night/i);
  return m ? parsePriceInput(m[1]) : null;
}

function findAnyPhone(text) {
  const m = text.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
  return m ? m[0] : null;
}

function jsonLdAddress(jsonLdList) {
  for (const parsed of jsonLdList || []) {
    const items = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
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
  }
  return null;
}

function jsonLdPrice(jsonLdList) {
  for (const parsed of jsonLdList || []) {
    const items = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const offers = item.offers;
      if (offers) {
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (offer && offer.price != null) return parsePriceInput(offer.price);
      }
      if (item.price != null) return parsePriceInput(item.price);
    }
  }
  return null;
}

// ---- per-site parsers ----
// Zillow and Realtor.com are structurally similar (for-sale listing with
// an agent contact block); Airbnb is genuinely different -- no reliable
// street address (hidden until booking, by design), a nightly rate
// instead of a sale price, and a host instead of a listing agent.

function parseForSaleSite(raw, source) {
  const text = raw.bodyText || "";
  const jsonAddr = jsonLdAddress(raw.jsonLd);
  const textAddr = findAddress(text);
  const bb = findBedsBaths(text);
  const listedBy = findListedBy(text);

  return {
    source,
    listing_url: raw.url,
    address: (jsonAddr && jsonAddr.address) || (textAddr && textAddr.address) || raw.ogTitle || raw.title || null,
    city: (jsonAddr && jsonAddr.city) || (textAddr && textAddr.city) || null,
    state: (jsonAddr && jsonAddr.state) || (textAddr && textAddr.state) || null,
    zip_code: (jsonAddr && jsonAddr.zip_code) || (textAddr && textAddr.zip_code) || null,
    price: jsonLdPrice(raw.jsonLd) || findAnyPrice(text),
    beds: bb.beds,
    baths: bb.baths,
    sqft: bb.sqft,
    property_type: findPropertyType(text),
    agent_name: (listedBy && listedBy.name) || null,
    agent_phone: (raw.telLinks && raw.telLinks[0]) || (listedBy && listedBy.phone) || findAnyPhone(text),
    agent_email: (raw.mailLinks && raw.mailLinks[0]) || null,
  };
}

function parseZillow(raw) { return parseForSaleSite(raw, "zillow"); }
function parseRealtor(raw) { return parseForSaleSite(raw, "realtor"); }

function parseAirbnb(raw) {
  const text = raw.bodyText || "";
  const jsonAddr = jsonLdAddress(raw.jsonLd);
  const bb = findBedsBaths(text);
  const hostMatch = text.match(/Hosted by[:\s]+([A-Za-z.'-]+(?:[ \t]+[A-Za-z.'-]+){0,2})/i);

  return {
    source: "airbnb",
    listing_url: raw.url,
    // Airbnb hides the exact street address until booking, by design --
    // city/state is usually all that's available pre-booking.
    address: (jsonAddr && jsonAddr.address) || null,
    city: (jsonAddr && jsonAddr.city) || null,
    state: (jsonAddr && jsonAddr.state) || null,
    zip_code: (jsonAddr && jsonAddr.zip_code) || null,
    price: jsonLdPrice(raw.jsonLd) || findNightlyPrice(text) || findAnyPrice(text),
    beds: bb.beds,
    baths: bb.baths,
    sqft: bb.sqft,
    property_type: findPropertyType(text) || "Short-term Rental",
    agent_name: hostMatch ? hostMatch[1].trim() : null,
    agent_phone: (raw.telLinks && raw.telLinks[0]) || null,
    agent_email: (raw.mailLinks && raw.mailLinks[0]) || null,
  };
}

const PARSERS = { zillow: parseZillow, realtor: parseRealtor, airbnb: parseAirbnb };

const SITE_NOTES = {
  zillow: "Parses the visible price, address, beds/baths/sqft, and “Listed by” agent info.",
  realtor: "Parses the visible price, address, beds/baths/sqft, and listing-agent info.",
  airbnb: "Airbnb hides the exact street address until booking — city/state may be all that's available. Price is the nightly rate.",
};

if (typeof module !== "undefined") {
  module.exports = {
    STATE_ABBR, expandState, formatPrice, parsePriceInput, findPropertyType,
    findAddress, findBedsBaths, findListedBy, findAnyPrice, findAnyPhone,
    jsonLdAddress, jsonLdPrice, parseZillow, parseRealtor, parseAirbnb,
    PARSERS, SITE_NOTES,
  };
}
