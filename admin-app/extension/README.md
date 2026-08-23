# Estly Lead Clipper (Chrome extension)

A manual capture tool: click the extension icon while viewing a listing
page, review the auto-filled fields, and save it straight into your Estly
lead pipeline. It does nothing until you click it -- no background
scraping, no scheduled requests, no activity on any page you haven't
explicitly opened the popup on.

## Why manual, not automatic

Zillow, Realtor.com, and Airbnb don't offer a public listings API, and
their Terms of Service prohibit automated/bulk extraction. This tool
doesn't try to route around that: it only reads the one page you're
looking at, only when you click it, the same as if you'd copied the
details into a form by hand. It works on any listing site generically
(not hardcoded to those three) since it relies on standard schema.org/Open
Graph markup rather than site-specific scraping logic.

## Install (unpacked, for local dev)

1. Open `chrome://extensions` (or the equivalent in Edge/Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension for easy access (puzzle-piece icon → pin).

## Use

1. Make sure the Estly admin backend is running (`admin-app/backend`, see
   the main README) -- defaults to `http://localhost:5050`.
2. Open a listing page in your browser.
3. Click the extension icon. It auto-fills what it can find on the page
   (address, price, beds/baths, etc.) via the page's own structured data
   (schema.org JSON-LD, then Open Graph tags, then a crude price-in-text
   fallback).
4. **Review and correct the fields** -- detection is best-effort and
   varies by site; nothing is saved until you click Save.
5. Click **Save to Estly**. If the same address already exists, it merges
   into that lead instead of creating a duplicate (same dedup logic as
   CSV import and the ingestion pipeline).

## Settings

Click "Settings" in the popup (or right-click the extension icon →
Options) to change the backend API URL if it's not running on
`http://localhost:5050`.

## Limitations

- Field detection quality depends entirely on what structured data the
  page happens to include -- some sites/listings will need manual
  correction of most fields.
- No sqft or listing-photo capture yet (the API supports both; the popup
  form just doesn't expose them yet).
- Only pulls what's visible on the current page -- it can't discover
  listings you haven't opened, and it isn't meant to.
