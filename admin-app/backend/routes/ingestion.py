from flask import Blueprint, jsonify

from models import IngestionRun
from services.feeds import FEEDS
from services.ingestion import run_ingestion

bp = Blueprint("ingestion", __name__, url_prefix="/api/ingest")


@bp.post("/run")
def run_now():
    results = run_ingestion()
    return jsonify(results), 200


@bp.get("/status")
def status():
    last_run = IngestionRun.query.order_by(IngestionRun.started_at.desc()).first()
    history = (
        IngestionRun.query.order_by(IngestionRun.started_at.desc()).limit(20).all()
    )
    return jsonify({
        "feeds": list(FEEDS.keys()),
        "last_run": last_run.to_dict() if last_run else None,
        "history": [run.to_dict() for run in history],
    })
