from flask import Blueprint, jsonify, request

from extensions import db
from models import VALID_SOURCES, VALID_STATUSES, Lead
from services.dedup import compute_dedup_key
from services.importers import REGISTRY as IMPORTER_REGISTRY
from services.importers.csv_importer import CsvImportError
from services.contacts import AUTOFILL_THRESHOLD, pick_agent_email
from services.ingestion import upsert_lead

bp = Blueprint("leads", __name__, url_prefix="/api/leads")


def _owner_from_api_key():
    """Which account a captured lead belongs to.

    The X-Estly-Key header carries a per-account key when the extension has
    signed in. When it hasn't, and this install has exactly one account,
    that account is unambiguous -- so a single-user setup doesn't have to
    sign in at all. The moment a second account exists the guess stops being
    safe, the fallback switches itself off, and signing in is required
    again. Imported lazily to keep this blueprint independent of the studio
    package at import time."""
    from studio import load_users, user_id_for_api_key

    owner = user_id_for_api_key(request.headers.get("X-Estly-Key"))
    if owner:
        return owner

    users = load_users()
    return users[0]["id"] if len(users) == 1 else None


@bp.get("")
def list_leads():
    query = Lead.query

    status = request.args.get("status")
    if status:
        query = query.filter(Lead.status == status)

    source = request.args.get("source")
    if source:
        query = query.filter(Lead.source == source)

    min_price = request.args.get("min_price", type=int)
    if min_price is not None:
        query = query.filter(Lead.price >= min_price)

    max_price = request.args.get("max_price", type=int)
    if max_price is not None:
        query = query.filter(Lead.price <= max_price)

    search = request.args.get("search")
    if search:
        like = f"%{search}%"
        query = query.filter(
            db.or_(
                Lead.address.ilike(like),
                Lead.city.ilike(like),
                Lead.agent_name.ilike(like),
                Lead.agent_email.ilike(like),
            )
        )

    leads = query.order_by(Lead.created_at.desc()).all()
    return jsonify([lead.to_dict() for lead in leads])


@bp.get("/stats")
def stats():
    total = Lead.query.count()
    by_status = {
        status: Lead.query.filter(Lead.status == status).count()
        for status in VALID_STATUSES
    }
    by_source = {
        source: Lead.query.filter(Lead.source == source).count()
        for source in VALID_SOURCES
    }
    return jsonify({"total": total, "by_status": by_status, "by_source": by_source})


@bp.post("")
def create_lead():
    data = request.get_json(force=True, silent=True) or {}

    address = (data.get("address") or "").strip()
    if not address:
        return jsonify({"error": "address is required"}), 400

    status = data.get("status", "new")
    if status not in VALID_STATUSES:
        return jsonify({"error": f"status must be one of {VALID_STATUSES}"}), 400

    owner_id = _owner_from_api_key()
    if not owner_id:
        return jsonify({
            "error": "Missing or unrecognised extension key. Open estly Studio "
                     "> Lead Manager, copy your extension key, and paste it into "
                     "the extension's Settings."
        }), 401

    row = {
        "source": data.get("source", "manual"),
        "listing_url": data.get("listing_url"),
        "address": address,
        "city": data.get("city"),
        "state": data.get("state"),
        "zip_code": data.get("zip_code"),
        "price": data.get("price"),
        "beds": data.get("beds"),
        "baths": data.get("baths"),
        "sqft": data.get("sqft"),
        "property_type": data.get("property_type"),
        "brokerage": data.get("brokerage"),
        "agent_name": data.get("agent_name"),
        "agent_email": data.get("agent_email"),
        "agent_phone": data.get("agent_phone"),
        "status": status,
        "notes": data.get("notes"),
        "photo_urls": data.get("photo_urls", []),
    }

    # The extension can send the listing's photos inline as data: URLs,
    # having read them in the page. That's the only way to get photos from
    # sites whose CDN refuses this server (homes.com returns 403 for both
    # their HTML and their images), and it avoids a second round trip to
    # re-fetch what the browser already had for every other site.
    # Listing pages publish the agent's email; the extension now sends every
    # address it found. Fill it in only when one actually matches the agent
    # named on the listing -- a page also carries other agents at the same
    # brokerage and shared mailboxes. A weaker match is recorded for review
    # rather than used, because a wrong address means mailing a stranger.
    if not row.get("agent_email"):
        email, score, reason = pick_agent_email(data.get("page_emails"), row.get("agent_name"))
        if email and score >= AUTOFILL_THRESHOLD:
            row["agent_email"] = email

    inline = data.get("photos_base64")
    if inline:
        from studio import save_data_url_images

        row["photo_urls"] = save_data_url_images(inline)["photos"] or row["photo_urls"]

    created = upsert_lead(row, owner_id=owner_id)
    db.session.commit()

    dedup_key = compute_dedup_key(address, data.get("zip_code"))
    lead = Lead.query.filter_by(dedup_key=dedup_key, owner_id=owner_id).first()

    # A listing often doesn't publish the agent's email -- Zillow never does --
    # so go and look for it. On a background thread: the search opens several
    # pages and takes seconds, and a capture shouldn't wait for it. It fails
    # often by design; the outcome is recorded on the lead either way.
    if lead and not lead.agent_email and lead.agent_name:
        from flask import current_app
        from services.enrichment import enrich_lead_async

        enrich_lead_async(current_app._get_current_object(), lead.id)

    # Sort the photos into rooms while we're here. Also background: it is
    # several API calls and a capture shouldn't wait on it. Only for photos
    # not already labelled, so a re-capture of the same listing doesn't pay
    # for the same work twice.
    if lead and lead.photo_urls:
        from flask import current_app
        from services.enrichment import sort_rooms_async
        from services.rooms import is_configured as rooms_configured

        already = set(lead.photo_rooms)
        if rooms_configured() and any(u not in already for u in lead.photo_urls):
            sort_rooms_async(current_app._get_current_object(), lead.id)

    payload = lead.to_dict()
    payload["_merged"] = not created
    return jsonify(payload), 201


@bp.patch("/<int:lead_id>")
def update_lead(lead_id):
    lead = db.session.get(Lead, lead_id)
    if lead is None:
        return jsonify({"error": "lead not found"}), 404

    data = request.get_json(force=True, silent=True) or {}

    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            return jsonify({"error": f"status must be one of {VALID_STATUSES}"}), 400
        lead.status = data["status"]

    for field in (
        "address", "city", "state", "zip_code", "price", "beds", "baths",
        "sqft", "property_type", "listing_url", "agent_name", "agent_email",
        "agent_phone", "notes",
    ):
        if field in data:
            setattr(lead, field, data[field])

    if "photo_urls" in data:
        lead.photo_urls = data["photo_urls"]

    db.session.commit()
    return jsonify(lead.to_dict())


@bp.delete("/<int:lead_id>")
def delete_lead(lead_id):
    lead = db.session.get(Lead, lead_id)
    if lead is None:
        return jsonify({"error": "lead not found"}), 404
    db.session.delete(lead)
    db.session.commit()
    return "", 204


@bp.post("/import/csv")
def import_csv():
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded (expected multipart field 'file')"}), 400

    owner_id = _owner_from_api_key()
    if not owner_id:
        return jsonify({"error": "Missing or unrecognised extension key."}), 401

    try:
        rows = IMPORTER_REGISTRY["csv"].run(request.files["file"].stream)
    except CsvImportError as exc:
        return jsonify({"error": str(exc)}), 400

    created_count = 0
    updated_count = 0
    for row in rows:
        if upsert_lead(row, owner_id=owner_id):
            created_count += 1
        else:
            updated_count += 1
    db.session.commit()
    return jsonify({
        "imported": len(rows),
        "created": created_count,
        "updated": updated_count,
    }), 201


@bp.post("/<int:lead_id>/outreach")
def trigger_outreach(lead_id):
    """Deliberately does not send.

    Outreach goes out from the Studio review queue instead, where the address
    is shown with how much it can be trusted and a person clicks send. This
    blueprint sits behind Basic Auth with no per-account scoping, so wiring
    sending in here would be a second path that mails agents with nobody
    checking -- which is exactly what the review step exists to prevent.
    Kept so the admin UI gets a useful answer rather than a 404.
    """
    from services import outreach

    lead = db.session.get(Lead, lead_id)
    if lead is None:
        return jsonify({"error": "lead not found"}), 404

    return jsonify({
        "error": "Outreach is sent from the Studio review queue, not from here.",
        "review_at": "/studio/outreach",
        "ready": outreach.is_ready(lead),
        "blockers": outreach.blockers(lead),
    }), 501
