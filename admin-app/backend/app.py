import os

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask, send_from_directory
from flask_cors import CORS

from auth import register_basic_auth
from config import Config
from extensions import db

_scheduler = None

FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")


def create_app():
    app = Flask(__name__, static_folder=FRONTEND_DIST, static_url_path="")
    app.config.from_object(Config)

    register_basic_auth(app)

    db.init_app(app)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from routes.ingestion import bp as ingestion_bp
    from routes.leads import bp as leads_bp
    app.register_blueprint(leads_bp)
    app.register_blueprint(ingestion_bp)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    # Serves the built dashboard (admin-app/frontend/dist) when present, so
    # a single deployed service can host both the API and the UI on one
    # origin -- no separate frontend deployment or cross-origin API base
    # needed. Asset files (JS/CSS/etc.) are served automatically by
    # Flask's static_folder above; this just covers the bare "/" request,
    # which the static handler's <path:filename> pattern never matches. In
    # local dev, frontend/dist won't exist (npm run dev serves it
    # separately on :5173 instead), so this just 404s harmlessly.
    @app.get("/")
    def serve_index():
        index_path = os.path.join(FRONTEND_DIST, "index.html")
        if os.path.isfile(index_path):
            return send_from_directory(FRONTEND_DIST, "index.html")
        return {"error": "frontend not built"}, 404

    with app.app_context():
        db.create_all()

    _start_scheduler(app)

    return app


def _start_scheduler(app):
    """Runs the ingestion pipeline automatically every
    INGEST_INTERVAL_MINUTES. Guarded against Flask's debug reloader
    (which forks a second process) so it doesn't start twice."""
    global _scheduler
    if _scheduler is not None:
        return
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    from services.ingestion import run_ingestion

    def _tick():
        with app.app_context():
            run_ingestion()

    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(_tick, "interval", minutes=app.config["INGEST_INTERVAL_MINUTES"])
    _scheduler.start()


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5050)
