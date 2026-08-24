# Estly Admin — Lead Pipeline

Admin app for the Estly real estate video-generation product. This piece
handles lead generation: pulling in property listings + agent contacts and
tracking outreach status. The consumer app (video generation) is being
built separately and will merge with this later.

## Structure

```
admin-app/
  backend/    Flask + SQLite API
  frontend/   Vite + React + TypeScript dashboard
  extension/  Chrome extension for manually clipping a listing you're viewing
```

## Running locally

**Backend** (http://localhost:5050):
```
cd admin-app/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

**Frontend** (http://localhost:5173, proxies `/api` to the backend):
```
cd admin-app/frontend
npm install
npm run dev
```

Open http://localhost:5173. Click **Generate Sample Leads** to populate the
dashboard with demo data, or **Import CSV** to bulk-load real leads.

## Lead sources & auto-ingestion

There's no free/public API for Zillow, Realtor.com, or Airbnb listings, and
scraping those sites directly breaks their Terms of Service and gets
IP-blocked quickly, so this app doesn't do that. Instead there's a proper
ingestion pipeline (`backend/services/ingestion.py`) that runs
**automatically in the background every 15 minutes** (`INGEST_INTERVAL_MINUTES`
env var to change it) and pulls from every registered feed in
`backend/services/feeds/`:

- `sample_feed.py` — a working demo feed (fake listings) so the pipeline,
  scheduler, and dedup logic all have something to run against today.
- `zillow_feed.py`, `realtor_feed.py`, `airbnb_feed.py` — stubs that raise
  a clear error instead of scraping, each documenting the legitimate
  replacement (Bridge Interactive for Zillow's official MLS/IDX partner
  feed, your MLS's IDX/RESO Web API for Realtor.com-equivalent data, ATTOM
  Data/RentCast as licensed aggregators, Airbnb's own Hosting/Partner API
  for listings you manage). Wiring in a real source means implementing
  `fetch()` in one of these modules — nothing else changes.

Two manual ingestion paths also exist, useful before a licensed feed is
in place: **CSV import** (columns: `address` required, plus `city`,
`state`, `zip_code`, `price`, `beds`, `baths`, `sqft`, `property_type`,
`listing_url`, `agent_name`, `agent_email`, `agent_phone`, `source`) and
**manual entry** from the dashboard.

### No duplicates

Every ingestion path (feeds, CSV, manual entry) runs through
`services/ingestion.py::upsert_lead`, which computes a dedup key from the
listing's normalized address + zip (`services/dedup.py`) and matches
against existing leads *regardless of source*. A listing seen again --
whether re-reported by the same feed or reported by a *different* one --
updates the existing Lead (bumping `times_seen`/`last_seen_at`, merging
its `sources` list) instead of creating a second row. The dashboard's
Auto-Ingestion panel shows per-feed results (fetched/new/merged) and a
"Run Now" button for an on-demand pass.

### Manual capture (Chrome extension)

`extension/` is a click-to-capture browser extension: open a listing page
yourself, click the extension icon, review the auto-filled fields (parsed
from the page's own schema.org/Open Graph markup), and save straight into
the same `/api/leads` endpoint -- same dedup, no duplicates. It only acts
when you click it; see `extension/README.md` for install steps and why
this is manual rather than automatic.

## Deploying

`render.yaml` (repo root) + `admin-app/Dockerfile` deploy this as one
service on [Render](https://render.com)'s free tier: the Dockerfile builds
the React frontend, then bundles it into the Flask backend image, which
serves both the API and the built dashboard from a single origin (no
separate frontend deployment, no cross-origin API URL to configure).

**To deploy:**
1. Push this repo to GitHub (already done if you're reading this from the PR).
2. On Render: **New → Blueprint**, connect the repo. Render finds
   `render.yaml` automatically.
3. When prompted, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` to whatever
   login you want protecting the deployment (see below) -- pick your own,
   these aren't in the repo.
4. Click **Apply**. First deploy takes a few minutes (building both the
   frontend and the Docker image).

Once deployed, point the extension's Settings (API URL + the same
username/password) and your browser at the resulting `*.onrender.com`
URL instead of `localhost`.

**Free tier caveats:** no persistent disk, so the SQLite database resets
on every redeploy/restart -- fine for trying this out, not for data you
need to keep. The service also spins down after 15 min idle and takes
~30s to wake back up on the next request. For durable data, either
upgrade to a paid plan with a persistent disk, or swap SQLite for a
hosted Postgres (Render has a free tier for that too -- would need
`DATABASE_URL` wired into `config.py`, not done yet).

### Keeping it actually private

A deployed URL is still just a URL -- reachable by anyone who has it
unless something gates it. Setting `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`
(see `backend/auth.py`) puts the *entire* deployment -- API and dashboard
alike -- behind an HTTP login prompt; nothing responds without it. This is
opt-in: unset locally, so local dev is completely unaffected. Don't skip
setting these on a real deployment -- lead data (names, emails, phone
numbers) has no other protection once it's reachable from the internet.

## Outreach automation

Not implemented yet. `backend/services/outreach.py` is the single seam to
fill in once a provider is chosen (SendGrid/Postmark for email, Twilio for
SMS). The dashboard already has a "Send Outreach" button and hits
`POST /api/leads/:id/outreach`; today it just returns a 501 explaining
what's missing.

## API summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leads` | List leads, filter by `status`, `source`, `min_price`, `max_price`, `search` |
| GET | `/api/leads/stats` | Counts by status/source |
| POST | `/api/leads` | Create a lead |
| PATCH | `/api/leads/<id>` | Update a lead (status, notes, fields) |
| DELETE | `/api/leads/<id>` | Delete a lead |
| POST | `/api/leads/import/sample` | Generate demo leads (`{"count": 10}`) |
| POST | `/api/leads/import/csv` | Bulk import (`multipart/form-data`, field `file`) |
| POST | `/api/leads/<id>/outreach` | Trigger outreach (not yet implemented, returns 501) |
| POST | `/api/ingest/run` | Run the ingestion pipeline across all feeds now |
| GET | `/api/ingest/status` | Feed list + last run + recent run history |
