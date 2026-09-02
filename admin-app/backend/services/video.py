"""
Turning a listing photo into a short video clip, via Atlas Cloud.

A finished listing video is several of these stitched together with music and
text over the top. This module does one arrow in that chain: photo in, short
clip out. Stitching lives elsewhere, because the model has no idea what a
finished video is -- it animates one still at a time.

Model choice is config, not code. The provider that is cheapest for one model
is often dearest for another (fal is the cheapest route to Kling 3.0 and one of
the priciest to Seedance 2.5), and the model that keeps a room looking like
that room is worth more than the one that costs least. Both of those change;
neither should need a code edit.

Generation takes minutes, so everything here is submit-then-poll. Nothing in a
web request should ever wait on it.
"""
import json
import os
import time

import requests

BASE_URL = "https://api.atlascloud.ai/api/v1"

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "atlascloud.json"
)

DEFAULT_MODEL = "bytedance/seedance-2.5/image-to-video"

# Per second of output, BY RESOLUTION. This is not a detail: Atlas Cloud's
# headline price for Seedance 2.5 is "$0.134/second", and that is what was
# used here at first -- so a 5-second 1080p clip was estimated at $0.67 and
# actually cost $2.98. The headline is the cheapest tier; the real rates are
# per resolution and 1080p is about 4.4x the number on the tin.
#
# Measured, not quoted: $2.98438331 for 5 seconds at 1080p is $0.596877/s,
# which matches the ~$0.59 figure the pricing write-ups give. Re-check these
# against a real invoice before trusting them for anything large -- the whole
# reason this comment exists is that a quoted figure was wrong.
RATE_PER_SECOND = {
    "480p": 0.14,
    "720p": 0.30,
    "1080p": 0.597,
}

# The fallback when a resolution is unknown: the dearest, because guessing low
# is how an estimate becomes a surprise.
DEFAULT_RATE_PER_SECOND = 0.597

# The constraint half of every clip prompt.
#
# Same discipline as services/staging.py, for the same reason and then some.
# A staged still that invents a door is a misrepresentation; a clip that
# invents one is a misrepresentation twenty-four times a second, and the
# agent -- not the model -- carries it.
#
# Video needs more than the still did, because it can go wrong in ways a
# photograph cannot:
#
#   * things morph between frames rather than being wrong in one frame
#   * a move toward or away from the subject tempts the model to INVENT the
#     space it is moving into, which is how rooms grow doors
#   * lighting, white balance and grade drift over the clip
#   * a "shot" quietly becomes two shots
#
# So the rule is stated before AND after the movement, enumerated rather than
# implied, and it says what may move: the camera, and nothing else.
ONLY_THE_CAMERA = (
    "This is a photograph of a real property being brought to life. The ONLY "
    "thing that may move is the camera. Nothing in the scene may move, change, "
    "appear or disappear."
)

NEVER_CHANGE = (
    "Do NOT add, remove, move, resize, restyle or re-colour any of the "
    "following, at any point in the clip: walls, doors, doorways, archways, "
    "openings, windows, window frames, glazing bars, blinds, curtains, "
    "ceilings, floors, flooring material, rugs, stairs, railings, columns, "
    "beams, fireplaces, mantels, built-in shelving, cabinetry, worktops, "
    "islands, sinks, taps, appliances, radiators, vents, light fittings, "
    "lamps, switches, sockets, skirting, trim, mouldings, furniture, "
    "cushions, artwork, mirrors, plants, or any object on any surface. "
    "Do not open or close anything. Do not turn anything on or off. "
    "Do not change any text, sign, label or number that is visible. "
    "Do not change what is visible through any window, doorway or mirror."
)

NO_INVENTION = (
    "Do NOT invent any part of the property that is not already visible in "
    "the photograph. If the camera move would reveal space the photograph "
    "does not show, make the move SMALLER and stay within what is there -- a "
    "shorter, slower move is always correct, and inventing a room, a doorway "
    "or a view is always wrong."
)

TEMPORAL = (
    "Every frame must show the same room as the first frame, from a slightly "
    "different camera position and nothing else. Nothing may morph, warp, "
    "melt, stretch, drift, flicker or swap between frames. Straight lines "
    "must stay straight. Keep the lighting, shadows, white balance, colour "
    "and exposure identical throughout. One single continuous shot: no cuts, "
    "no transitions, no change of scene, no speed ramp."
)

LOOK = (
    "Photorealistic real-estate listing footage, shot on a stabilised "
    "cinema camera. Slow, smooth, even motion at a constant speed. "
    "No people, no pets, no vehicles, no text, no captions, no watermark, "
    "no logos, no reflections of a camera or crew."
)

WHEN_UNSURE = (
    "If you are unsure whether something is part of the building or how a "
    "surface continues out of frame, do not move as far. Holding almost "
    "still is an acceptable result; changing the property is not."
)

# The camera move, chosen per clip.
#
# This is the video equivalent of Scenery's per-room styles, and for the same
# reason: one setting for a whole listing is the wrong grain. A pull-out
# reveals the house on the exterior shot and a push-in sells the kitchen, and
# being forced to pick one for both makes a worse video than either.
#
# Each is a movement only. The constraint and the look are bolted on by
# prompt_for_clip so a new move cannot accidentally ship without them.
#
#   key: (label, one-line description for the button, movement instruction)
MOVES = [
    ("push_in", "Push in",
     "Slow dolly forward into the space",
     "MOVEMENT: move the camera slowly and steadily FORWARD into the space, a "
     "smooth dolly push-in, travelling only a short distance over the whole "
     "clip. Do not tilt, rotate or zoom. Stay inside the frame you were given "
     "-- move in, never past anything."),
    ("pull_out", "Pull out",
     "Slow dolly back, revealing the room",
     "MOVEMENT: move the camera slowly and steadily BACKWARD, a smooth dolly "
     "pull-out, travelling only a short distance over the whole clip. Do not "
     "tilt, rotate or zoom. Reveal only a little more of what is already at "
     "the edges of the photograph -- do not invent walls, doorways, furniture "
     "or ceiling to fill the space you are backing into."),
    ("pan_left", "Pan left",
     "Sweep the view leftwards",
     "MOVEMENT: rotate the camera slowly and smoothly to the LEFT from a "
     "fixed position, an even horizontal pan through a small angle. No dolly "
     "movement, no tilt, no zoom. Reveal only a little beyond the left edge, "
     "and invent nothing to fill it."),
    ("pan_right", "Pan right",
     "Sweep the view rightwards",
     "MOVEMENT: rotate the camera slowly and smoothly to the RIGHT from a "
     "fixed position, an even horizontal pan through a small angle. No dolly "
     "movement, no tilt, no zoom. Reveal only a little beyond the right edge, "
     "and invent nothing to fill it."),
    ("orbit_left", "Orbit left",
     "Arc around the space to the left",
     "MOVEMENT: arc the camera slowly a short way to the LEFT around the "
     "subject, keeping the centre of the frame fixed and the horizon level. "
     "A small arc only. Do not travel far enough to need a side of anything "
     "the photograph does not show."),
    ("orbit_right", "Orbit right",
     "Arc around the space to the right",
     "MOVEMENT: arc the camera slowly a short way to the RIGHT around the "
     "subject, keeping the centre of the frame fixed and the horizon level. "
     "A small arc only. Do not travel far enough to need a side of anything "
     "the photograph does not show."),
    ("rise", "Rise",
     "Crane upward — best on exteriors",
     "MOVEMENT: raise the camera slowly and steadily UPWARD a short distance, "
     "as on a crane or drone, keeping the horizon level and the framing "
     "steady. Do not rotate or tilt. Do not invent roof, sky, garden or "
     "neighbouring property to fill the new height."),
    ("tilt_up", "Tilt up",
     "Reveal ceiling height",
     "MOVEMENT: tilt the camera slowly UPWARD through a small angle from a "
     "fixed position, showing the height of the space. No dolly movement, no "
     "rotation, no zoom. Invent no ceiling detail that is not already there."),
    ("static", "Hold",
     "Almost still — the safest of the nine",
     "MOVEMENT: hold the camera essentially still. Only the faintest, barely "
     "perceptible drift is allowed -- a locked-off shot that gives the still "
     "a sense of life without drawing attention to itself. This is the "
     "safest move: when in doubt, err toward this."),
]

MOVE_PROMPTS = {key: instruction for key, _, _, instruction in MOVES}
DEFAULT_MOVE = "push_in"

# The style cards are presets now, not the movement itself: picking one sets
# every clip's move, and any clip can then be changed. Same pattern as
# Scenery's "set all to" above its per-room buttons.
STYLE_DEFAULT_MOVE = {
    "drone": "rise",
    "walkthrough": "push_in",
    "basic": "static",
}


def prompt_for_clip(move=None, style=None):
    """The full prompt for one clip.

    Order matters and is deliberate: the constraint leads, the movement sits
    in the middle, and the constraint closes. A rule stated once, in the
    middle, is the one that gets dropped -- staging proved that, and video is
    the harder case because the model has a whole timeline to drift over.
    """
    key = (move or "").strip().lower()
    if key not in MOVE_PROMPTS:
        key = STYLE_DEFAULT_MOVE.get((style or "").strip().lower(), DEFAULT_MOVE)
    return " ".join([
        ONLY_THE_CAMERA,
        NEVER_CHANGE,
        NO_INVENTION,
        MOVE_PROMPTS[key],
        TEMPORAL,
        LOOK,
        ONLY_THE_CAMERA,
        NEVER_CHANGE,
        WHEN_UNSURE,
    ])


# Kept so a project with neither a move nor a style still renders something
# sane, and so older callers do not break.
STYLE_PROMPTS = {
    style: prompt_for_clip(move=move) for style, move in STYLE_DEFAULT_MOVE.items()
}
REAL_ESTATE_PROMPT = prompt_for_clip(move=DEFAULT_MOVE)


def prompt_for(style):
    """The prompt a whole-project style implies. Superseded by prompt_for_clip."""
    return prompt_for_clip(style=style)


# Atlas Cloud reports success as either word depending on the model.
DONE_STATUSES = ("completed", "succeeded")

POLL_INTERVAL = 5
POLL_TIMEOUT = 600


class VideoNotConfigured(Exception):
    """No Atlas Cloud API key available."""


class VideoError(Exception):
    """The provider rejected the request or the generation failed."""


def load_config():
    """Credentials and model choice, from the gitignored config or the env."""
    cfg = {}
    # A broken config file used to be swallowed and look exactly like a missing
    # one, which sent someone hunting for a key they had already pasted. Report
    # the parse error instead.
    config_error = None
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except ValueError as exc:
            config_error = f"studio/atlascloud.json isn't valid JSON: {exc}"
        except OSError as exc:
            config_error = f"could not read studio/atlascloud.json: {exc}"

    key = os.environ.get("ATLASCLOUD_API_KEY") or cfg.get("api_key") or ""
    # A pasted code sample rather than a key: long, or containing whitespace.
    if key and (len(key) > 200 or any(c.isspace() for c in key)):
        config_error = (
            "the api_key value doesn't look like a key -- it contains spaces or "
            "line breaks. Paste only the key itself, not the example code."
        )
        key = ""

    return {
        "api_key": key,
        "model": os.environ.get("ATLASCLOUD_MODEL") or cfg.get("model") or DEFAULT_MODEL,
        "rate_per_second": cfg.get("rate_per_second", DEFAULT_RATE_PER_SECOND),
        "rates": cfg.get("rates") or RATE_PER_SECOND,
        "config_error": config_error,
    }


def is_configured():
    return bool(load_config()["api_key"])


def _headers(cfg):
    return {"Authorization": f"Bearer {cfg['api_key']}"}


def _require(cfg):
    if not cfg["api_key"]:
        raise VideoNotConfigured(
            "Atlas Cloud isn't connected. Put an API key in studio/atlascloud.json "
            "(or set ATLASCLOUD_API_KEY)."
        )


def _explain(resp):
    if resp is None:
        return "no response from Atlas Cloud"
    # Worth naming plainly: it is not a bug, and the fix is a page on their
    # site rather than anything in this code. Same wording as staging uses.
    if resp.status_code == 402:
        return (
            "Atlas Cloud reports an insufficient balance -- the account has no "
            "credit. Video is metered (there is no free tier for it), so top "
            "up at atlascloud.ai before rendering."
        )
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}: {(resp.text or '')[:200]}"
    message = body.get("msg") or body.get("message") or body.get("error") or body
    return f"HTTP {resp.status_code}: {message}"


MIN_DURATION, MAX_DURATION = 4, 30

# Offered per clip. Not every number between 4 and 30 -- a dropdown of
# twenty-seven lengths is a worse control than one of eight.
DURATION_CHOICES = [4, 5, 6, 8, 10, 12, 15, 20, 30]
RESOLUTION_CHOICES = ["480p", "720p", "1080p"]

# 1080p because these go in front of buyers, and five seconds because that is
# a listing clip: long enough to read the room, short enough that six of them
# is still under a minute.
DEFAULT_DURATION = 5
DEFAULT_RESOLUTION = "1080p"


def rate_for(resolution, cfg=None):
    """Dollars per second of output at this resolution."""
    cfg = cfg or load_config()
    rates = cfg.get("rates") or RATE_PER_SECOND
    return float(rates.get(resolution, cfg["rate_per_second"]))


def estimate_cost(seconds, cfg=None, resolution=None):
    """Dollar cost of a clip, for warning before spending.

    Resolution is not optional in practice -- it is a 4x swing between 480p
    and 1080p -- but it defaults to the dearest tier rather than the cheapest
    so an omission overstates rather than understates.
    """
    cfg = cfg or load_config()
    return round(seconds * rate_for(resolution or "1080p", cfg), 3)


def upload_image(path, cfg=None):
    """Upload a local photo, returning the URL the model reads it from."""
    cfg = cfg or load_config()
    _require(cfg)

    with open(path, "rb") as fh:
        try:
            resp = requests.post(
                f"{BASE_URL}/model/uploadMedia",
                headers=_headers(cfg),
                files={"file": (os.path.basename(path), fh)},
                timeout=120,
            )
        except requests.RequestException as exc:
            raise VideoError(f"could not reach Atlas Cloud: {exc}") from exc

    if resp.status_code >= 400:
        raise VideoError(_explain(resp))
    try:
        body = resp.json()
    except ValueError as exc:
        raise VideoError("Atlas Cloud returned a response we could not read") from exc

    # Their upload returns the address under `download_url`, not `url` --
    # confirmed against a live upload. Both names are accepted because the
    # docs use `url` and this is exactly the kind of thing they rename.
    data = body.get("data") or {}
    url = (
        body.get("url")
        or data.get("url")
        or body.get("download_url")
        or data.get("download_url")
    )
    if not url:
        raise VideoError(f"no URL in the upload response: {body}")
    return url


def submit_clip(image_url, prompt=None, cfg=None, duration=5, resolution="720p",
                last_image=None, generate_audio=False, **extra):
    """Start a generation. Returns the prediction id to poll.

    Audio is off by default. The model will happily invent a soundtrack, it
    costs more, and a listing video gets music laid over it later anyway.

    `last_image` is worth knowing about: give it a second photo and the model
    generates the move between two real rooms, rather than animating one still.
    That is the difference between a slideshow with motion and a walkthrough.

    `extra` passes anything else straight through (watermark, output_format,
    return_last_frame, ratio).
    """
    cfg = cfg or load_config()
    _require(cfg)

    payload = {
        "model": cfg["model"],
        "prompt": prompt or REAL_ESTATE_PROMPT,
        # Their field is "image", not "image_url" -- an easy and silent mistake.
        "image": image_url,
        "duration": duration,
        "resolution": resolution,
        "generate_audio": generate_audio,
    }
    if last_image:
        payload["last_image"] = last_image
    payload.update({k: v for k, v in extra.items() if v is not None})

    try:
        resp = requests.post(
            f"{BASE_URL}/model/generateVideo",
            headers={**_headers(cfg), "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise VideoError(f"could not reach Atlas Cloud: {exc}") from exc

    if resp.status_code >= 400:
        raise VideoError(_explain(resp))
    try:
        body = resp.json()
    except ValueError as exc:
        raise VideoError("Atlas Cloud returned a response we could not read") from exc

    data = body.get("data") or body
    prediction_id = data.get("id") or data.get("prediction_id")
    if not prediction_id:
        raise VideoError(f"no prediction id in the response: {body}")
    return prediction_id


def check_clip(prediction_id, cfg=None):
    """Current state of a generation: {status, video_url, error, raw}."""
    cfg = cfg or load_config()
    _require(cfg)

    try:
        resp = requests.get(
            f"{BASE_URL}/model/prediction/{prediction_id}",
            headers=_headers(cfg),
            timeout=30,
        )
    except requests.RequestException as exc:
        raise VideoError(f"could not reach Atlas Cloud: {exc}") from exc

    if resp.status_code >= 400:
        raise VideoError(_explain(resp))
    body = resp.json()
    data = body.get("data") or body
    outputs = data.get("outputs") or []
    return {
        "status": data.get("status"),
        "video_url": outputs[0] if outputs else None,
        "error": data.get("error"),
        "raw": data,
    }


def wait_for_clip(prediction_id, cfg=None, timeout=POLL_TIMEOUT, on_tick=None):
    """Poll until the clip finishes. Only for scripts -- never a web request."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = check_clip(prediction_id, cfg)
        if on_tick:
            on_tick(state)
        # Their API reports success as either word depending on the model.
        if state["status"] in DONE_STATUSES:
            if not state["video_url"]:
                raise VideoError("generation finished but returned no video")
            return state
        if state["status"] == "failed":
            raise VideoError(state["error"] or "generation failed")
        time.sleep(POLL_INTERVAL)
    raise VideoError(f"gave up after {timeout}s; prediction {prediction_id} still running")


def download(video_url, dest_path):
    """Save a finished clip locally."""
    try:
        resp = requests.get(video_url, timeout=300, stream=True)
    except requests.RequestException as exc:
        raise VideoError(f"could not download the clip: {exc}") from exc
    if resp.status_code >= 400:
        raise VideoError(f"could not download the clip: HTTP {resp.status_code}")

    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    with open(dest_path, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65536):
            fh.write(chunk)
    return dest_path


def verify_connection():
    """Check the key works, without generating anything.

    Uploads a tiny throwaway image. That exercises authentication for real --
    a wrong key fails here exactly as it would on a generation -- but upload
    is not metered, so confirming the setup costs nothing.
    """
    import io as _io

    cfg = load_config()
    if cfg.get("config_error"):
        raise VideoNotConfigured(cfg["config_error"])
    _require(cfg)

    from PIL import Image

    buf = _io.BytesIO()
    Image.new("RGB", (16, 16), (200, 200, 200)).save(buf, format="JPEG")
    buf.seek(0)

    try:
        resp = requests.post(
            f"{BASE_URL}/model/uploadMedia",
            headers=_headers(cfg),
            files={"file": ("check.jpg", buf, "image/jpeg")},
            timeout=60,
        )
    except requests.RequestException as exc:
        raise VideoError(f"could not reach Atlas Cloud: {exc}") from exc

    if resp.status_code >= 400:
        raise VideoError(_explain(resp))

    return {
        "ok": True,
        "model": cfg["model"],
        "rate_per_second": cfg["rate_per_second"],
        "cost_5s_1080p": estimate_cost(5, cfg, "1080p"),
        "cost_5s_480p": estimate_cost(5, cfg, "480p"),
    }
