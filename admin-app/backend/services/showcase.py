"""
The two loops on the Create page: what Video makes, and what Scenery makes.

Built from work already in this app -- real clips and real staged rooms --
rather than stock footage, because the point of the card is "here is what you
made with this", and a stock house makes that a lie.

Encoded locally with the ffmpeg that ships inside CapCut, so this costs
nothing and needs no API. Rebuilt on request rather than on every page load:
a Create page that waits for two video encodes to show you a menu is a worse
page than one showing a loop from last week.
"""
import json
import os
import subprocess

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "studio", "static")


def local_path_for(url):
    """The file behind a /studio/static/... URL, subdirectories included.

    Deliberately not contact_sheet.local_path_for, which flattens to
    uploads/<basename>. That is right for listing photos, which sit directly
    in uploads, and wrong for everything this module wants: clips live in
    uploads/clips and staged rooms in uploads/staged, and flattening silently
    returned paths that did not exist.
    """
    path = (url or "").split("?")[0]
    marker = "/studio/static/"
    if marker in path:
        path = path.split(marker, 1)[1]
    return os.path.join(STATIC_DIR, *path.strip("/").split("/"))

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "studio", "static", "showcase")

# 16:9 at a size a card can show crisply without shipping 40MB to a browser.
WIDTH, HEIGHT = 1280, 720

# Long enough to read, short enough that the pair reads as one thing.
BEFORE_SECONDS = 1.5
AFTER_SECONDS = 1.9

# Furniture going IN reads as staging. "unfurnished" empties a room, which is
# a real feature and a confusing advertisement for one.
FURNISHING_STYLES = ("modern", "coastal", "scandinavian", "farmhouse",
                     "midcentury", "traditional", "minimal", "luxury")


class ShowcaseError(Exception):
    """A reel could not be built."""


def ffmpeg():
    from services import capcut

    path = capcut.bundled_ffmpeg()
    if not path:
        raise ShowcaseError(
            "ffmpeg was not found. It ships inside CapCut, so installing "
            "CapCut provides it.")
    return path


# CapCut's ffmpeg is built without libx264 -- it carries only hardware
# encoders (AMF, NVENC, QSV) plus MediaFoundation, and mpeg4, which browsers
# will not play. So the encoder is chosen at runtime instead of assumed, and
# MediaFoundation is the fallback because it exists on any Windows machine
# whether or not there is a usable GPU.
ENCODER_CHOICES = ("h264_nvenc", "h264_qsv", "h264_amf", "h264_mf")

_encoder = None


def encoder():
    """The first H.264 encoder this ffmpeg can actually run."""
    global _encoder
    if _encoder:
        return _encoder

    exe = ffmpeg()
    for name in ENCODER_CHOICES:
        probe = subprocess.run(
            [exe, "-hide_banner", "-loglevel", "error",
             "-f", "lavfi", "-i", "testsrc=size=64x64:duration=1:rate=5",
             "-c:v", name, "-b:v", "1M", "-pix_fmt", "yuv420p",
             "-f", "null", "-"],
            capture_output=True, text=True)
        if probe.returncode == 0:
            _encoder = name
            return name
    raise ShowcaseError(
        "this ffmpeg has no working H.264 encoder, so nothing a browser can "
        "play could be written")


def _encode_args(bitrate="4M"):
    """Encoder flags. Bitrate rather than CRF: the hardware encoders here do
    not accept -crf, and asking for it fails the whole command."""
    return ["-c:v", encoder(), "-b:v", bitrate, "-pix_fmt", "yuv420p",
            "-movflags", "+faststart"]


def _run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        # ffmpeg says why on stderr and it is usually the whole answer.
        tail = (result.stderr or "").strip().splitlines()[-4:]
        raise ShowcaseError("ffmpeg failed: " + " / ".join(tail))


def _fit(stream):
    """Scale to fill the frame and crop the overflow.

    The clips are 3:2 and the card is 16:9. Padding would letterbox a video
    that is meant to sit edge to edge in a tile, so it crops instead.
    """
    return ("scale=%d:%d:force_original_aspect_ratio=increase,"
            "crop=%d:%d,setsar=1,fps=30" % (WIDTH, HEIGHT, WIDTH, HEIGHT))


# --------------------------------------------------------------------------
# The video card
# --------------------------------------------------------------------------

def video_sources(limit=4):
    """The most recent delivered clips, newest first."""
    from models import VideoJob

    out = []
    for job in VideoJob.query.order_by(VideoJob.id.desc()).all():
        for clip in job.clips or []:
            url = clip.get("video_url")
            if not url or clip.get("deleted_at"):
                continue
            path = local_path_for(url)
            if os.path.exists(path):
                out.append(path)
            if len(out) >= limit:
                return out
    return out


def build_video_reel(limit=4, seconds_each=3.0):
    """A silent loop of recent clips, cut end to end."""
    clips = video_sources(limit)
    if not clips:
        raise ShowcaseError("no rendered clips to show yet")

    os.makedirs(OUT_DIR, exist_ok=True)
    target = os.path.join(OUT_DIR, "video.mp4")

    args = [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
    for path in clips:
        # A slice from the middle of each: the first second of a clip is the
        # still it started from, which looks like a frozen frame in a loop.
        args += ["-ss", "1.0", "-t", str(seconds_each), "-i", path]

    chain = "".join("[%d:v]%s[v%d];" % (i, _fit(i), i) for i in range(len(clips)))
    chain += "".join("[v%d]" % i for i in range(len(clips)))
    chain += "concat=n=%d:v=1:a=0[out]" % len(clips)

    args += (["-filter_complex", chain, "-map", "[out]",
              "-an"]                     # silent: it autoplays in a card
             + _encode_args("2M") + [target])
    _run(args)
    return target


# --------------------------------------------------------------------------
# The staging card
# --------------------------------------------------------------------------

def staging_pairs(limit=5):
    """Before/after pairs, one per room, from the furnishing styles."""
    from models import StagingJob

    seen_rooms = set()
    pairs = []
    for job in StagingJob.query.order_by(StagingJob.id.desc()).all():
        for room in job.rooms or []:
            if not room.get("staged_url") or room.get("style") not in FURNISHING_STYLES:
                continue
            label = (room.get("label") or "").strip()
            # One per room, or the loop is four angles of the same lounge.
            if label in seen_rooms:
                continue
            before = local_path_for(room.get("photo") or "")
            after = local_path_for(room.get("staged_url"))
            if not (os.path.exists(before) and os.path.exists(after)):
                continue
            seen_rooms.add(label)
            pairs.append((before, after, label))
            if len(pairs) >= limit:
                return pairs
    return pairs


def build_staging_reel(limit=5):
    """Before, then after, for several rooms. A straight cut between them.

    Each picture is its own looped input rather than a concat-demuxer list.
    The list version produced a file of the right length showing a single
    photograph for all of it -- the durations were honoured and the images
    were not -- and a seventeen-second still is a worse bug than a failure,
    because it looks like it worked.
    """
    pairs = staging_pairs(limit)
    if not pairs:
        raise ShowcaseError("no staged rooms to show yet")

    os.makedirs(OUT_DIR, exist_ok=True)
    target = os.path.join(OUT_DIR, "staging.mp4")

    shots = []
    for before, after, _ in pairs:
        shots.append((before, BEFORE_SECONDS))
        shots.append((after, AFTER_SECONDS))

    args = [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y"]
    for path, seconds in shots:
        args += ["-loop", "1", "-t", str(seconds), "-i", path]

    chain = "".join("[%d:v]%s[v%d];" % (i, _fit(i), i) for i in range(len(shots)))
    chain += "".join("[v%d]" % i for i in range(len(shots)))
    chain += "concat=n=%d:v=1:a=0[out]" % len(shots)

    args += ["-filter_complex", chain, "-map", "[out]", "-an"]
    args += _encode_args("2M") + [target]
    _run(args)
    return target


def build_all():
    """Both reels. One failing does not stop the other -- a listing with clips
    and no staged rooms should still get a video card."""
    made = {}
    for name, fn in (("video", build_video_reel), ("staging", build_staging_reel)):
        try:
            made[name] = {"path": fn(), "error": None}
        except ShowcaseError as exc:
            made[name] = {"path": None, "error": str(exc)}
    return made


def status():
    """What exists on disk, for the page to decide whether to show a loop."""
    out = {}
    for name in ("video", "staging"):
        path = os.path.join(OUT_DIR, "%s.mp4" % name)
        out[name] = {
            "exists": os.path.exists(path),
            "url": "/studio/static/showcase/%s.mp4" % name,
            "bytes": os.path.getsize(path) if os.path.exists(path) else 0,
        }
    return out
