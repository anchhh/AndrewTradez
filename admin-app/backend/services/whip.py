"""
The aerial reel: a run of photographs, each a short moving shot, joined by
speed-blur whips.

The look is from real-estate drone reels. A wide shot holds for a beat,
rushes in until it is a radial streak, cuts, and the next shot is simply
there -- already moving, sharp within a third of a second -- then does the
same. Editors make it with a zoom and motion blur, not a camera, and that
is why it is built here rather than generated: asking the video model to
fly from a wide neighbourhood shot to a closer one had it inventing a
different suburb on the way. No frame here is generated. Every one is the
photograph, moved.

All of it is ffmpeg on frames that already exist: zoompan for the drift, the
rush and the landing; tmix (a running average of frames) for a streak that
grows with the speed and fades as it settles; concat for the cuts.
"""
import logging
import os
import re
import subprocess

log = logging.getLogger(__name__)

FPS = 24
W, H = 1920, 1080

# Seconds. The drift is the shot itself -- a slow push so the photograph is
# not a freeze-frame; the whip is the accelerating rush out of it; the
# landing is how long the next shot takes to settle after the cut. Tuned
# against a reference reel and kept short: the point of the effect is that
# the next shot is just THERE.
DRIFT = 1.5
WHIP = 0.4
LAND = 0.35


def total_seconds(shots):
    """How long a reel of this many photographs runs."""
    if shots < 1:
        return 0.0
    return round(shots * DRIFT + (shots - 1) * (WHIP + LAND), 2)


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


def _shot(index, first, last):
    """One photograph's filter chain, and how many frames it runs.

    Three stretches, each optional at the ends of the reel: the landing
    (zoomed 1.7x, easing to 1 -- the rush arriving), the drift (a slow 6%
    push), and the whip (rushing to 2.5x along a curve that starts slow and
    ends fast). The streak comes from tmix averaging frames that change
    quickly, so the blur grows with the speed for free.

    The zoom is capped where it is on purpose: past about 2.5x a 1080p
    photograph is a handful of pixels, and one build ended on a flat tan
    frame. The last shot drifts back OUT to exactly 1, so the reel ends on
    the photograph itself -- the flyover opens on that same frame, and the
    two cut together with no seam.
    """
    land = 0 if first else int(LAND * FPS)
    drift = int(DRIFT * FPS)
    whip = 0 if last else int(WHIP * FPS)
    frames = land + drift + whip

    # Piecewise in `on`, the output frame number, continuous at the joins.
    parts = []
    if land:
        rest = 1.06 if last else 1.0
        parts.append("if(lt(on,%d),%s+%s*pow(1-on/%d,2)," % (land, rest, 1.7 - rest, land))
    if last:
        # 1.06 down to 1: ends on the photograph.
        parts.append("if(lt(on,%d),1+0.06*(1-(on-%d)/%d),1)" % (land + drift, land, drift))
    else:
        parts.append("if(lt(on,%d),1+0.06*(on-%d)/%d,1.06+1.44*pow((on-%d)/%d,2))"
                     % (land + drift, land, drift, land + drift, whip))
    z = "".join(parts) + ")" * (1 if land else 0)

    chain = (
        "[%d:v]scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1,"
        "zoompan=z='%s':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=%d:s=%dx%d,"
        "tmix=frames=%d,format=yuv420p[v%d]"
        % (index, W, H, W, H, z, FPS, W, H, 5 if last else 10, index)
    )
    return chain, frames


def reel(photo_paths, out_path):
    """Write the photographs as one reel to out_path. True when the file is good.

    A failure is logged and reported, not raised: nothing here cost money,
    and the caller decides what to tell the person waiting.
    """
    if not photo_paths:
        return False
    try:
        ffmpeg = _ffmpeg()
    except Exception as exc:  # noqa: BLE001 -- no ffmpeg is "no reel", not a crash
        log.warning("reel: no ffmpeg available (%s)", exc)
        return False
    for path in photo_paths:
        if not os.path.exists(path):
            log.warning("reel: %s is not on disk", os.path.basename(path))
            return False

    n = len(photo_paths)
    chains, cmd = [], [ffmpeg, "-y"]
    for i, path in enumerate(photo_paths):
        chain, frames = _shot(i, first=(i == 0), last=(i == n - 1))
        chains.append(chain)
        cmd += ["-loop", "1", "-framerate", str(FPS), "-t", "%.3f" % (frames / FPS), "-i", path]
    graph = ";".join(chains) + ";" + "".join("[v%d]" % i for i in range(n)) \
        + "concat=n=%d:v=1:a=0[v]" % n
    cmd += ["-filter_complex", graph, "-map", "[v]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out_path]

    try:
        done = subprocess.run(cmd, capture_output=True, timeout=900)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        log.warning("reel: crashed: %s", exc)
        return False
    if done.returncode != 0 or not os.path.exists(out_path):
        log.warning("reel: ffmpeg failed: %s", done.stderr.decode("utf-8", "replace")[-300:])
        return False

    # The one check that catches a bad build: the file is as long as its
    # shots, near enough. Anything else is a dropped or padded stretch.
    expected = total_seconds(n)
    actual = duration_of(out_path, ffmpeg)
    if not expected or abs(actual - expected) > 1.0:
        log.warning("reel: built %.1fs but expected %.1fs; discarding", actual, expected)
        try:
            os.unlink(out_path)
        except OSError:
            pass
        return False
    log.info("reel: %d shots, %.1fs, %s", n, actual, os.path.basename(out_path))
    return True
