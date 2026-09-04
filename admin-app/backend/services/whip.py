"""
The whip: a speed-blur transition from a photograph into a clip.

The look is from real-estate drone reels -- a wide shot holds for a beat,
rushes in until it is a radial streak, and the next shot is simply there,
already moving, settling sharp within a third of a second. Editors make it
with a zoom and motion blur, not with a camera, and that is why it exists
here: asking the video model to fly from a wide neighbourhood shot to a
closer one had it inventing a different suburb on the way. Nothing between
the two pictures is generated any more. The model flies only the last leg,
and this bridges the gap from the photograph itself, so the surroundings in
picture one cannot become anything other than picture one.

All of it is ffmpeg filters on frames that already exist: zoompan for the
push and the rush, tmix (a running average of frames) for the streak that
grows with the speed, and the same pair run backwards on the clip's first
frames so it lands zoomed and blurred and settles.
"""
import logging
import os
import re
import subprocess

log = logging.getLogger(__name__)

FPS = 24
W, H = 1920, 1080

# Seconds. The hold is a slow push-in so the photo is not a freeze-frame;
# the whip is the accelerating rush; the landing is how long the clip takes
# to settle after the cut. Tuned against a reference reel and kept short:
# the point of the effect is that the second shot is just THERE.
HOLD = 1.0
WHIP = 0.4
LAND = 0.35

# Seconds the finished file gains over the clip it was made from, for the
# page that prices the render and for the length check below.
ADDED = HOLD + WHIP


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


def graph():
    """The filter graph: input 0 is the photograph (looped), input 1 the clip."""
    hold = int(HOLD * FPS)
    whip = int(WHIP * FPS)
    land = int(LAND * FPS)
    # Push in by 8% over the hold, then rush to 2.5x along a curve that
    # starts slow and ends fast -- the streak comes from tmix averaging
    # frames that are changing quickly, so the blur grows with the speed
    # for free. Capped where it is: past about 2.5x a 1080p photo is
    # a handful of pixels, and one build of this ended on a flat tan frame.
    z_in = "if(lt(on,%d),1+0.08*on/%d,1.08+1.5*pow((on-%d)/%d,2))" % (hold, hold, hold, whip)
    # The landing: the clip's first frames zoomed 1.7x, easing to 1 --
    # the same shape reversed, so the cut reads as the rush arriving.
    z_out = "if(lt(on,%d),1+0.7*pow(1-on/%d,2),1)" % (land, land)
    centre = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    return (
        "[0:v]scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,setsar=1,"
        "zoompan=z='%s':%s:d=1:fps=%d:s=%dx%d,tmix=frames=10,format=yuv420p[intro];"
        "[1:v]scale=%d:%d:force_original_aspect_ratio=decrease,"
        "pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=%d,"
        "zoompan=z='%s':%s:d=1:fps=%d:s=%dx%d,tmix=frames=5,format=yuv420p[clip];"
        "[intro][clip]concat=n=2:v=1:a=0[v]"
        % (W, H, W, H, z_in, centre, FPS, W, H,
           W, H, W, H, FPS, z_out, centre, FPS, W, H)
    )


def compose(photo_path, clip_path, out_path):
    """Write photo -> whip -> clip to out_path. True when the file is good.

    A failure is logged and reported, not raised: the clip it was made from
    already cost money and is fine on its own. The caller keeps that clip as
    the result when this returns False.
    """
    try:
        ffmpeg = _ffmpeg()
    except Exception as exc:  # noqa: BLE001 -- no ffmpeg is "no whip", not "no job"
        log.warning("whip: no ffmpeg available (%s)", exc)
        return False

    for path in (photo_path, clip_path):
        if not os.path.exists(path):
            log.warning("whip: %s is not on disk", os.path.basename(path))
            return False

    cmd = [ffmpeg, "-y",
           "-loop", "1", "-framerate", str(FPS), "-t", str(ADDED), "-i", photo_path,
           "-i", clip_path,
           "-filter_complex", graph(), "-map", "[v]",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out_path]
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=900)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        log.warning("whip: crashed: %s", exc)
        return False
    if done.returncode != 0 or not os.path.exists(out_path):
        log.warning("whip: ffmpeg failed: %s",
                    done.stderr.decode("utf-8", "replace")[-300:])
        return False

    # The one check that catches a bad build: the result is the clip plus
    # the whip, near enough. Anything else is a dropped or padded stretch,
    # and either is worse than the clip on its own.
    expected = duration_of(clip_path, ffmpeg) + ADDED
    actual = duration_of(out_path, ffmpeg)
    if not expected or abs(actual - expected) > 1.0:
        log.warning("whip: built %.1fs but expected %.1fs; keeping the clip alone",
                    actual, expected)
        try:
            os.unlink(out_path)
        except OSError:
            pass
        return False
    log.info("whip: %.1fs written to %s", actual, os.path.basename(out_path))
    return True
