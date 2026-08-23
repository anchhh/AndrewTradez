import os

from apscheduler.schedulers.background import BackgroundScheduler
from flask import Flask
from flask_cors import CORS

from config import Config
from extensions import db

_scheduler = None


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)

    db.init_app(app)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from routes.ingestion import bp as ingestion_bp
    from routes.leads import bp as leads_bp
    app.register_blueprint(leads_bp)
    app.register_blueprint(ingestion_bp)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

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
