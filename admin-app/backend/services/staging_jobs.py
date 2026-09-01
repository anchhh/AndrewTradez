"""
Running Scenery's staging in the background, one generation per chosen room.

Rooms are independent -- no stitching, no order that matters -- so unlike the
video generator these run in parallel. Ten rooms one after another is five
minutes of staring at a page; in parallel it is closer to thirty seconds, and
that difference is the whole reason the page can start on its own and simply
say "complete" when it is done.

Concurrency is capped anyway. Firing ten simultaneous generations at a
provider is how you collect ten rate-limit errors instead of ten images.
"""
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from services.staging import (
    StagingError,
    StagingNotConfigured,
    estimate_cost,
    load_config,
    stage_room_with_report,
    stamp_disclosure,
)

log = logging.getLogger(__name__)

_lock = threading.Lock()

STAGED_DIRNAME = os.path.join("studio", "static", "uploads", "staged")
STAGED_URL_PREFIX = "/studio/static/uploads/staged"

# Enough to feel immediate on a ten-room listing, low enough not to look like
# an attack to the provider.
MAX_PARALLEL = 4

POLL_INTERVAL = 4
POLL_TIMEOUT = 420


class StagingJobBusy(Exception):
    """A staging job is already running."""


def is_busy():
    return _lock.locked()


def local_path_for(photo_url):
    """The file on disk behind a stored photo URL."""
    name = os.path.basename((photo_url or "").split("?")[0])
    return os.path.join("studio", "static", "uploads", name)


def _stage_one(job_id, index, room, cfg):
    """Generate one room. Returns the updated entry; never raises.

    Runs on a worker thread with no application context and no database
    session -- it touches neither on purpose. Threads sharing a SQLAlchemy
    session is a class of bug that shows up as corrupted rows much later, so
    the results come back as plain dicts and the calling thread writes them.
    """
    entry = dict(room)
    try:
        path = local_path_for(room["photo"])
        if not os.path.exists(path):
            raise StagingError("photo missing on disk: " + os.path.basename(path))

        # One call, whichever provider is configured -- Gemini answers with the
        # image, Atlas Cloud is uploaded to and polled. Neither shape leaks here.
        # `leftovers` is non-empty when emptying a room did not fully succeed.
        data, leftovers = stage_room_with_report(path, room.get("style"), cfg)
        if leftovers:
            entry["warning"] = leftovers

        # Labelled before it is written, so no unlabelled copy ever exists on
        # disk to be grabbed by accident.
        if cfg.get("stamp", True):
            data = stamp_disclosure(data)

        filename = "job%s-room%s-%s.jpg" % (job_id, index, room.get("style") or "x")
        dest = os.path.join(STAGED_DIRNAME, filename)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)

        entry["status"] = "completed"
        entry["staged_url"] = STAGED_URL_PREFIX + "/" + filename
        return entry

    except (StagingError, StagingNotConfigured) as exc:
        # One bad room must not discard the ones already paid for.
        entry["status"] = "failed"
        entry["error"] = str(exc)
        log.warning("staging room %s of job %s failed: %s", index, job_id, exc)
        return entry
    except Exception as exc:  # noqa: BLE001
        entry["status"] = "failed"
        entry["error"] = "unexpected error: %s" % exc
        log.exception("staging room %s of job %s crashed", index, job_id)
        return entry


def _file_project(app, job, rooms):
    """Save the finished run into projects.json, and return its id.

    Scenery's output is a set of stills rather than a video, so it is filed as
    a project with `kind: "scenery"`. Same list, same owner scoping, and the
    before/after pairs travel with it -- an "after" with no "before" is not
    worth much to an agent.
    """
    from studio import load_projects, save_projects
    import uuid

    staged = [r for r in rooms if r.get("staged_url")]
    if not staged:
        return None

    projects = load_projects()
    now = time.time()
    name = job.address or "Staged rooms"
    project = {
        "id": uuid.uuid4().hex,
        "owner": job.owner_id,
        "kind": "scenery",
        "name": "%s - %s staged room%s" % (name, len(staged), "" if len(staged) == 1 else "s"),
        "address": job.address,
        "lead_id": job.lead_id,
        "photos": [r["staged_url"] for r in staged],
        "scenes": [
            {
                "before": r["photo"],
                "after": r["staged_url"],
                "label": r.get("label"),
                "style": r.get("style"),
            }
            for r in staged
        ],
        "status": "completed",
        "staging_job_id": job.id,
        "created_at": now,
        "updated_at": now,
    }
    projects.insert(0, project)
    save_projects(projects)
    return project["id"]


def _run(app, job_id):
    from extensions import db
    from models import StagingJob

    if not _lock.acquire(blocking=False):
        with app.app_context():
            job = db.session.get(StagingJob, job_id)
            if job:
                job.status = "failed"
                job.error = "Another staging job was already running."
                db.session.commit()
        return

    try:
        with app.app_context():
            job = db.session.get(StagingJob, job_id)
            if job is None or job.status == "cancelled":
                return

            cfg = load_config()
            rooms = job.rooms
            job.status = "running"
            job.model = cfg["model"]
            for room in rooms:
                room["status"] = "running"
            job.rooms = rooms
            db.session.commit()

            with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
                futures = {
                    pool.submit(_stage_one, job_id, i, room, cfg): i
                    for i, room in enumerate(rooms)
                }
                # Written back as each one lands rather than all at once at the
                # end, so the page fills in room by room.
                for future in as_completed(futures):
                    index = futures[future]
                    rooms[index] = future.result()
                    job = db.session.get(StagingJob, job_id)
                    if job is None or job.status == "cancelled":
                        return
                    job.rooms = rooms
                    db.session.commit()

            job = db.session.get(StagingJob, job_id)
            if job is None or job.status == "cancelled":
                return

            done = [r for r in rooms if r.get("staged_url")]
            if not done:
                job.status = "failed"
                # The first room's error is the honest headline: when the cause
                # is the account or the key, every room carries the same one.
                job.error = rooms[0].get("error") if rooms else "no rooms were staged"
                db.session.commit()
                return

            job.project_id = _file_project(app, job, rooms)
            job.status = "completed"
            db.session.commit()
            log.info("staging job %s finished: %s of %s rooms", job_id, len(done), len(rooms))

    except Exception:  # noqa: BLE001 -- a crash must not leave the job "running" forever
        log.exception("staging job %s crashed", job_id)
        try:
            with app.app_context():
                job = db.session.get(StagingJob, job_id)
                if job and job.status == "running":
                    job.status = "failed"
                    job.error = "The generator crashed. Check the server log."
                    db.session.commit()
        except Exception:
            pass
    finally:
        _lock.release()


def start_job(app, owner_id, rooms, lead_id=None, address=None):
    """Create a staging job for these rooms and run it in the background.

    `rooms` is [{photo, label, style}, ...] -- one entry per room the user
    chose, each already carrying the style it should be staged in.
    """
    from extensions import db
    from models import StagingJob

    if is_busy():
        raise StagingJobBusy("Rooms are already being staged. Wait for that run to finish.")

    cfg = load_config()
    job = StagingJob(
        lead_id=lead_id,
        owner_id=owner_id,
        status="queued",
        model=cfg["model"],
        address=address,
        estimated_cost=estimate_cost(len(rooms), cfg),
    )
    job.rooms = [
        {
            "photo": r.get("photo"),
            "label": r.get("label"),
            "style": r.get("style"),
            "status": "queued",
        }
        for r in rooms
    ]
    db.session.add(job)
    db.session.commit()

    threading.Thread(
        target=_run, args=(app, job.id), name="staging-job-%s" % job.id, daemon=True
    ).start()
    return job


def latest_job_for(owner_id):
    from models import StagingJob

    return (
        StagingJob.query.filter_by(owner_id=owner_id)
        .order_by(StagingJob.created_at.desc())
        .first()
    )
