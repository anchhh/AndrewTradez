# Estly Lead Clipper (Chrome extension)

A manual capture tool that lives in Chrome's side panel (docked to the
right of the window, like a persistent sidebar rather than a popup that
closes when you click away). Click the toolbar icon while viewing a
listing page, review the auto-filled fields, and save straight into your
Estly lead pipeline.

## Why manual (mostly), not automatic

Zillow, Realtor.com, and Airbnb don't offer a public listings API, and
their Terms of Service prohibit automated/bulk extraction. This tool
doesn't try to route around that: it only reads pages you're actually
browsing yourself, the same as if you'd copied the details into a form by
hand -- it never fetches or navigates anywhere on its own.

One nuance worth being upfront about: the panel auto-updates as you click
from one listing to the next *in the same tab*, without you re-clicking
the toolbar icon each time (see "Auto-updating between listings" below).
That's a genuine, small increase in standing access compared to a purely
click-gated design -- a lightweight script runs on pages you visit to
notice when the URL changes, so it knows to re-read. It still only reads
the page's own visible text/markup, still never sends anything anywhere
except when you click Save, and still only fills the panel -- nothing is
saved to Estly without you reviewing and clicking Save yourself.

## Install (unpacked, for local dev)

1. Open `chrome://extensions` (or the equivalent in Edge/Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension for easy access (puzzle-piece icon → pin).

**Updating an already-loaded copy:** click the reload icon (⟳) on the
extension's card in `chrome://extensions`, *then also refresh any listing
tabs you already had open*. Chrome only attaches a new/changed content
script (the auto-update watcher) to pages loaded *after* the reload --
reloading the extension alone doesn't retroactively inject it into tabs
that were already sitting open, so auto-update won't work there until you
refresh them too.

## Use

1. By default the extension talks to the deployed Estly site
   (`https://estly-admin.onrender.com`). If you're running the backend
   locally instead, change the URLs in Settings to `http://localhost:5050`.
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

The panel stays open as you browse.

## Auto-updating between listings

Once the panel is open, it keeps itself in sync with whatever tab you're
actually looking at, without re-clicking the toolbar icon:

- **Navigating within the same tab** (clicking a different listing card,
  even when the site swaps content without a full page reload) --
  `watcher.js`, a small content script running on the page, notices the
  URL change and re-reads it.
- **Switching to a different already-open tab** -- `background.js` asks
  that tab to push a fresh read the moment it becomes focused, since
  nothing about its URL changed just from switching to it.
- **A tab finishing a full page load while it's the focused one** --
  same mechanism, covers ordinary (non-SPA) navigations too.

The toolbar icon still works the same as before too -- useful for forcing
an immediate capture, or for a tab that was already open before the
extension loaded (a content script only attaches to pages loaded *after*
it's active, not retroactively -- see "Updating an already-loaded copy"
above).

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
Options) to change the backend API URL and Lead Pipeline dashboard URL --
both default to the deployed site (`https://estly-admin.onrender.com`).
Point them at `http://localhost:5050` instead if you're running the
backend locally.

The deployed site requires a login (`BASIC_AUTH_USER`/`BASIC_AUTH_PASS`,
see `admin-app/README.md` → Deploying) -- enter the same username/password
in Settings too, otherwise every request gets a 401.

The panel header shows a live **Backend connected / Backend unreachable**
indicator -- if Save isn't working, check this first. Unreachable
usually means the backend (`admin-app/backend`) isn't running, or the API
URL in Settings doesn't match where it's actually running.

## Open Pipeline

The "Open Pipeline" button in the panel footer opens the Estly admin
dashboard (`admin-app/frontend`) in a new tab. Saving a lead here and
viewing it there are already the same thing under the hood -- both talk
to the same backend/database -- this button just gives you a direct way
to jump over and see it.

## Limitations

- Field detection quality depends entirely on what the page's markup and
  visible text happen to contain -- some listings will need manual
  correction of most fields.
- No listing-photo capture yet (the API supports it; the panel form
  doesn't expose it yet).
- Only pulls what's visible on the page you click on -- it can't discover
  listings you haven't opened, and it isn't meant to.
