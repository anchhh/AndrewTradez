import logging
import os

from flask import Flask, send_from_directory
from flask_cors import CORS

from auth import register_basic_auth
from config import Config
from extensions import db
from studio import init_studio

FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

log = logging.getLogger(__name__)


# How long a job may go without a heartbeat before a boot treats it as
# abandoned. Comfortably longer than a poll interval and comfortably shorter
# than a person's patience -- the cost of being wrong in one direction is a
# job that says "running" forever, and in the other a live render killed by
# an unrelated script.
STALE_AFTER = __import__("datetime").timedelta(minutes=10)


def _add_missing_columns(db):
    """Add columns the models declare but an existing table lacks.

    db.create_all() creates missing TABLES and never missing COLUMNS, so a
    new field on an existing model leaves the live database one column short
    and every query against it failing with "no such column". There is no
    migration tool in this project, and a column added to a model is by far
    the most common schema change here, so this reconciles the two at boot.

    Deliberately additive only: it never drops, renames or retypes anything.
    A column that exists is left exactly as it is, whatever its type, and a
    column the models no longer declare is left in place. Losing data to a
    startup routine that thought it knew better is not a trade worth making.
    """
    import sqlalchemy as sa

    inspector = sa.inspect(db.engine)
    existing_tables = set(inspector.get_table_names())

    for table in db.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue  # create_all just made it, with every column.
        have = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in have:
                continue
            # SQLite can only add a column that is nullable or has a
            # non-dynamic default; anything else would need the table
            # rebuilt, which is past what a boot-time fixup should attempt.
            if not column.nullable and column.server_default is None:
                log.warning(
                    "%s.%s is missing and NOT NULL -- add it by hand",
                    table.name, column.name)
                continue
            ddl = "ALTER TABLE %s ADD COLUMN %s %s" % (
                table.name, column.name,
                column.type.compile(dialect=db.engine.dialect))
            with db.engine.begin() as conn:
                conn.execute(sa.text(ddl))
            log.info("added column %s.%s", table.name, column.name)


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
        _add_missing_columns(db)
        # Snapshot on every boot, so there is always a recent copy of the
        # lead database to fall back on. See services/backup.py.
        from services.backup import snapshot
        snapshot(app, "startup", skip_if_unchanged=True)

        # Jobs run on background threads inside this process, so closing the
        # app mid-run kills them with the row still saying "running". Nothing
        # would ever move it, and the page would poll a job that no longer
        # exists.
        #
        # But "at boot" is not the same as "this is the only process". Any
        # script that imports this module runs create_app(), and this sweep
        # was reading every live render in the REAL server as abandoned and
        # marking it failed -- twice, both times while a paid generation was
        # actually still running on Atlas. So a job is only abandoned if it
        # has also gone quiet: the worker touches its row on every poll, so a
        # running job is never more than a few seconds stale.
        from datetime import datetime, timedelta, timezone

        from models import StagingJob, VideoJob

        quiet_since = datetime.now(timezone.utc).replace(tzinfo=None) - STALE_AFTER

        for model, label in ((StagingJob, "Staging"), (VideoJob, "Video")):
            stale = model.query.filter(
                model.status.in_(("queued", "running")),
                model.updated_at < quiet_since).all()
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
