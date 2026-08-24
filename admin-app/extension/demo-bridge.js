"use strict";

/**
 * Runs ONLY on the specific Estly demo Artifact page (see manifest.json
 * content_scripts matches) -- a bridge so leads saved in the extension
 * show up live on that one demo page, since it's a self-contained page
 * (localStorage-backed sample data) rather than a real backend the
 * extension can just POST to.
 *
 * This is NOT how the extension is meant to work in general -- it's a
 * one-off bridge tied to one specific demo URL, kept entirely separate
 * from the real save path (POST to the Flask backend), which still runs
 * unconditionally alongside this.
 *
 * Mirrors the dedup/upsert logic in the demo page's own inline script
 * (normalizeAddress/computeDedupKey/upsertLead) so a lead saved here
 * merges into an existing one instead of creating a duplicate, exactly
 * like the demo page's own "Generate Sample Leads"/"Run Now" buttons do.
 */

const STORAGE_KEY = "estly-leads-preview-v1";

const ABBREVIATIONS = {
  street: "st", avenue: "ave", boulevard: "blvd", drive: "dr", lane: "ln",
  road: "rd", court: "ct", circle: "cir", place: "pl", terrace: "ter",
  parkway: "pkwy", highway: "hwy", apartment: "apt", suite: "ste",
  north: "n", south: "s", east: "e", west: "w",
};

function normalizeAddress(address) {
  if (!address) return "";
  const text = address.toLowerCase().trim().replace(/[.,#]/g, " ").replace(/\s+/g, " ");
  return text.split(" ").map((w) => ABBREVIATIONS[w] || w).join(" ").trim();
}

function computeDedupKey(address, zipCode) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  return normalized + "|" + (zipCode || "").trim();
}

function upsertIntoStorage(row) {
  let demoState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    demoState = raw ? JSON.parse(raw) : {};
  } catch (e) {
    demoState = {};
  }
  demoState.leads = demoState.leads || [];
  demoState.nextId = demoState.nextId || 1;
  demoState.ingestHistory = demoState.ingestHistory || [];

  const dedupKey = computeDedupKey(row.address, row.zip_code);
  const existing = dedupKey ? demoState.leads.find((l) => l.dedup_key === dedupKey) : null;

  let created;
  if (existing) {
    ["price", "beds", "baths", "sqft", "property_type", "listing_url",
      "agent_name", "agent_email", "agent_phone"].forEach((f) => {
      if (row[f] !== undefined && row[f] !== null) existing[f] = row[f];
    });
    if (!existing.sources) existing.sources = [existing.source || "manual"];
    if (existing.sources.indexOf(row.source) === -1) existing.sources.push(row.source);
    existing.times_seen = (existing.times_seen || 1) + 1;
    existing.last_seen_at = Date.now();
    created = false;
  } else {
    demoState.leads.push({
      id: demoState.nextId++,
      dedup_key: dedupKey,
      source: row.source || "manual",
      sources: [row.source || "manual"],
      external_id: row.external_id || null,
      listing_url: row.listing_url || null,
      address: row.address,
      city: row.city || null,
      state: row.state || null,
      zip_code: row.zip_code || null,
      price: row.price != null ? row.price : null,
      beds: row.beds != null ? row.beds : null,
      baths: row.baths != null ? row.baths : null,
      sqft: row.sqft != null ? row.sqft : null,
      property_type: row.property_type || null,
      agent_name: row.agent_name || null,
      agent_email: row.agent_email || null,
      agent_phone: row.agent_phone || null,
      status: "new",
      notes: "",
      times_seen: 1,
      last_seen_at: Date.now(),
      created_at: Date.now(),
    });
    created = true;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(demoState));
  return created;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "ESTLY_DEMO_SAVE_LEAD") {
    try {
      const created = upsertIntoStorage(message.lead);
      window.dispatchEvent(new CustomEvent("estly-external-lead"));
      sendResponse({ ok: true, created });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  }
  return false; // synchronous response, no async sendResponse needed
});
