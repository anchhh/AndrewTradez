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

# What a listing clip should ask for. The important half is the second half:
# an agent cannot send a client a video where the kitchen rearranges itself,
# so the prompt leans hard on leaving the room alone. Whether the model
# actually obeys is the thing worth testing before building on it.
REAL_ESTATE_PROMPT = (
    "Slow, smooth, steady cinematic camera move through the space. "
    "Real estate listing footage, photorealistic, natural daylight. "
    "Keep the architecture, furniture, fixtures and layout exactly as they are. "
    "Do not add, remove, or rearrange anything in the room. No people, no text."
)

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
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except (OSError, ValueError):
            cfg = {}
    return {
        "api_key": os.environ.get("ATLASCLOUD_API_KEY") or cfg.get("api_key") or "",
        "model": os.environ.get("ATLASCLOUD_MODEL") or cfg.get("model") or DEFAULT_MODEL,
        "rate_per_second": cfg.get("rate_per_second", DEFAULT_RATE_PER_SECOND),
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
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}: {(resp.text or '')[:200]}"
    message = body.get("message") or body.get("error") or body
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

    url = body.get("url") or (body.get("data") or {}).get("url")
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
