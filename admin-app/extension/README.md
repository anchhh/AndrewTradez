# Estly Lead Clipper (Chrome extension)

A manual capture tool that lives in Chrome's side panel (docked to the
right of the window, like a persistent sidebar rather than a popup that
closes when you click away). Click the toolbar icon while viewing a
listing page, review the auto-filled fields, and save straight into your
Estly lead pipeline.

## Why manual (mostly), not automatic

Zillow, Realtor.com, Redfin, and Homes.com don't offer a public listings
API, and their Terms of Service prohibit automated/bulk extraction. This
tool doesn't try to route around that: it only reads pages you're
actually browsing yourself, the same as if you'd copied the details into
a form by hand -- it never fetches or navigates anywhere on its own.

One nuance worth being upfront about: the panel auto-updates as you click
from one listing to the next *in the same tab*, without you re-clicking
the toolbar icon each time (see "Auto-updating between listings" below).
That's a genuine, small increase in standing access compared to a purely
click-gated design -- the extension has standing permission to read pages
on zillow.com, realtor.com, redfin.com, and homes.com (declared in
`manifest.json`'s `host_permissions`) so it can notice, at the browser
level, when the tab's URL changes to a different listing and read that
page automatically. It
still only reads the page's own visible text/markup, still never sends
anything anywhere except when you click Save, and still only fills the
panel -- nothing is saved to Estly without you reviewing and clicking Save
yourself.

## Install (unpacked, for local dev)

1. Open `chrome://extensions` (or the equivalent in Edge/Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension for easy access (puzzle-piece icon → pin).

**Updating an already-loaded copy:** click the reload icon (⟳) on the
extension's card in `chrome://extensions`. Auto-update between listings is
driven entirely by `background.js`'s service worker now (no content script
involved), so a reload there takes effect immediately -- you don't need to
refresh already-open listing tabs for that part. You may still want to
refresh an open tab if you're testing a change to the on-page field
detection itself (`parsers.js`), since that only runs when a fresh capture
is triggered.

## Use

1. By default the extension talks to your local dev backend
   (`http://127.0.0.1:5051`). If you want to save straight to the deployed
   site instead, change the URLs in Settings to
   `https://estly-admin.onrender.com`.
2. Open a listing page in your browser.
3. Click the extension icon. This opens the side panel (if not already
   open) and captures the current page into it.
4. The **Zillow / Realtor.com / Redfin / Homes.com** tab at the top is
   picked automatically from the site you were on. If it guessed wrong,
   click a different tab -- it re-parses the same captured page instantly
   with the other site's rules, no new page read needed.
5. **Review and correct the fields** -- detection is best-effort and
   varies by listing; nothing is saved until you click Save.
6. Click **Save to Estly**. If the same address already exists, it merges
   into that lead instead of creating a duplicate (same dedup logic as
   CSV import and the ingestion pipeline).

The panel stays open as you browse.

## Auto-updating between listings

Once the panel is open, it keeps itself in sync with whatever tab you're
actually looking at, without re-clicking the toolbar icon. All of this is
driven by `chrome.tabs.onUpdated`/`onActivated` in `background.js` --
Chrome's own tab-tracking, not a script running inside the page:

- **Navigating within the same tab** (clicking a different listing card,
  even when the site swaps content via `history.pushState` instead of a
  full page reload) -- `tabs.onUpdated` fires with the new URL either way,
  and `background.js` re-reads the page on demand.
- **Switching to a different already-open tab** -- `tabs.onActivated`
  triggers the same on-demand read for whatever tab just became focused.
- **Navigating off a listing page** (back to search results, a map view,
  a different site entirely) -- the same check that gates a fresh read
  also clears the panel back to empty when the current tab isn't a
  listing detail page anymore.

The toolbar icon still works too -- useful for forcing an immediate
re-capture of the page you're already on.

## How it reads a page

`background.js` gathers raw material on demand -- the page's visible
text, any `schema.org` JSON-LD blocks, and `tel:`/`mailto:` links -- and
hands it to the side panel. `parsers.js` then interprets that raw
material per site (this is what the tabs select between):

- **Zillow / Realtor.com / Redfin / Homes.com** (structurally similar
  "for-sale" listings):
  - **Address/city/state/zip is parsed directly from the listing URL
    first** (`parsers.js`'s `addressFromZillowUrl` /
    `addressFromRealtorUrl` / `addressFromRedfinUrl` /
    `addressFromHomesUrl`) -- these sites encode the full address in the
    URL slug itself, which is immune to whatever the page's own DOM/text
    contains. This was a hard-won fix: Zillow's individual listing pages
    keep the *entire* search-results list you came from (other
    properties' addresses/prices/beds-baths), an SEO links section, and a
    blob of map price-pin labels all mounted in the page's text, ahead of
    the actual subject property's own content -- a plain "scan the page
    text" approach reliably grabbed a neighboring listing's data instead
    of the one actually open. Falls back to the visible page text (see
    below), then JSON-LD, if the URL doesn't match the expected shape.
  - **Zillow and Homes.com's URL parsing is verified against real pages**
    (Zillow: multiple real listings including a tricky unit-number case;
    Homes.com: one real listing, notably with no zip encoded in the URL
    at all -- that field falls back to page text there). **Realtor.com
    and Redfin's URL parsers are still best-effort guesses**, not yet
    checked against a real page -- expect to need the same kind of fix
    if they turn out wrong. `SITE_NOTES` in `parsers.js` flags this in
    the panel itself for Redfin.
  - When falling back to page text: only the subject property's own
    panel is searched, not the whole page -- on Zillow this means
    everything after the literal "Back to search" marker (see above);
    other sites may need their own equivalent marker once verified.
  - Beds/baths/sqft from the "N beds / N baths / N,NNN sqft" text
  - Property type matched against a known vocabulary (Condominium, Single
    Family, Townhouse, etc.) found in the page text
  - Agent name + phone from a `tel:` link, or a "Listed by: Name
    555-123-4567" style text pattern (preferring whichever match actually
    carries a phone number, since some pages have more than one
    "Listed by"-shaped block and only the real one has a number attached)

State abbreviations are expanded to full names (`CO` → `Colorado`).
Price is intentionally not captured or shown -- it was dropped from the
panel to keep the data handed off to the video-generation AI focused on
what it actually needs (address, photos, property facts), not sale price.

Airbnb support was removed -- this tool is scoped to for-sale listings
only for now.

## Settings

Click "Settings" in the side panel (or right-click the extension icon →
Options) to change the backend API URL and Lead Pipeline dashboard URL --
both default to your local dev backend (`http://127.0.0.1:5051`). Point
them at `https://estly-admin.onrender.com` instead if you want to save
straight to the deployed site.

The deployed site requires a login (`BASIC_AUTH_USER`/`BASIC_AUTH_PASS`,
see `admin-app/README.md` → Deploying) -- enter the same username/password
in Settings too, otherwise every request gets a 401. Leave both blank for
local dev, which has no Basic Auth configured by default.

The panel header shows a live **Backend connected / Backend unreachable**
indicator -- if Save isn't working, check this first. Unreachable
usually means the backend (`admin-app/backend`) isn't running, or the API
URL in Settings doesn't match where it's actually running.

## Open Pipeline

The "Open Pipeline" button in the panel footer opens the estly Studio
dashboard's Leads section (`/studio/dashboard`) in a new tab. Saving a
lead here and viewing it there are already the same thing under the hood
-- both talk to the same backend/database -- this button just gives you a
direct way to jump over and see it (or turn it straight into a video via
the "Create Video" link next to each lead there).

## Limitations

- Field detection quality depends entirely on what the page's markup and
  visible text happen to contain -- some listings will need manual
  correction of most fields.
- No listing-photo capture yet (the API supports it; the panel form
  doesn't expose it yet).
- Only pulls what's visible on the page you click on -- it can't discover
  listings you haven't opened, and it isn't meant to.

## Extractors and their tests

Photo extraction lives in `extractors.js`, one module per listing site. Each
declares which hosts it handles and how it picks the subject listing's photos
out of a page that also shows other homes. They are deliberately isolated:
changing how Zillow is read must not be able to affect Redfin or homes.com.

Every rule was derived by counting a real page against the photo count the
site itself prints -- not assumed. `test/fixtures.json` holds those real pages
reduced to the image URLs they contained, with the expected result for each.

**Run `test/extractors.test.html` after touching any extractor.** It needs to
be served over http:// rather than opened as a file, so the fixtures can load:

    python -m http.server 8000 --directory admin-app/extension
    # then open http://localhost:8000/test/extractors.test.html

A change to one site's rule must leave every other site's numbers untouched.
