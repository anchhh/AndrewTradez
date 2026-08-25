"""
Lead importers.

Each importer takes some input and returns a list of dicts matching the
Lead model's constructor kwargs (see models.Lead). Adding a new source
(e.g. a licensed MLS/IDX feed, or a paid listings API) means writing one
more module here with a `run(...)` function and registering it below --
the API routes and frontend don't need to change.

NOTE on Zillow / Airbnb / Realtor.com specifically: none of them offer a
public listings API, and scraping their sites directly violates their
Terms of Service and is aggressively bot-blocked. Leads from those sites
come in via the Chrome extension (manual, one listing at a time, reading
only what the user is already looking at) instead. For bulk real data,
plug in a licensed data source (MLS/IDX feed via a broker, ATTOM Data,
Realtor.com's RapidAPI reseller, or your own Airbnb host export) as a new
importer following the same interface, or use the CSV importer to
bulk-load whatever export that source gives you.
"""

from . import csv_importer

REGISTRY = {
    "csv": csv_importer,
}
