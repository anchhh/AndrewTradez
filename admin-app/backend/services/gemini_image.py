"""
Staging a room through Google's Gemini image model.

The reason this exists alongside the Atlas Cloud path is money: Gemini's free
tier covers ~500 images a day at 1024x1024, which is more than a listing needs
and more than a whole style sweep costs. Atlas Cloud resells the same family of
models with a markup and no free tier.

Two things differ from the Atlas path and both simplify it:

  * it is synchronous -- the finished image comes back in the response, so
    there is no prediction id and nothing to poll
  * the image goes up inline as base64 rather than being uploaded first

What does not differ is the prompt. Style prompts live in services.staging and
are shared, so switching provider changes the bill and not the output.
"""
import base64
import json
import mimetypes
import os

import requests

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "gemini.json"
)

# The free-tier image model. Google's newer image models are paid-only, so
# "upgrading" this string is what would start a bill -- it is config for that
# reason, but the default is deliberately the free one.
DEFAULT_MODEL = "gemini-2.5-flash-image"

# Roughly what the free tier allows per day. Not enforced here -- Google
# enforces it -- but used to warn before a run that would obviously exceed it.
FREE_TIER_DAILY_IMAGES = 500


class GeminiNotConfigured(Exception):
    """No Gemini API key available."""


class GeminiError(Exception):
    """Google rejected the request or returned no image."""


def load_config():
    cfg = {}
    config_error = None
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except ValueError as exc:
            config_error = f"studio/gemini.json isn't valid JSON: {exc}"
        except OSError as exc:
            config_error = f"could not read studio/gemini.json: {exc}"

    key = os.environ.get("GEMINI_API_KEY") or cfg.get("api_key") or ""
    if key and (len(key) > 200 or any(c.isspace() for c in key)):
        config_error = (
            "the api_key value doesn't look like a key -- it contains spaces or "
            "line breaks. Paste only the key itself, not the example code."
        )
        key = ""

    return {
        "api_key": key,
        "model": os.environ.get("GEMINI_IMAGE_MODEL") or cfg.get("model") or DEFAULT_MODEL,
        "config_error": config_error,
    }


def is_configured():
    return bool(load_config()["api_key"])


def _explain(resp):
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}: {(resp.text or '')[:200]}"
    error = body.get("error") or {}
    message = error.get("message") or body
    # The two failures worth naming, because neither is a bug in this code and
    # each has a different fix.
    if resp.status_code == 429:
        return (
            "Gemini's free-tier limit is used up for today (about "
            f"{FREE_TIER_DAILY_IMAGES} images). It resets at midnight Pacific. "
            f"({message})"
        )
    if resp.status_code == 403:
        return (
            "Gemini refused the key. Check it is enabled for the Generative "
            f"Language API in Google AI Studio. ({message})"
        )
    return f"HTTP {resp.status_code}: {message}"


def edit_image(local_path, prompt, cfg=None, timeout=180):
    """Send one photo plus a prompt, return the finished image bytes.

    Blocking, and that is fine -- it already runs on a worker thread, and
    there is no polling to do because Google answers with the image itself.
    """
    cfg = cfg or load_config()
    if not cfg["api_key"]:
        raise GeminiNotConfigured(
            "Gemini isn't connected. Put an API key in studio/gemini.json "
            "(or set GEMINI_API_KEY)."
        )

    mime = mimetypes.guess_type(local_path)[0] or "image/jpeg"
    with open(local_path, "rb") as fh:
        encoded = base64.b64encode(fh.read()).decode("ascii")

    return _edit(encoded, mime, prompt, cfg, timeout)


def edit_bytes(image_bytes, prompt, cfg=None, timeout=180):
    """Same, but editing an image already in memory.

    This is what makes refinement possible: the second pass edits the FIRST
    pass's output rather than starting again from the original photo.
    """
    cfg = cfg or load_config()
    if not cfg["api_key"]:
        raise GeminiNotConfigured("Gemini isn't connected.")
    return _edit(base64.b64encode(image_bytes).decode("ascii"), "image/jpeg",
                 prompt, cfg, timeout)


def edit_with_references(local_path, prompt, reference_paths=(), cfg=None,
                         timeout=240, model=None, image_size=None):
    """Edit one photo with others alongside it for context.

    The first image is the one being edited; the rest are shown to the model
    so it can see the property's real colours and light. Order matters and is
    stated in the prompt -- the model has no other way to know which of four
    pictures it is meant to hand back.
    """
    cfg = cfg or load_config()
    if not cfg["api_key"]:
        raise GeminiNotConfigured(
            "Gemini isn't connected. Put an API key in studio/gemini.json "
            "(or set GEMINI_API_KEY)."
        )

    parts = [{"text": prompt}]
    for path in [local_path, *reference_paths]:
        mime = mimetypes.guess_type(path)[0] or "image/jpeg"
        with open(path, "rb") as fh:
            parts.append({"inline_data": {
                "mime_type": mime,
                "data": base64.b64encode(fh.read()).decode("ascii"),
            }})

    generation = {"responseModalities": ["IMAGE", "TEXT"]}
    if image_size:
        # Only the newer image models honour this; the older one silently
        # returns its usual ~1MP either way, so passing it is never harmful.
        generation["imageConfig"] = {"imageSize": image_size}

    return _send({"contents": [{"parts": parts}], "generationConfig": generation},
                 cfg, timeout, model=model)


def _edit(encoded, mime, prompt, cfg, timeout):

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": mime, "data": encoded}},
                ]
            }
        ],
        # Without this the model answers with a description of the staged room
        # rather than the staged room, which looks like a silent failure.
        "generationConfig": {"responseModalities": ["IMAGE", "TEXT"]},
    }

    return _send(payload, cfg, timeout)


def _send(payload, cfg, timeout, model=None):
    # A caller may name a different model than the configured one: staging and
    # the capture enhancer want different things, and one of them changing
    # should not move the other's bill.
    url = f"{BASE_URL}/models/{model or cfg['model']}:generateContent"
    try:
        resp = requests.post(
            url,
            headers={"Content-Type": "application/json", "x-goog-api-key": cfg["api_key"]},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise GeminiError(f"could not reach Gemini: {exc}") from exc

    if resp.status_code >= 400:
        raise GeminiError(_explain(resp))

    try:
        body = resp.json()
    except ValueError as exc:
        raise GeminiError("Gemini returned a response we could not read") from exc

    candidates = body.get("candidates") or []
    if not candidates:
        # A refusal arrives as an empty candidate list with a reason attached.
        reason = (body.get("promptFeedback") or {}).get("blockReason")
        raise GeminiError(f"Gemini returned no image{f' ({reason})' if reason else ''}")

    for part in (candidates[0].get("content") or {}).get("parts") or []:
        blob = part.get("inline_data") or part.get("inlineData")
        if blob and blob.get("data"):
            return base64.b64decode(blob["data"])

    # Text came back but no image -- usually the model declining the edit.
    text = " ".join(
        p.get("text", "") for p in (candidates[0].get("content") or {}).get("parts") or []
    ).strip()
    raise GeminiError(f"Gemini answered without an image{f': {text[:180]}' if text else ''}")


def verify_connection():
    """Confirm the key works, using the cheapest call that proves it.

    Lists models rather than generating: a wrong key fails here exactly as it
    would on a generation, and listing does not touch the daily image quota.
    """
    cfg = load_config()
    if cfg.get("config_error"):
        raise GeminiNotConfigured(cfg["config_error"])
    if not cfg["api_key"]:
        raise GeminiNotConfigured("No Gemini API key set.")

    try:
        resp = requests.get(
            f"{BASE_URL}/models",
            headers={"x-goog-api-key": cfg["api_key"]},
            timeout=30,
        )
    except requests.RequestException as exc:
        raise GeminiError(f"could not reach Gemini: {exc}") from exc

    if resp.status_code >= 400:
        raise GeminiError(_explain(resp))

    names = [m.get("name", "") for m in (resp.json().get("models") or [])]
    return {
        "ok": True,
        "model": cfg["model"],
        "model_available": any(cfg["model"] in n for n in names),
        "models_seen": len(names),
    }


def ask_about_image(image_bytes, question, cfg=None, timeout=90):
    """Ask a text question about an image and return the answer.

    Used to check the model's own work. The same free tier covers it, and a
    text answer is far cheaper than the image that prompted the question.
    """
    cfg = cfg or load_config()
    if not cfg["api_key"]:
        raise GeminiNotConfigured("Gemini isn't connected.")

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": question},
                    {"inline_data": {"mime_type": "image/jpeg",
                                     "data": base64.b64encode(image_bytes).decode("ascii")}},
                ]
            }
        ],
        # Text only here -- asking for IMAGE back would generate one.
        "generationConfig": {"responseModalities": ["TEXT"]},
    }

    try:
        resp = requests.post(
            f"{BASE_URL}/models/{cfg['model']}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": cfg["api_key"]},
            json=payload,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise GeminiError(f"could not reach Gemini: {exc}") from exc

    if resp.status_code >= 400:
        raise GeminiError(_explain(resp))

    candidates = resp.json().get("candidates") or []
    if not candidates:
        return ""
    return " ".join(
        part.get("text", "")
        for part in (candidates[0].get("content") or {}).get("parts") or []
    ).strip()


def ask_about_images(images, question, cfg=None, timeout=180):
    """Ask one question about SEVERAL images at once.

    Needed for layout analysis, where the point is comparing photographs with
    each other -- which room adjoins which -- rather than judging one on its
    own. Sent as contact sheets, so a whole listing is two images.
    """
    cfg = cfg or load_config()
    if not cfg["api_key"]:
        raise GeminiNotConfigured("Gemini isn't connected.")

    parts = [{"text": question}]
    for blob in images:
        parts.append({"inline_data": {"mime_type": "image/jpeg",
                                      "data": base64.b64encode(blob).decode("ascii")}})

    try:
        resp = requests.post(
            f"{BASE_URL}/models/{cfg['model']}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": cfg["api_key"]},
            json={"contents": [{"parts": parts}],
                  "generationConfig": {"responseModalities": ["TEXT"]}},
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise GeminiError(f"could not reach Gemini: {exc}") from exc

    if resp.status_code >= 400:
        raise GeminiError(_explain(resp))

    candidates = resp.json().get("candidates") or []
    if not candidates:
        return ""
    return " ".join(
        part.get("text", "")
        for part in (candidates[0].get("content") or {}).get("parts") or []
    ).strip()
