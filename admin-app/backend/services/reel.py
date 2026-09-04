"""
Joining the aerial's two legs into one file.

The aerial is rendered as two clips because the model takes a first frame
and a last frame and nothing between: leg one warps from the first
photograph to the second, leg two eases from the second to the third. Leg
one ENDS on the exact photograph leg two BEGINS on, so putting them end to
end is one continuous take -- the one case where concatenation is not a
cut.

Use the concat FILTER with every input scaled to one size first, never the
concat demuxer. The model does not return a fixed frame size -- two legs
came back 1928x1072 and 1936x1080 -- and the demuxer, fed a size change
mid-stream, produced a 47-second file from two 12-second clips whether
copying or re-encoding.
"""
import logging
import os
import re
import subprocess

log = logging.getLogger(__name__)

FPS = 24
W, H = 1920, 1080


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


def join(clip_paths, out_path):
    """Put these clips end to end into one file. True when the file is good.

    A failure is logged and reported, not raised: the clips already cost
    money and play on their own, and the caller keeps them as the result.
    """
    if len(clip_paths) < 2:
        return False
    try:
        ffmpeg = _ffmpeg()
    except Exception as exc:  # noqa: BLE001 -- no ffmpeg is "no join", not a crash
        log.warning("join: no ffmpeg available (%s)", exc)
        return False
    for path in clip_paths:
        if not os.path.exists(path):
            log.warning("join: %s is not on disk", os.path.basename(path))
            return False

    # Filled and cropped rather than letterboxed: the legs differ by a few
    # pixels, and padding them would put thin black edges on one and not the
    # other.
    chain = ["[%d:v]scale=%d:%d:force_original_aspect_ratio=increase,"
             "crop=%d:%d,setsar=1,fps=%d,format=yuv420p[v%d]"
             % (i, W, H, W, H, FPS, i) for i in range(len(clip_paths))]
    graph = ";".join(chain) + ";" + "".join("[v%d]" % i for i in range(len(clip_paths))) \
        + "concat=n=%d:v=1:a=0[v]" % len(clip_paths)

    cmd = [ffmpeg, "-y"]
    for path in clip_paths:
        cmd += ["-i", path]
    cmd += ["-filter_complex", graph, "-map", "[v]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out_path]

    try:
        done = subprocess.run(cmd, capture_output=True, timeout=900)
    except Exception as exc:  # noqa: BLE001 -- see docstring
        log.warning("join: crashed: %s", exc)
        return False
    if done.returncode != 0 or not os.path.exists(out_path):
        log.warning("join: ffmpeg failed: %s",
                    done.stderr.decode("utf-8", "replace")[-300:])
        return False

    # The one check that catches a bad join: the result is as long as its
    # parts, near enough. Anything else is padding or a dropped leg, and
    # either is worse than two honest clips.
    expected = sum(duration_of(p, ffmpeg) for p in clip_paths)
    actual = duration_of(out_path, ffmpeg)
    if not expected or abs(actual - expected) > 1.0:
        log.warning("join: %.1fs but the parts total %.1fs; keeping them separate",
                    actual, expected)
        try:
            os.unlink(out_path)
        except OSError:
            pass
        return False
    log.info("join: %d clips, %.1fs, %s", len(clip_paths), actual,
             os.path.basename(out_path))
    return True
