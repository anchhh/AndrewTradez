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

The panel stays open as you browse.

## Auto-updating between listings

Once the panel is open, clicking from one listing to the next in the same
tab updates the panel automatically -- no need to click the toolbar icon
again. This is handled by `watcher.js`, a small content script that runs
on pages you visit and notices when the URL changes (most listing sites
give each property its own URL, even when navigating between them feels
like a single-page app with no full reload). On a change, it re-reads the
page the same way `background.js` does on a click, and the already-open
panel updates itself live.

The toolbar icon still works the same as before too -- useful for forcing
an immediate capture, or for a tab that was already open before the
extension loaded (a content script only attaches to pages loaded *after*
it's active, not retroactively).

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
Options) to change the backend API URL (default `http://localhost:5050`)
or the Lead Pipeline dashboard URL (default `http://localhost:5173`).

If your backend is deployed with `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` set
(see `admin-app/README.md` → Deploying), enter the same username/password
in Settings too -- otherwise every request gets a 401.

The panel header shows a live **Backend connected / Backend unreachable**
indicator -- if Save isn't working, check this first. Unreachable
usually means the backend (`admin-app/backend`) isn't running, or the API
URL in Settings doesn't match where it's actually running.

## Demo page bridge (temporary, not the real backend)

Every Save also tries to push the lead into a specific Claude Artifact
demo page (`demo-bridge.js`, matched to one hardcoded URL) -- a
self-contained, localStorage-backed page built to explore the dashboard
UI without running anything locally. This is a one-off bridge, not how
the extension is meant to work in general:

- It writes directly into that page's browser storage (via a content
  script scoped only to that one URL) and tells it to refresh, since a
  static demo page has no real API to POST to.
- It runs independently of the real backend save above -- both are
  attempted on every Save, and the status line reports both outcomes
  separately (e.g. "Backend: unreachable. Demo page: saved.").
- If that demo tab isn't already open, the extension opens it
  (in the background) rather than failing.
- Data saved this way lives only in that one browser's local storage for
  that one page -- it's not shared with anyone else who opens the same
  link, and it's not real lead data anywhere durable.

Once you're running the real backend + dashboard (see the main
`admin-app/README.md`), that's the actual system this extension is built
for -- this bridge is scaffolding for trying things out before that's set
up, not a replacement for it.

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
