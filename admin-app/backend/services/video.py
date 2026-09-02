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

# What each model costs, offers and calls things.
#
# This exists because switching models is not just a string. Seedance takes a
# final frame as `last_image`; Kling calls it `end_image`. Seedance bills per
# resolution behind a flat-looking headline; Kling's tiers really are flat,
# because its cheapest tier already is the resolution you want. Kling accepts
# a negative prompt; Seedance does not. Getting any of those wrong is a silent
# failure or a surprise invoice.
#
#   rates       $/second, by resolution. A single value under "*" means flat.
#   resolutions what the UI may offer, best last.
#   last_frame  the field name for an end frame, or None if unsupported.
#   negative    whether a negative prompt is accepted.
MODELS = {
    "kwaivgi/kling-v3.0-pro/image-to-video": {
        "label": "Kling 3.0 Pro",
        "rates": {"*": 0.095},
        "resolutions": ["1080p"],
        "durations": [3, 4, 5, 6, 7, 8, 9, 10, 12, 15],
        "last_frame": "end_image",
        "negative": True,
        # Kling documents a 2,500-character prompt ceiling. Ours was 3,205.
        "max_prompt": 2500,
        # Kling says `sound`; Seedance says `generate_audio`.
        "audio_field": "sound",
    },
    "kwaivgi/kling-v3.0-std/image-to-video": {
        "label": "Kling 3.0 Standard",
        "rates": {"*": 0.071},
        "resolutions": ["720p", "1080p"],
        "durations": [3, 4, 5, 6, 7, 8, 9, 10, 12, 15],
        "last_frame": "end_image",
        "negative": True,
        "max_prompt": 2500,
        "audio_field": "sound",
    },
    "bytedance/seedance-2.5/image-to-video": {
        "label": "Seedance 2.5",
        # Measured, not quoted: $2.98438331 for 5s at 1080p. The headline
        # "$0.134/s" is the cheapest tier, not a flat rate.
        "rates": {"480p": 0.14, "720p": 0.30, "1080p": 0.597},
        "resolutions": ["480p", "720p", "1080p"],
        "durations": [4, 5, 6, 8, 10, 12, 15, 20, 30],
        "last_frame": "last_image",
        "negative": False,
        "max_prompt": 5000,
        "audio_field": "generate_audio",
    },
}

# Kling 3.0 Pro: native 1080p at a flat $0.095/s, against Seedance 2.5's
# $0.597/s at the same resolution -- about six times cheaper for the output
# that actually goes in front of a buyer.
DEFAULT_MODEL = "kwaivgi/kling-v3.0-pro/image-to-video"


def resolved_rates(cfg=None):
    """{resolution: $/second} for the configured model, expanded.

    A model with a flat rate stores it under "*"; the browser wants a rate per
    resolution it can look up, so it is expanded here rather than every caller
    remembering the wildcard.
    """
    cfg = cfg or load_config()
    info = model_info(cfg)
    rates = cfg.get("rates") or info["rates"]
    if "*" in rates:
        return {res: float(rates["*"]) for res in info["resolutions"]}
    return {res: float(rates.get(res, max(rates.values()))) for res in info["resolutions"]}


def model_info(cfg=None):
    """What the configured model costs and supports."""
    cfg = cfg or load_config()
    return MODELS.get(cfg["model"], {
        "label": cfg["model"],
        "rates": {"*": cfg.get("rate_per_second", DEFAULT_RATE_PER_SECOND)},
        "resolutions": ["720p", "1080p"],
        "durations": [4, 5, 6, 8, 10],
        "last_frame": "last_image",
        "negative": False,
        "max_prompt": 2500,
        "audio_field": "generate_audio",
    })

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

# Kling accepts a negative prompt, which is the bluntest instrument available
# for the compliance problem: the failures named directly, rather than a rule
# to be inferred from a paragraph.
NEGATIVE_PROMPT = (
    "new door, new doorway, new window, new wall, new room, extra door, "
    "extra window, added furniture, removed furniture, moved furniture, "
    "changed layout, changed architecture, different room, morphing, warping, "
    "melting, stretching, distorted geometry, bent walls, wobbling lines, "
    "flickering, colour shift, exposure shift, scene change, cut, "
    "people, person, pets, text, caption, subtitles, watermark, logo, "
    # Quality failures, named as directly as the structural ones. A negative
    # prompt is the one place "do not look cheap" can be said plainly.
    "blurry, soft focus, out of focus, motion blur, smeared detail, "
    "low resolution, upscaled, pixelated, compression artifacts, blocky, "
    "banding, noise, grain, oversharpened, halo, chromatic aberration, "
    "lens distortion, fisheye, vignette, lens flare, glare, bloom, "
    "washed out, overexposed, underexposed, colour cast, heavy grading, "
    "shallow depth of field, bokeh, tilt-shift, "
    "judder, stutter, jitter, camera shake, wobble, rolling shutter"
)

# How it should be SHOT -- and deliberately not how it should be graded.
#
# There is a real tension here. "Cinematic" usually means shallow depth of
# field, warm grading, lifted blacks, a flare. Every one of those changes how
# the property LOOKS, which is the thing that must not change: a kitchen that
# arrives warmer and moodier than the photograph is a prettier clip and a less
# honest one. So this asks only for what a good camera gives you without
# altering the subject -- sharpness, clean steady motion, no artefacts -- and
# the grading is left exactly as the photograph was taken.
#
# Kept tight on purpose. It shares a 2,500-character budget with the
# constraint, and an earlier, wordier version pushed the prompt over the limit
# and got itself dropped entirely by the fallback -- quality instructions that
# were never sent.
LOOK = (
    "Shot on a full-frame cinema camera with a sharp prime lens on a motorised "
    "slider. Crisp, high-detail footage: fine texture in flooring, fabric and "
    "stone resolved cleanly, edges sharp without haloing, architectural lines "
    "straight, everything in focus front to back. Motion slow, even and "
    "perfectly steady. Keep the photograph's own exposure, white balance and "
    "colour exactly as they are: do not grade it, and add no glow, flare, "
    "vignette or film effect. Clean and noise-free."
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


# The short form of NEVER_CHANGE, for models that take a negative prompt.
#
# The full enumeration is 733 characters and is stated twice -- 1,466 of a
# 2,500-character budget spent restating a list the negative prompt already
# carries. This keeps the categories, so the positive prompt still says what
# must not change, and leaves the itemising to the negative.
NEVER_CHANGE_SHORT = (
    "Do NOT add, remove, move, resize, restyle or re-colour anything in the "
    "property at any point in the clip: no walls, doors, doorways, windows, "
    "cabinetry, fixtures, fittings, flooring, furniture or objects. Do not "
    "open or close anything. Do not change any visible text or sign, or what "
    "is seen through any window, doorway or mirror."
)


def prompt_for_clip(move=None, style=None, cfg=None):
    """The full prompt for one clip.

    Order matters and is deliberate: the constraint leads, the movement sits
    in the middle, and the constraint closes. A rule stated once, in the
    middle, is the one that gets dropped -- staging proved that, and video is
    the harder case because the model has a whole timeline to drift over.
    """
    key = (move or "").strip().lower()
    if key not in MOVE_PROMPTS:
        key = STYLE_DEFAULT_MOVE.get((style or "").strip().lower(), DEFAULT_MOVE)

    limit = model_info(cfg).get("max_prompt", 2500)

    full = " ".join([
        ONLY_THE_CAMERA, NEVER_CHANGE, NO_INVENTION, MOVE_PROMPTS[key],
        TEMPORAL, LOOK, ONLY_THE_CAMERA, NEVER_CHANGE, WHEN_UNSURE,
    ])
    if len(full) <= limit:
        return full

    # Over the ceiling. Truncating would cut the CLOSING constraint, which is
    # the half that does the work -- so shorten deliberately instead: the
    # itemised ban moves to the negative prompt, the categories stay, and the
    # constraint still opens and closes.
    short = " ".join([
        ONLY_THE_CAMERA, NEVER_CHANGE_SHORT, NO_INVENTION, MOVE_PROMPTS[key],
        TEMPORAL, LOOK, NEVER_CHANGE_SHORT, WHEN_UNSURE,
    ])
    if len(short) <= limit:
        return short

    # Still over: drop the look, never the constraint.
    return " ".join([
        ONLY_THE_CAMERA, NEVER_CHANGE_SHORT, NO_INVENTION, MOVE_PROMPTS[key],
        LOOK, NEVER_CHANGE_SHORT,
    ])[:limit]


# Kept so a project with neither a move nor a style still renders something
# sane, and so older callers do not break.
# Built at import time, so they must not reach load_config -- which is defined
# below. An explicit model dict keeps model_info from looking one up.
_BOOT_CFG = {"model": DEFAULT_MODEL}

STYLE_PROMPTS = {
    style: prompt_for_clip(move=move, cfg=_BOOT_CFG)
    for style, move in STYLE_DEFAULT_MOVE.items()
}
REAL_ESTATE_PROMPT = prompt_for_clip(move=DEFAULT_MOVE, cfg=_BOOT_CFG)


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
        # An explicit table in the config still wins, for a model this
        # registry does not know about.
        "rates": cfg.get("rates") or {},
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
    """Dollars per second of output at this resolution, for this model."""
    cfg = cfg or load_config()
    rates = (cfg.get("rates") or {}) or model_info(cfg)["rates"]
    if "*" in rates:
        return float(rates["*"])
    return float(rates.get(resolution, max(rates.values()) if rates
                           else cfg["rate_per_second"]))


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


# A warning for anyone probing this API by hand: POSTing {"model": ...} with
# nothing else does NOT return a validation error. It CREATES a prediction,
# which then fails for having no content. Probe with an empty body instead --
# that is rejected on the missing model field before anything is made.
def submit_clip(image_url, prompt=None, cfg=None, duration=5, resolution="1080p",
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
    }
    info = model_info(cfg)
    # Audio off, under whatever this model calls it. A listing video gets music
    # laid over it later, and audio costs about 50% more.
    payload[info.get("audio_field", "generate_audio")] = generate_audio
    if last_image and info["last_frame"]:
        # Seedance says last_image, Kling says end_image. Sending the wrong one
        # is silently ignored -- the clip generates unanchored and invents.
        payload[info["last_frame"]] = last_image
    if info["negative"]:
        payload["negative_prompt"] = NEGATIVE_PROMPT
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


def clip_cost(job, clip):
    """What one delivered clip cost, at the current rate for its model.

    Lives here rather than in the route that first needed it, because spend
    is now asked for from three places and three implementations of it would
    drift. Rounded to cents at the clip, which is the unit that gets billed:
    rounding later instead lets the same money add up to two different
    totals depending on where the sum was taken.

    Returns 0.0 for a model with no rate rather than guessing one -- a wrong
    number under a dollar sign is worse than a missing one.
    """
    cfg = MODELS.get(job.model)
    if not cfg:
        return 0.0
    return round(estimate_cost(
        clip.get("duration") or job.duration,
        cfg,
        clip.get("resolution") or job.resolution,
    ), 2)


def job_spend(job):
    """What a render actually cost: its DELIVERED clips only.

    A clip that failed before producing a file is not money spent.
    """
    return round(sum(clip_cost(job, c) for c in (job.clips or [])
                     if c.get("video_url")), 2)
