"""
Shared upsert logic for bringing a raw listing row -- from a manual add,
CSV import, or the Chrome extension -- into the Lead table, collapsing
repeats (the same property re-added, or reported under a different
source) into a single row instead of creating duplicates.
"""
from datetime import datetime, timezone

from extensions import db
from models import Lead
from services.dedup import compute_dedup_key


def _utcnow():
    return datetime.now(timezone.utc)


def upsert_lead(row, owner_id=None):
    """
    Create or merge a single raw listing row (as produced by a manual add,
    the CSV importer, or the Chrome extension) into the Lead table.
    Returns True if a new Lead was created, False if an existing one
    (matched by dedup_key) was updated instead.

    Dedup is scoped to owner_id: two users clipping the same house each get
    their own lead, rather than the second capture silently merging into
    the first user's row.
    """
    row = dict(row)  # don't mutate the caller's dict
    address = row.get("address")
    zip_code = row.get("zip_code")
    source = row.get("source") or "unknown"
    external_id = row.get("external_id")
    photo_urls = row.pop("photo_urls", None)
    dedup_key = compute_dedup_key(address, zip_code)

    existing = (
        Lead.query.filter_by(dedup_key=dedup_key, owner_id=owner_id).first()
        if dedup_key
        else None
    )

    if existing:
        for field in (
            "price", "beds", "baths", "sqft", "property_type", "listing_url",
            "brokerage", "agent_name", "agent_email", "agent_phone",
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
        owner_id=owner_id,
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
        brokerage=row.get("brokerage"),
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
