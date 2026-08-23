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

## Lead sources

There's no free/public API for Zillow, Realtor.com, or Airbnb listings, and
scraping those sites directly breaks their Terms of Service and gets
IP-blocked quickly. Two real ingestion paths exist today:

1. **CSV import** — bulk-load leads from any export (a licensed MLS/IDX
   feed, ATTOM Data, a spreadsheet of manually-researched agents, etc.).
   Columns: `address` (required), `city`, `state`, `zip_code`, `price`,
   `beds`, `baths`, `sqft`, `property_type`, `listing_url`, `agent_name`,
   `agent_email`, `agent_phone`, `source`.
2. **Manual entry** — add a lead one at a time from the dashboard.

`backend/services/importers/` is where a real, licensed data source gets
wired in later (as a new module implementing the same `run()` interface
used by `sample_importer.py` and `csv_importer.py`) — no changes needed
elsewhere in the app when that happens.

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
