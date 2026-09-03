"""
Running the video generator in the background, one clip per selected photo.

Generation takes minutes per clip, so a request can't wait on it. The job row
carries the state instead: the browser polls it, and each clip is written back
as it lands so progress is real rather than a spinner.

Only one job runs at a time. Clips cost money per second and a stuck job
firing six generations while another six are already running is an expensive
way to find out something is wrong.
"""
import logging
import os
import threading
from datetime import datetime, timezone

from services.video import (
    VideoError,
    VideoNotConfigured,
    download,
    estimate_cost,
    load_config,
    prompt_for_clip,
    upload_frame,
    submit_clip,
    upload_image,
    wait_for_clip,
)

log = logging.getLogger(__name__)

_lock = threading.Lock()

CLIPS_DIRNAME = os.path.join("studio", "static", "uploads", "clips")
CLIPS_URL_PREFIX = "/studio/static/uploads/clips"


class VideoJobBusy(Exception):
    """A job is already running."""


def is_busy():
    return _lock.locked()


def local_path_for(photo_url):
    """The file on disk behind a stored photo URL."""
    name = os.path.basename((photo_url or "").split("?")[0])
    return os.path.join("studio", "static", "uploads", name)


def _update(db, job, **fields):
    for key, value in fields.items():
        setattr(job, key, value)
    db.session.commit()


def _run(app, job_id):
    from extensions import db
    from models import Lead, VideoJob

    # Refuse rather than queue: a second job would spend money in parallel and
    # the user would have no way to tell which run produced which clip.
    if not _lock.acquire(blocking=False):
        with app.app_context():
            job = db.session.get(VideoJob, job_id)
            if job:
                _update(db, job, status="failed",
                        error="Another video job was already running.")
        return

    try:
        with app.app_context():
            job = db.session.get(VideoJob, job_id)
            if job is None or job.status == "cancelled":
                return

            cfg = load_config()
            _update(db, job, status="running", model=cfg["model"])

            clips = []
            for index, photo_url in enumerate(job.photos):
                # Re-read each time: the job may have been cancelled while the
                # previous clip was generating, and that should stop the spend.
                job = db.session.get(VideoJob, job_id)
                if job is None or job.status == "cancelled":
                    return

                entry = {"photo": photo_url, "index": index, "status": "running"}
                clips.append(entry)
                job.clips = clips
                db.session.commit()

                try:
                    path = local_path_for(photo_url)
                    if not os.path.exists(path):
                        raise VideoError(f"photo missing on disk: {os.path.basename(path)}")

                    image_url = upload_frame(path, cfg)
                    # Move, length and resolution are all per clip now, so the
                    # prompt is too. job.prompt is used only when one was typed
                    # by hand for the whole run.
                    spec = job.spec_for(index)
                    entry["move"] = spec["move"]
                    entry["duration"] = spec["duration"]
                    entry["resolution"] = spec["resolution"]

                    # The anchor: when the layout pass found a photo showing
                    # what this move heads toward, that photo becomes the final
                    # frame. The model then interpolates between two real
                    # photographs instead of inventing the space between them,
                    # which is the whole reason a pan invented a door.
                    last_url = None
                    anchor = spec.get("anchor")
                    if anchor:
                        anchor_path = local_path_for(anchor)
                        if os.path.exists(anchor_path):
                            last_url = upload_frame(anchor_path, cfg)
                            entry["anchor"] = anchor

                    prediction_id = submit_clip(
                        image_url,
                        # The site facts ride on the spec, put there when the
                        # render was submitted -- the worker has no lead and
                        # should not be re-reading satellites mid-run.
                        # A clip's own wording first. The aerial's two legs
                        # are different instructions, and one job-wide prompt
                        # would hand the landing's text to the approach.
                        prompt=spec.get("prompt") or job.prompt or prompt_for_clip(
                            move=spec["move"], cfg=cfg, site=spec.get("site")),
                        cfg=cfg,
                        duration=spec["duration"],
                        resolution=spec["resolution"],
                        last_image=last_url,
                        move=spec["move"],
                    )
                    entry["prediction_id"] = prediction_id
                    job.clips = clips
                    db.session.commit()

                    # A heartbeat while it waits. Generation is minutes of
                    # silence between two commits, and "the row has not been
                    # touched" was being read at boot as "the process that
                    # owned it is gone" -- which killed live renders whenever
                    # anything else imported the app.
                    def alive(_state=None, _job=job):
                        _job.updated_at = datetime.now(timezone.utc)
                        db.session.commit()

                    state = wait_for_clip(prediction_id, cfg, on_tick=alive)

                    filename = f"job{job.id}-clip{index}-{prediction_id[:8]}.mp4"
                    dest = os.path.join(CLIPS_DIRNAME, filename)
                    download(state["video_url"], dest)

                    entry["status"] = "completed"
                    entry["video_url"] = f"{CLIPS_URL_PREFIX}/{filename}"

                except (VideoError, VideoNotConfigured) as exc:
                    # One bad clip shouldn't discard the ones already paid for.
                    entry["status"] = "failed"
                    entry["error"] = str(exc)
                    log.warning("clip %s of job %s failed: %s", index, job_id, exc)

                job = db.session.get(VideoJob, job_id)
                job.clips = clips
                db.session.commit()

            job = db.session.get(VideoJob, job_id)
            if job is None or job.status == "cancelled":
                return

            done = [c for c in clips if c.get("video_url")]
            if not done:
                _update(db, job, status="failed",
                        error=clips[0].get("error") if clips else "no clips were generated")
                return

            # One clip is already a video. Several still need stitching, which
            # is the next phase -- until then they are listed individually
            # rather than pretending a finished video exists.
            output = done[0]["video_url"] if len(done) == 1 else None
            _update(db, job, status="completed", output_url=output)

            log.info("video job %s finished: %s of %s clips", job_id, len(done), len(clips))

    except Exception:  # noqa: BLE001 -- a crash must not leave the job "running" forever
        log.exception("video job %s crashed", job_id)
        try:
            with app.app_context():
                job = db.session.get(VideoJob, job_id)
                if job and job.status == "running":
                    _update(db, job, status="failed",
                            error="The generator crashed. Check the server log.")
        except Exception:
            pass
    finally:
        _lock.release()


def start_job(app, owner_id, photos, lead_id=None, prompt=None, duration=5,
              resolution="1080p", specs=None, style=None):
    """Create a job for these photos and run it in the background."""
    from extensions import db
    from models import VideoJob

    if is_busy():
        raise VideoJobBusy("A video is already generating. Wait for it to finish.")

    cfg = load_config()
    job = VideoJob(
        lead_id=lead_id,
        owner_id=owner_id,
        status="queued",
        model=cfg["model"],
        style=style or None,
        prompt=prompt or None,
        duration=duration,
        resolution=resolution,
        estimated_cost=round(
            sum(estimate_cost((s or {}).get("duration") or duration, cfg,
                              (s or {}).get("resolution") or resolution)
                for s in (specs or [{}] * len(photos))),
            2,
        ),
    )
    job.photos = photos
    job.specs = specs or []
    db.session.add(job)
    db.session.commit()

    threading.Thread(
        target=_run, args=(app, job.id), name=f"video-job-{job.id}", daemon=True
    ).start()
    return job


def latest_job_for(lead_id):
    from models import VideoJob

    return (
        VideoJob.query.filter_by(lead_id=lead_id)
        .order_by(VideoJob.created_at.desc())
        .first()
    )
