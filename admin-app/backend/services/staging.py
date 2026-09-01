"""
Virtual staging: a room photo in, the same room furnished (or emptied) out.

This is deliberately NOT the video generator with a different noun. A clip is
allowed to reinterpret a room a little because it is in motion for five
seconds. A staged still goes in front of a buyer next to the real photo, and
if the window moved, the agent cannot use it. So everything here is bent
toward one thing: change the furniture, leave the building alone.

Which is why the model is an *edit* model rather than a text-to-image one.
Text-to-image invents a plausible living room; edit models stay anchored to
the photo you hand them. That distinction matters more here than the price
difference between any two models.
"""
import json
import os

import requests

BASE_URL = "https://api.atlascloud.ai/api/v1"

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "atlascloud.json"
)

# Google's edit model. Chosen for staging because edit models keep the input's
# geometry, and this one holds a room's lines straight while replacing what
# stands in it. Config, not code -- `image_model` in studio/atlascloud.json.
DEFAULT_MODEL = "google/nano-banana-2/edit"

# Per image, for warning before spending. $0.08 at 1K for nano-banana-2 as of
# September 2026. Re-check before trusting an estimate on a large batch.
DEFAULT_RATE_PER_IMAGE = 0.08

DONE_STATUSES = ("completed", "succeeded")

# The half of every prompt that does not change. Repeated into each style
# rather than concatenated loosely, and placed last, because a constraint
# buried mid-prompt is the one that gets ignored.
KEEP = (
    "Keep the room's architecture exactly as it is: walls, windows, doors, "
    "ceiling, flooring, built-ins, light fixtures, and the view through every "
    "window must be unchanged. Do not move the camera, change the lens, or "
    "alter the lighting direction. Photorealistic, natural light, "
    "real-estate listing quality. No people, no pets, no text, no watermark."
)

STYLE_PROMPTS = {
    # The inverse job, and one agents ask for constantly: an occupied house
    # photographs as somebody else's home. Emptying it is how a buyer pictures
    # their own furniture in the room.
    "unfurnished": (
        "Remove all furniture, rugs, curtains, plants, artwork, clutter and "
        "personal belongings from this room, leaving it completely empty. "
        "Reconstruct the floor and walls that were hidden behind them so the "
        "empty room looks naturally photographed, not erased. " + KEEP
    ),
    "modern": (
        "Furnish this empty room in a modern style: clean lines, a neutral "
        "palette, low-profile furniture, minimal decor. " + KEEP
    ),
    "scandinavian": (
        "Furnish this empty room in a Scandinavian style: pale wood, soft "
        "textiles, white and muted tones, uncluttered and airy. " + KEEP
    ),
    "traditional": (
        "Furnish this empty room in a traditional style: classic wood "
        "furniture, warm tones, symmetrical arrangement, tailored upholstery. "
        + KEEP
    ),
    "coastal": (
        "Furnish this empty room in a coastal style: light blues and whites, "
        "natural fibres, linen, relaxed and airy. " + KEEP
    ),
    "farmhouse": (
        "Furnish this empty room in a modern farmhouse style: reclaimed wood, "
        "shaker forms, warm neutrals, woven textures. " + KEEP
    ),
    "industrial": (
        "Furnish this empty room in an industrial style: metal and dark wood, "
        "leather, exposed textures, a muted charcoal palette. " + KEEP
    ),
    "midcentury": (
        "Furnish this empty room in a mid-century modern style: tapered legs, "
        "walnut, olive and mustard accents, organic curves. " + KEEP
    ),
    "minimal": (
        "Furnish this empty room minimally: very few pieces, deliberately "
        "sparse, plenty of visible floor, restrained neutral palette. " + KEEP
    ),
    "luxury": (
        "Furnish this empty room in a luxury style: statement furniture, rich "
        "materials, marble and brass accents, layered lighting. " + KEEP
    ),
}


class StagingNotConfigured(Exception):
    """No Atlas Cloud API key available."""


class StagingError(Exception):
    """The provider rejected the request or the generation failed."""


def load_config():
    """Credentials and model choice. Shares the file the video generator uses.

    One Atlas Cloud account, one key, two models -- so `model` stays the video
    model and `image_model` is read separately. A single `model` key would mean
    one feature silently pointing at the other's model.
    """
    cfg = {}
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
    if key and (len(key) > 200 or any(c.isspace() for c in key)):
        config_error = (
            "the api_key value doesn't look like a key -- it contains spaces or "
            "line breaks. Paste only the key itself, not the example code."
        )
        key = ""

    # Which service actually generates. Gemini's free tier covers ~500 images
    # a day, which is more than a listing needs, so it is the default when a
    # Gemini key exists and Atlas Cloud is the fallback rather than the other
    # way round. Set "provider" explicitly to override.
    provider = (os.environ.get("STAGING_PROVIDER") or cfg.get("provider") or "").strip()
    if not provider:
        from services import gemini_image

        provider = "gemini" if gemini_image.is_configured() else "atlas"

    return {
        "provider": provider,
        "api_key": key,
        "model": (
            os.environ.get("ATLASCLOUD_IMAGE_MODEL")
            or cfg.get("image_model")
            or DEFAULT_MODEL
        ),
        "rate_per_image": cfg.get("rate_per_image", DEFAULT_RATE_PER_IMAGE),
        # Merged into every generation request. This is where a resolution
        # goes once we know what the field is called: nano-banana-2 is $0.08
        # at 1K but $0.12 at 2K and $0.16 at 4K, so pinning it to 1K is worth
        # up to half the bill. Nothing is sent by default -- inventing a field
        # name would fail the request rather than save money, and the docs are
        # not public. The first real run's response will name it.
        "params": cfg.get("image_params") or {},
        "config_error": config_error,
    }


def is_configured(cfg=None):
    """Whether staging can run at all -- on whichever provider is selected."""
    cfg = cfg or load_config()
    if cfg["provider"] == "gemini":
        from services import gemini_image

        return gemini_image.is_configured()
    return bool(cfg["api_key"])


def not_configured_message(cfg=None):
    cfg = cfg or load_config()
    if cfg["provider"] == "gemini":
        from services import gemini_image

        return gemini_image.load_config().get("config_error") or (
            "Gemini isn't connected. Put an API key in studio/gemini.json "
            "(or set GEMINI_API_KEY). The free tier covers ~500 images a day."
        )
    return cfg.get("config_error") or (
        "Staging isn't connected. Add an Atlas Cloud key to "
        "studio/atlascloud.json, or a free Gemini key to studio/gemini.json."
    )


def estimate_cost(count, cfg=None):
    """Dollar cost of staging `count` rooms, for showing before spending.

    Zero on Gemini: its free tier covers far more images per day than a
    listing uses. Quoting Atlas Cloud's rate while running on Gemini would be
    a scarier number than the truth.
    """
    cfg = cfg or load_config()
    if cfg.get("provider") == "gemini":
        return 0.0
    return round(count * float(cfg["rate_per_image"]), 3)


def prompt_for(style):
    return STYLE_PROMPTS.get(style) or STYLE_PROMPTS["modern"]


def _headers(cfg):
    return {"Authorization": "Bearer " + cfg["api_key"]}


def _require(cfg):
    if not cfg["api_key"]:
        raise StagingNotConfigured(
            "Atlas Cloud isn't connected. Put an API key in studio/atlascloud.json "
            "(or set ATLASCLOUD_API_KEY)."
        )


def _explain(resp):
    if resp is None:
        return "no response from Atlas Cloud"
    # Worth naming plainly: it is not a bug, and the fix is a page on their
    # site rather than anything in this code.
    if resp.status_code == 402:
        return (
            "Atlas Cloud reports an insufficient balance -- the account has no "
            "credit. Top it up at atlascloud.ai and try again."
        )
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}: {(resp.text or '')[:200]}"
    message = body.get("msg") or body.get("message") or body.get("error") or body
    return f"HTTP {resp.status_code}: {message}"


def submit_stage(image_url, style, cfg=None, prompt=None, **extra):
    """Start one staging generation. Returns the prediction id to poll."""
    cfg = cfg or load_config()
    _require(cfg)

    payload = {
        "model": cfg["model"],
        "prompt": prompt or prompt_for(style),
        # Same field name the video endpoint uses -- "image", not "image_url".
        "image": image_url,
    }
    payload.update(cfg.get("params") or {})
    payload.update({k: v for k, v in extra.items() if v is not None})

    try:
        resp = requests.post(
            BASE_URL + "/model/generateImage",
            headers={**_headers(cfg), "Content-Type": "application/json"},
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise StagingError(f"could not reach Atlas Cloud: {exc}") from exc

    if resp.status_code >= 400:
        raise StagingError(_explain(resp))
    try:
        body = resp.json()
    except ValueError as exc:
        raise StagingError("Atlas Cloud returned a response we could not read") from exc

    data = body.get("data") or body
    prediction_id = data.get("id") or data.get("prediction_id")
    if not prediction_id:
        raise StagingError(f"no prediction id in the response: {body}")
    return prediction_id


def check_stage(prediction_id, cfg=None):
    """Current state of a generation: {status, image_url, error, raw}."""
    cfg = cfg or load_config()
    _require(cfg)

    try:
        resp = requests.get(
            BASE_URL + "/model/prediction/" + str(prediction_id),
            headers=_headers(cfg),
            timeout=30,
        )
    except requests.RequestException as exc:
        raise StagingError(f"could not reach Atlas Cloud: {exc}") from exc

    if resp.status_code >= 400:
        raise StagingError(_explain(resp))
    body = resp.json()
    data = body.get("data") or body
    outputs = data.get("outputs") or []
    return {
        "status": data.get("status"),
        "image_url": outputs[0] if outputs else None,
        "error": data.get("error"),
        "raw": data,
    }


def download(image_url, dest_path):
    """Save a finished still locally, so it outlives the provider's retention."""
    try:
        resp = requests.get(image_url, timeout=120, stream=True)
    except requests.RequestException as exc:
        raise StagingError(f"could not download the image: {exc}") from exc
    if resp.status_code >= 400:
        raise StagingError(f"could not download the image: HTTP {resp.status_code}")

    os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
    with open(dest_path, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65536):
            fh.write(chunk)
    return dest_path


def stage_room(local_path, style, cfg=None):
    """Stage one room and return the finished image bytes.

    Blocking, and both providers are hidden behind it. Gemini answers with the
    image directly; Atlas Cloud has to be uploaded to, submitted to, polled and
    downloaded from. The caller wants bytes either way.
    """
    import time

    cfg = cfg or load_config()
    prompt = prompt_for(style)

    if cfg["provider"] == "gemini":
        from services import gemini_image

        try:
            return gemini_image.edit_image(local_path, prompt)
        except gemini_image.GeminiNotConfigured as exc:
            raise StagingNotConfigured(str(exc)) from exc
        except gemini_image.GeminiError as exc:
            raise StagingError(str(exc)) from exc

    from services.video import upload_image

    image_url = upload_image(local_path, cfg)
    prediction_id = submit_stage(image_url, style, cfg=cfg, prompt=prompt)

    deadline = time.time() + 420
    while time.time() < deadline:
        state = check_stage(prediction_id, cfg)
        if state["status"] in DONE_STATUSES:
            if not state["image_url"]:
                raise StagingError("generation finished but returned no image")
            resp = requests.get(state["image_url"], timeout=120)
            if resp.status_code >= 400:
                raise StagingError(f"could not download the image: HTTP {resp.status_code}")
            return resp.content
        if state["status"] == "failed":
            raise StagingError(state["error"] or "generation failed")
        time.sleep(4)

    raise StagingError("gave up after 420s; the generation was still running")
