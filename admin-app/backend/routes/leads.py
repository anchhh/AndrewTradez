from flask import Blueprint, jsonify, request

from extensions import db
from models import VALID_SOURCES, VALID_STATUSES, Lead
from services.importers import REGISTRY as IMPORTER_REGISTRY
from services.importers.csv_importer import CsvImportError
from services.outreach import OutreachNotConfigured, send_outreach

bp = Blueprint("leads", __name__, url_prefix="/api/leads")


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

    lead = Lead(
        source=data.get("source", "manual"),
        listing_url=data.get("listing_url"),
        address=address,
        city=data.get("city"),
        state=data.get("state"),
        zip_code=data.get("zip_code"),
        price=data.get("price"),
        beds=data.get("beds"),
        baths=data.get("baths"),
        sqft=data.get("sqft"),
        property_type=data.get("property_type"),
        agent_name=data.get("agent_name"),
        agent_email=data.get("agent_email"),
        agent_phone=data.get("agent_phone"),
        status=status,
        notes=data.get("notes"),
    )
    lead.photo_urls = data.get("photo_urls", [])

    db.session.add(lead)
    db.session.commit()
    return jsonify(lead.to_dict()), 201


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


@bp.post("/import/sample")
def import_sample():
    data = request.get_json(force=True, silent=True) or {}
    count = data.get("count", 10)
    try:
        count = max(1, min(int(count), 200))
    except (TypeError, ValueError):
        count = 10

    rows = IMPORTER_REGISTRY["sample"].run(count=count)
    created = []
    for row in rows:
        photo_urls = row.pop("photo_urls", [])
        lead = Lead(**row)
        lead.photo_urls = photo_urls
        db.session.add(lead)
        created.append(lead)
    db.session.commit()
    return jsonify([lead.to_dict() for lead in created]), 201


@bp.post("/import/csv")
def import_csv():
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded (expected multipart field 'file')"}), 400

    try:
        rows = IMPORTER_REGISTRY["csv"].run(request.files["file"].stream)
    except CsvImportError as exc:
        return jsonify({"error": str(exc)}), 400

    created = []
    for row in rows:
        photo_urls = row.pop("photo_urls", [])
        lead = Lead(**row)
        lead.photo_urls = photo_urls
        db.session.add(lead)
        created.append(lead)
    db.session.commit()
    return jsonify({"imported": len(created), "leads": [lead.to_dict() for lead in created]}), 201


@bp.post("/<int:lead_id>/outreach")
def trigger_outreach(lead_id):
    lead = db.session.get(Lead, lead_id)
    if lead is None:
        return jsonify({"error": "lead not found"}), 404

    data = request.get_json(force=True, silent=True) or {}
    try:
        send_outreach(lead, channel=data.get("channel", "email"))
    except OutreachNotConfigured as exc:
        return jsonify({"error": str(exc)}), 501
    return jsonify({"status": "sent"})
