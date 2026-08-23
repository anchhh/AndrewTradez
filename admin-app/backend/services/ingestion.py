"""
Ingestion pipeline: pulls listings from every registered feed (see
services/feeds/) and upserts them into the Lead table, collapsing repeats
-- whether the exact same source re-reports a listing, or a *different*
source reports the same physical property -- into a single row instead of
creating duplicates. This is what "auto-pull new listings, no duplicates"
actually resolves to once you plug in a real, licensed data source.
"""
from datetime import datetime, timezone

from extensions import db
from models import IngestionRun, Lead
from services.dedup import compute_dedup_key


def _utcnow():
    return datetime.now(timezone.utc)


def upsert_lead(row):
    """
    Create or merge a single raw listing row (as produced by a feed's
    fetch(), the CSV importer, or a manual add) into the Lead table.
    Returns True if a new Lead was created, False if an existing one
    (matched by dedup_key) was updated instead.
    """
    row = dict(row)  # don't mutate the caller's dict
    address = row.get("address")
    zip_code = row.get("zip_code")
    source = row.get("source") or "unknown"
    external_id = row.get("external_id")
    photo_urls = row.pop("photo_urls", None)
    dedup_key = compute_dedup_key(address, zip_code)

    existing = Lead.query.filter_by(dedup_key=dedup_key).first() if dedup_key else None

    if existing:
        for field in (
            "price", "beds", "baths", "sqft", "property_type", "listing_url",
            "agent_name", "agent_email", "agent_phone",
        ):
            value = row.get(field)
            if value is not None:
                setattr(existing, field, value)
        if photo_urls:
            existing.photo_urls = photo_urls

        sources = existing.sources
        if source not in sources:
            sources.append(source)
        existing.sources = sources

        if external_id:
            ext_ids = existing.external_ids
            ext_ids[source] = external_id
            existing.external_ids = ext_ids

        existing.times_seen += 1
        existing.last_seen_at = _utcnow()
        db.session.add(existing)
        return False

    lead = Lead(
        source=source,
        external_id=external_id,
        listing_url=row.get("listing_url"),
        address=address,
        city=row.get("city"),
        state=row.get("state"),
        zip_code=zip_code,
        price=row.get("price"),
        beds=row.get("beds"),
        baths=row.get("baths"),
        sqft=row.get("sqft"),
        property_type=row.get("property_type"),
        agent_name=row.get("agent_name"),
        agent_email=row.get("agent_email"),
        agent_phone=row.get("agent_phone"),
        status=row.get("status", "new"),
        notes=row.get("notes"),
        dedup_key=dedup_key,
    )
    lead.photo_urls = photo_urls or []
    lead.sources = [source]
    lead.external_ids = {source: external_id} if external_id else {}
    db.session.add(lead)
    return True


def run_ingestion(feed_names=None):
    """Fetch from every registered feed (or a subset via feed_names) and
    upsert everything found. Persists a run record and returns its results
    dict: {"feeds": {name: {...}}, "totals": {...}}."""
    from services.feeds import FEEDS

    started_at = _utcnow()
    results = {
        "feeds": {},
        "totals": {"fetched": 0, "created": 0, "updated": 0, "errors": 0},
    }

    for name, feed in FEEDS.items():
        if feed_names and name not in feed_names:
            continue

        feed_result = {"status": "ok", "fetched": 0, "created": 0, "updated": 0}
        try:
            rows = feed.fetch()
        except NotImplementedError as exc:
            feed_result["status"] = "not_configured"
            feed_result["message"] = str(exc)
            results["feeds"][name] = feed_result
            continue
        except Exception as exc:  # a feed's fetch() failing shouldn't kill the run
            feed_result["status"] = "error"
            feed_result["message"] = str(exc)
            results["totals"]["errors"] += 1
            results["feeds"][name] = feed_result
            continue

        feed_result["fetched"] = len(rows)
        for row in rows:
            created = upsert_lead(row)
            feed_result["created" if created else "updated"] += 1

        results["feeds"][name] = feed_result
        results["totals"]["fetched"] += feed_result["fetched"]
        results["totals"]["created"] += feed_result["created"]
        results["totals"]["updated"] += feed_result["updated"]

    db.session.commit()

    run = IngestionRun(started_at=started_at, finished_at=_utcnow())
    run.results = results
    db.session.add(run)
    db.session.commit()

    return results
