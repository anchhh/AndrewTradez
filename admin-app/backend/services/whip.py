"""
The aerial reel: short drone clips cut together with speed-blur whips.

The look is from real-estate drone reels. A wide shot moves for a couple of
seconds, rushes in until it is a radial streak, cuts, and the next shot is
simply there -- already moving, sharp within a third of a second -- and
then does it again. The motion INSIDE each shot is real drone motion, so
each shot here is a clip the video model made from one photograph (a slow
forward push, nothing else). The cut BETWEEN shots is an editor's effect,
so it is built: the last frame of one clip rushed into a streak, the first
frame of the next settling out of one.

The streak is a zoom averaged over time. Done at 24 frames a second that is
ten ghost copies of the picture, which is what the first version of this
looked like and was rightly called awful. Done at 240 sub-frames a second
and averaged over thirty-two of them it is a smooth radial blur, which is
what the reference has. So the still is zoomed at 240 fps, averaged, and
only then brought down to 24.

Why not generate the transition too: asking the model to fly from a wide
neighbourhood shot to a closer one had it inventing a different suburb on
the way. The whip never asks it to.
"""
import logging
import os
import re
import subprocess
import tempfile

log = logging.getLogger(__name__)

FPS = 24
W, H = 1920, 1080

# Seconds. The rush is the accelerating zoom out of a shot; the landing is
# how long the next one takes to settle. Short on purpose -- the point of
# the effect is that the next shot is just THERE.
RUSH = 0.35
LAND = 0.30

# Sub-frames per second the stills are zoomed at, and how many are averaged
# into each streaked frame. 32 of 240 is a 0.13-second smear.
SUPER = 240
SMEAR = 32

# Per-shot lengths the page may offer. The model's shortest clip is three
# seconds; a shot shorter than that is rendered at three and trimmed.
SHOT_CHOICES = (2, 3, 4, 5)
MIN_RENDER = 3


def total_seconds(shots, each):
    """How long a reel of this many shots runs at this many seconds each."""
    if shots < 1:
        return 0.0
    return round(shots * each + (shots - 1) * (RUSH + LAND), 2)


def _ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def duration_of(path, ffmpeg=None):
    """Seconds of video in a file, read off ffmpeg's own header dump.

    The bundled binary is ffmpeg alone, no ffprobe, and `ffmpeg -i` prints
    the same Duration line to stderr before refusing to run without an
    output. Zero when unreadable, which callers treat as "do not trust it".
    """
    try:
        out = subprocess.run([ffmpeg or _ffmpeg(), "-i", path], capture_output=True,
                             timeout=60).stderr.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 -- unreadable is zero, and zero is refused
        return 0.0
    found = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", out)
    if not found:
        return 0.0
    hours, minutes, seconds = found.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


# Every clip to one frame: filled and cropped rather than letterboxed, so a
# photograph that was not 16:9 does not bring black bars into the reel.
_FRAME = ("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1,"
          "fps=%d,format=yuv420p" % (W, H, W, H, FPS))


def _run(cmd):
    done = subprocess.run(cmd, capture_output=True, timeout=900)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", "replace")[-400:])


def _streak(z, seconds, drop_first=False):
    """Zoom a still by `z` (an expression in `on`, the sub-frame number),
    averaged into a smooth streak and brought down to the reel's rate."""
    chain = ("zoompan=z='%s':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=%d:s=%dx%d,"
             "tmix=frames=%d,fps=%d" % (z, SUPER, W, H, SMEAR, FPS))
    if drop_first:
        # The very first averaged frame has nothing before it to average
        # with, so it comes out sharp -- one crisp zoomed-in frame ahead of
        # the blur, which reads as a flash. Dropped.
        chain += ",trim=start_frame=1,setpts=PTS-STARTPTS"
    return chain + ",format=yuv420p"


def reel(clip_paths, out_path, each):
    """Cut these clips into one reel with whips between them. True when good.

    `each` is the seconds of every clip that are used, from its start. A
    failure is logged and reported, not raised: the clips already cost money
    and are fine on their own, and the caller decides what to keep.
    """
    if not clip_paths:
        return False
    try:
        ffmpeg = _ffmpeg()
    except Exception as exc:  # noqa: BLE001 -- no ffmpeg is "no reel", not a crash
        log.warning("reel: no ffmpeg available (%s)", exc)
        return False
    for path in clip_paths:
        if not os.path.exists(path):
            log.warning("reel: %s is not on disk", os.path.basename(path))
            return False

    n = len(clip_paths)
    rush_sub = int(RUSH * SUPER)
    land_sub = int(LAND * SUPER)
    # Ease in: slow to start, fast at the end, out to 2.8x. Past about that a
    # 1080p frame is a handful of pixels and the streak turns to mud.
    z_rush = "1+1.8*pow(on/%d,2.2)" % rush_sub
    # The same curve backwards: lands at 1.8x and eases to 1.
    z_land = "1+0.8*pow(1-on/%d,2.2)" % land_sub

    try:
        with tempfile.TemporaryDirectory(prefix="reel-") as work:
            shots, stills = [], []
            for i, path in enumerate(clip_paths):
                shot = os.path.join(work, "shot%d.mp4" % i)
                _run([ffmpeg, "-y", "-t", "%.3f" % each, "-i", path, "-vf", _FRAME,
                      "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-an", shot])
                shots.append(shot)
                last = os.path.join(work, "last%d.png" % i)
                first = os.path.join(work, "first%d.png" % i)
                _run([ffmpeg, "-y", "-sseof", "-0.05", "-i", shot, "-frames:v", "1", last])
                _run([ffmpeg, "-y", "-i", shot, "-frames:v", "1", first])
                stills.append((first, last))

            # Inputs: the shots, then for every cut the still it rushes out
            # of and the still it lands on. Order in the concat: shot, rush,
            # land, shot, rush, land, shot.
            cmd = [ffmpeg, "-y"]
            for shot in shots:
                cmd += ["-i", shot]
            chains, order = [], []
            for i in range(n):
                order.append("[%d:v]" % i)
                if i == n - 1:
                    break
                r = len(shots) + 2 * i
                cmd += ["-loop", "1", "-framerate", str(SUPER), "-t", "%.3f" % RUSH,
                        "-i", stills[i][1],
                        "-loop", "1", "-framerate", str(SUPER), "-t", "%.3f" % (LAND + 1.0 / FPS),
                        "-i", stills[i + 1][0]]
                chains.append("[%d:v]%s[r%d]" % (r, _streak(z_rush, RUSH), i))
                chains.append("[%d:v]%s[l%d]" % (r + 1, _streak(z_land, LAND, drop_first=True), i))
                order += ["[r%d]" % i, "[l%d]" % i]
            graph = ";".join(chains) + (";" if chains else "") + "".join(order) \
                + "concat=n=%d:v=1:a=0[v]" % len(order)
            cmd += ["-filter_complex", graph, "-map", "[v]",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out_path]
            _run(cmd)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        log.warning("reel: failed: %s", exc)
        return False

    if not os.path.exists(out_path):
        return False
    # The one check that catches a bad build: the file is as long as its
    # parts, near enough. Anything else is a dropped or padded stretch.
    expected = total_seconds(n, each)
    actual = duration_of(out_path, ffmpeg)
    if not expected or abs(actual - expected) > 1.0:
        log.warning("reel: built %.1fs but expected %.1fs; discarding", actual, expected)
        try:
            os.unlink(out_path)
        except OSError:
            pass
        return False
    log.info("reel: %d shots of %ss, %.1fs, %s", n, each, actual, os.path.basename(out_path))
    return True
