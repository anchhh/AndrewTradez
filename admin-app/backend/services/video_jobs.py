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

            # One clip is already a video. Several are only a video when they
            # share their joins -- the aerial's legs do, by construction: leg
            # one ENDS on the exact photograph leg two BEGINS on, so
            # concatenating them is one continuous take with no visible seam.
            # A walkthrough's clips share nothing at the join and are left as
            # they are; gluing those would be a jump cut wearing one filename.
            output = done[0]["video_url"] if len(done) == 1 else None
            if output is None and job.style == "aerial" and len(done) == len(clips):
                output = stitch(job.id, [c["video_url"] for c in done])
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


def _duration(ffmpeg, path):
    """Seconds of video in a file, read off ffmpeg's own header dump.

    ffprobe would be the tool, but the bundled binary is ffmpeg alone, and
    `ffmpeg -i` prints the same Duration line to stderr before refusing to
    do anything without an output. Zero when it cannot be read, which the
    caller treats as "do not trust the join".
    """
    import re
    import subprocess

    try:
        out = subprocess.run([ffmpeg, "-i", path], capture_output=True,
                             timeout=60).stderr.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 -- unreadable is zero, and zero is refused
        return 0.0
    found = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not found:
        return 0.0
    hours, minutes, seconds = found.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def stitch(job_id, urls):
    """Join clips that share their frames into one file. Returns its URL.

    Always a re-encode, never a stream copy: the legs come from the same
    model at the same settings and still do not share a frame size, so they
    are scaled to one before the join (see below). A minute of encoding is
    the price. If anything fails, or the result is not as long as its parts,
    the job keeps its separate clips and says so in the log rather than
    failing a render that already cost money.
    """
    import subprocess

    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # noqa: BLE001 -- no ffmpeg is "no stitch", not "no job"
        log.warning("job %s: no ffmpeg available to stitch (%s)", job_id, exc)
        return None

    paths = []
    for url in urls:
        name = url.rsplit("/", 1)[-1]
        path = os.path.abspath(os.path.join(CLIPS_DIRNAME, name))
        if not os.path.exists(path):
            log.warning("job %s: cannot stitch, %s is not on disk", job_id, name)
            return None
        paths.append(path)

    out_name = f"job{job_id}-stitched.mp4"
    out_path = os.path.abspath(os.path.join(CLIPS_DIRNAME, out_name))

    try:
        # The concat FILTER, with every input scaled to one frame size first,
        # rather than the concat demuxer. The model does not return a fixed
        # size -- two legs came back 1928x1072 and 1936x1080 -- and the
        # demuxer, fed a size change mid-stream, produced a 47-second file
        # from two 12-second clips whether copying or re-encoding. The filter
        # rebuilds the timeline from scratch and cannot be fed mismatched
        # frames, because the scale in front of it makes them match.
        w, h = 1920, 1080
        chain = []
        for i in range(len(paths)):
            chain.append(
                "[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,"
                "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v%d]"
                % (i, w, h, w, h, i))
        graph = ";".join(chain) + ";" + "".join("[v%d]" % i for i in range(len(paths))) \
            + "concat=n=%d:v=1:a=0[v]" % len(paths)
        cmd = [ffmpeg, "-y"]
        for path in paths:
            cmd += ["-i", path]
        cmd += ["-filter_complex", graph, "-map", "[v]",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out_path]
        done = subprocess.run(cmd, capture_output=True, timeout=900)
        if done.returncode != 0 or not os.path.exists(out_path):
            log.warning("job %s: stitch failed: %s", job_id,
                        done.stderr.decode("utf-8", "replace")[-300:])
            return None

        # The one check that catches a bad join: the result should be as long
        # as its parts, near enough. Anything else is padding or a dropped
        # leg, and either is worse than two honest clips.
        expected = sum(_duration(ffmpeg, p) for p in paths)
        actual = _duration(ffmpeg, out_path)
        if not expected or abs(actual - expected) > 1.0:
            log.warning("job %s: stitched length %.1fs but parts total %.1fs; "
                        "keeping the separate clips", job_id, actual, expected)
            os.unlink(out_path)
            return None

        log.info("job %s: stitched %d clips into %.1fs", job_id, len(paths), actual)
        return f"{CLIPS_URL_PREFIX}/{out_name}"
    except Exception as exc:  # noqa: BLE001 -- see docstring
        log.warning("job %s: stitch crashed: %s", job_id, exc)
    return None


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
