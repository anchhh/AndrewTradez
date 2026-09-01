import os

from flask import Flask, send_from_directory
from flask_cors import CORS

from auth import register_basic_auth
from config import Config
from extensions import db
from studio import init_studio

FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")


def create_app():
    app = Flask(__name__, static_folder=FRONTEND_DIST, static_url_path="")
    app.config.from_object(Config)

    register_basic_auth(app)

    db.init_app(app)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    from routes.leads import bp as leads_bp
    app.register_blueprint(leads_bp)

    init_studio(app)  # registers /studio/* -- estly Studio's video-generation UI

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
        # Snapshot on every boot, so there is always a recent copy of the
        # lead database to fall back on. See services/backup.py.
        from services.backup import snapshot
        snapshot(app, "startup", skip_if_unchanged=True)

        # Jobs run on background threads inside this process, so closing the
        # app mid-run kills them with the row still saying "running". Nothing
        # would ever move it, and the page would poll a job that no longer
        # exists. A job in that state at boot cannot be running -- the process
        # that owned it is gone -- so say what happened.
        from models import StagingJob, VideoJob

        for model, label in ((StagingJob, "Staging"), (VideoJob, "Video")):
            stale = model.query.filter(model.status.in_(("queued", "running"))).all()
            for job in stale:
                job.status = "failed"
                job.error = (
                    f"{label} was interrupted when the app stopped. "
                    "Nothing further was charged. Run it again to pick up "
                    "where it left off -- finished rooms are reused."
                )
            if stale:
                db.session.commit()
                app.logger.warning("marked %d interrupted %s job(s) as failed",
                                   len(stale), label.lower())

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5050)
