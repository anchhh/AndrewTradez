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

# Per second of output, used only to warn before spending. Atlas Cloud quoted
# ~$0.134/s for Seedance 2.5 in August 2026; check the live figure before
# trusting an estimate for anything larger than a test.
DEFAULT_RATE_PER_SECOND = 0.134

# What a listing clip should ask for.
#
# The important half is the constraint, and staging taught why: an agent cannot
# send a client a video where the kitchen rearranges itself, and a model given
# only a style instruction will happily invent a doorway on its way past. So
# the same shape is used here as in services/staging.py -- the rule is stated
# before AND after the movement, and it names what must not change rather than
# implying it.
#
# The difference from staging is that here the constraint covers time as well
# as content: the room must be the same room in frame 1 and frame 120.
HOLD_THE_ROOM = (
    "Do not add, remove, move or restyle anything in the scene: no furniture, "
    "walls, doors, doorways, windows, cabinetry, counters, sinks, appliances, "
    "fixtures or fittings may change, appear or disappear at any point in the "
    "clip. Do not change the wall colours, the flooring, or the view through "
    "any window. Nothing may morph, warp or drift between frames -- the room "
    "must be recognisably the same room from the first frame to the last. "
    "No people, no pets, no text, no captions, no watermark, no logos."
)

LOOK = (
    "Photorealistic real-estate listing footage. Natural light, steady "
    "exposure, no flicker, no vignette pulsing, no lens distortion."
)

# One per style card on the style page, so choosing "Drone" actually changes
# the footage rather than only the label stored on the project.
STYLE_PROMPTS = {
    "drone": (
        HOLD_THE_ROOM + " "
        "Smooth aerial drone move over and around the property: a slow, "
        "steady rise or orbit that reveals the house and its lot. Cinematic, "
        "level horizon, no sudden acceleration. " + LOOK + " " + HOLD_THE_ROOM
    ),
    "walkthrough": (
        HOLD_THE_ROOM + " "
        "Slow, smooth dolly move forward through the space, as though walking "
        "it at an even pace with a stabilised camera. Steady height, level "
        "framing, no hand-held shake and no rotation of the room around the "
        "camera. " + LOOK + " " + HOLD_THE_ROOM
    ),
    "basic": (
        HOLD_THE_ROOM + " "
        "A gentle, almost imperceptible camera move on the still: a slow push "
        "in or a slow lateral pan, of the kind used to give a listing photo "
        "life without drawing attention to itself. " + LOOK + " "
        + HOLD_THE_ROOM
    ),
}

# The fallback, and what a project with no style chosen gets.
REAL_ESTATE_PROMPT = STYLE_PROMPTS["walkthrough"]


def prompt_for(style):
    """The prompt for a style card, falling back to the walkthrough."""
    return STYLE_PROMPTS.get((style or "").strip().lower(), REAL_ESTATE_PROMPT)


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


def estimate_cost(seconds, cfg=None):
    """Rough dollar cost of a clip, for warning before spending."""
    cfg = cfg or load_config()
    return round(seconds * float(cfg["rate_per_second"]), 3)


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
        "cost_5s": estimate_cost(5, cfg),
    }
