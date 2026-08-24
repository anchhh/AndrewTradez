# Estly Lead Clipper (Chrome extension)

A manual capture tool that lives in Chrome's side panel (docked to the
right of the window, like a persistent sidebar rather than a popup that
closes when you click away). Click the toolbar icon while viewing a
listing page, review the auto-filled fields, and save straight into your
Estly lead pipeline. Every capture is triggered by that click -- no
background scraping, no scheduled requests, no activity on any page you
haven't explicitly clicked the icon on.

## Why manual, not automatic

Zillow, Realtor.com, and Airbnb don't offer a public listings API, and
their Terms of Service prohibit automated/bulk extraction. This tool
doesn't try to route around that: it only reads the one page you're
looking at, only when you click the icon, the same as if you'd copied the
details into a form by hand. It works on any listing site generically
(not hardcoded to those three) since it relies on standard schema.org/Open
Graph markup and common contact-link patterns rather than site-specific
scraping logic.

## Install (unpacked, for local dev)

1. Open `chrome://extensions` (or the equivalent in Edge/Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension for easy access (puzzle-piece icon → pin).

## Use

1. Make sure the Estly admin backend is running (`admin-app/backend`, see
   the main README) -- defaults to `http://localhost:5050`.
2. Open a listing page in your browser.
3. Click the extension icon. This opens the side panel (if not already
   open) and captures the current page into it.
4. **Review and correct the fields** -- detection is best-effort and
   varies by site; nothing is saved until you click Save.
5. Click **Save to Estly**. If the same address already exists, it merges
   into that lead instead of creating a duplicate (same dedup logic as
   CSV import and the ingestion pipeline).

The panel stays open as you browse. To capture a different listing, open
it and click the toolbar icon again -- the panel updates in place with the
new page's data. Simply navigating in the same tab doesn't trigger a new
capture on its own; the icon click is what grants the one-time page read,
by design.

## What it looks for, in order

1. **schema.org JSON-LD** (`<script type="application/ld+json">`) -- most
   reliable when a site includes it: address, price, beds/baths.
2. **Open Graph meta tags** -- fallback for title/price.
3. **`tel:`/`mailto:` links** on the page -- often present for an agent's
   contact info even when nothing else is structured.
4. **"Listed by: Name 555-123-4567" style text patterns** -- catches agent
   name/phone that only appears in the visible description text, not in
   any structured field (this is the common case on Zillow-style listing
   pages).
5. A crude last-resort regex scan of the page text for a phone number or
   price if nothing else matched.

## Settings

Click "Settings" in the side panel (or right-click the extension icon →
Options) to change the backend API URL if it's not running on
`http://localhost:5050`.

## Limitations

- Field detection quality depends entirely on what the page's markup and
  visible text happen to contain -- some listings will need manual
  correction of most fields.
- No sqft or listing-photo capture yet (the API supports both; the panel
  form just doesn't expose them yet).
- Only pulls what's visible on the page you click on -- it can't discover
  listings you haven't opened, and it isn't meant to.
