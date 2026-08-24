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
details into a form by hand.

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
4. The **Zillow / Realtor.com / Airbnb** tab at the top is picked
   automatically from the site you were on. If it guessed wrong, click a
   different tab -- it re-parses the same captured page instantly with the
   other site's rules, no new page read needed.
5. **Review and correct the fields** -- detection is best-effort and
   varies by listing; nothing is saved until you click Save.
6. Click **Save to Estly**. If the same address already exists, it merges
   into that lead instead of creating a duplicate (same dedup logic as
   CSV import and the ingestion pipeline).

The panel stays open as you browse. To capture a different listing, open
it and click the toolbar icon again -- the panel updates in place with the
new page's data. Simply navigating in the same tab doesn't trigger a new
capture on its own; the icon click is what grants the one-time page read,
by design.

## How it reads a page

`background.js` gathers raw material once per icon click -- the page's
visible text, any `schema.org` JSON-LD blocks, and `tel:`/`mailto:` links
-- and hands it to the side panel. `parsers.js` then interprets that raw
material per site (this is what the tabs select between):

- **Zillow / Realtor.com** (structurally similar "for-sale" listings):
  - Address/city/state/zip from JSON-LD if present, otherwise a regex for
    the standard `123 Main St, City, ST 12345` line in the visible text
  - Price from JSON-LD, else the first `$X,XXX+` amount on the page
  - Beds/baths/sqft from the "N beds / N baths / N,NNN sqft" text
  - Property type matched against a known vocabulary (Condominium, Single
    Family, Townhouse, etc.) found in the page text
  - Agent name + phone from a `tel:` link, or a "Listed by: Name
    555-123-4567" style text pattern (preferring whichever match actually
    carries a phone number, since some pages have more than one
    "Listed by"-shaped block and only the real one has a number attached)
- **Airbnb** (structurally different -- no reliable street address, since
  Airbnb hides it until booking, and no listing agent, just a host):
  - City/state only (no street address in almost all cases -- this is
    Airbnb's own privacy design, not a detection gap)
  - Price from the nightly rate ("$142/night"), not a sale price
  - Host name from "Hosted by Name"

State abbreviations are expanded to full names (`CO` → `Colorado`), and
price is always displayed/saved formatted with a `$` and thousands
separators.

## Settings

Click "Settings" in the side panel (or right-click the extension icon →
Options) to change the backend API URL if it's not running on
`http://localhost:5050`.

## Limitations

- Field detection quality depends entirely on what the page's markup and
  visible text happen to contain -- some listings will need manual
  correction of most fields.
- No listing-photo capture yet (the API supports it; the panel form
  doesn't expose it yet).
- Only pulls what's visible on the page you click on -- it can't discover
  listings you haven't opened, and it isn't meant to.
