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

# The constraint half of every prompt. It is deliberately long, deliberately
# specific, and repeated into every style rather than concatenated loosely.
#
# The reason is observed failure, not caution: earlier runs invented a door
# that did not exist, deleted a sink, and added wall sconces to a room with
# none. A staged photo goes to a buyer as a picture of a real property, so a
# room that gains a door is not a style choice, it is a misrepresentation --
# and the agent, not the model, carries that.
#
# Three things make it stick, all of them worth keeping:
#   * the rule is stated before AND after the styling instruction, because a
#     constraint buried in the middle is the one that gets dropped
#   * the forbidden changes are enumerated rather than implied -- "keep the
#     architecture" is agreed with and then ignored; "do not add or remove
#     doors" is specific enough to actually bind
#   * it names what MAY change, so the model has a clear licence and does not
#     have to guess where the line is
CHANGE_ONLY = (
    "You may ONLY change loose furnishings: freestanding furniture, rugs, "
    "cushions, throws, curtains, bedding, table lamps, floor lamps, plants, "
    "books, and small decorative objects on surfaces."
)

NEVER_CHANGE = (
    "You must NOT change the building in any way. Specifically, do NOT add, "
    "remove, move, resize or restyle any of the following: walls, doors, "
    "doorways, archways, openings, windows, window frames, glazing bars, "
    "skylights, ceilings, ceiling height, floors, flooring material, stairs, "
    "railings, columns, beams, fireplaces, mantels, built-in shelving, "
    "cabinetry, countertops, islands, sinks, taps, plumbing, appliances, "
    "radiators, vents, ducts, thermostats, light switches, power outlets, "
    "ceiling lights, wall lights, sconces, recessed lights, skirting boards, "
    "baseboards, trim, mouldings, or any pipe, cable or conduit on a wall. "
    "Do not paint, retexture or re-colour any wall, ceiling or floor. "
    "Do not change what is visible through a window or a doorway. "
    "Do not add a mirror, a window or a doorway that is not already there."
)

FIDELITY = (
    "This is a photograph of a real property and it must stay truthful to it. "
    "Keep the exact same camera position, angle, lens and framing. Keep the "
    "existing lighting direction, colour temperature and shadows. "
    "Photorealistic, real-estate listing quality. "
    "No people, no pets, no text, no logos, no watermark. "
    "If you are unsure whether something is furniture or part of the "
    "building, treat it as part of the building and leave it alone."
)

# Stated first, so the model reads the constraint before the instruction.
PREFIX = NEVER_CHANGE + " " + CHANGE_ONLY + " "

# ...and again last, where it is weighted most.
KEEP = " " + CHANGE_ONLY + " " + NEVER_CHANGE + " " + FIDELITY


def _style(instruction):
    """Wrap a style instruction in the constraints, front and back."""
    return PREFIX + instruction + KEEP


STYLE_PROMPTS = {
    # The inverse job, and one agents ask for constantly: an occupied house
    # photographs as somebody else's home. Emptying it is how a buyer pictures
    # their own furniture in the room. It is also the safest of these to
    # publish, because removing furniture cannot invent a feature.
    "unfurnished": _style(
        "Remove all freestanding furniture, rugs, curtains, plants, artwork, "
        "clutter and personal belongings from this room, leaving it "
        "completely empty. Reconstruct the floor, walls and skirting that "
        "were hidden behind them exactly as the surrounding surfaces look, so "
        "the empty room appears naturally photographed rather than erased. "
        "Built-in and fixed items stay: leave cabinetry, counters, sinks, "
        "appliances, radiators and light fittings exactly where they are."
    ),
    "modern": _style(
        "Furnish this room in a modern style: clean lines, a neutral palette, "
        "low-profile freestanding furniture, minimal decor."
    ),
    "scandinavian": _style(
        "Furnish this room in a Scandinavian style: pale wood freestanding "
        "furniture, soft textiles, white and muted tones, uncluttered and airy."
    ),
    "traditional": _style(
        "Furnish this room in a traditional style: classic wood freestanding "
        "furniture, warm tones, symmetrical arrangement, tailored upholstery."
    ),
    "coastal": _style(
        "Furnish this room in a coastal style: light blues and whites, natural "
        "fibres, linen, rattan, relaxed and airy freestanding furniture."
    ),
    "farmhouse": _style(
        "Furnish this room in a modern farmhouse style: reclaimed wood, shaker "
        "forms, warm neutrals, woven textures, freestanding furniture only."
    ),
    "industrial": _style(
        "Furnish this room in an industrial style: metal and dark wood "
        "freestanding furniture, leather, woven textures, a muted charcoal "
        "palette."
    ),
    "midcentury": _style(
        "Furnish this room in a mid-century modern style: tapered legs, "
        "walnut, olive and mustard accents, organic curves, freestanding "
        "furniture only."
    ),
    "minimal": _style(
        "Furnish this room minimally: very few freestanding pieces, "
        "deliberately sparse, plenty of visible floor, restrained neutral "
        "palette."
    ),
    "luxury": _style(
        "Furnish this room in a luxury style: statement freestanding "
        "furniture, rich materials, marble and brass accents on furniture and "
        "objects only. Do not add lighting fixtures of any kind -- layer the "
        "look with table lamps and floor lamps that stand on the floor or on "
        "furniture."
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
        # On by default, and it should stay that way: an unlabelled staged
        # photo in a listing is the false-advertising exposure this exists to
        # prevent. Set "stamp": false only for internal comparison shots.
        "stamp": cfg.get("stamp", True),
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


# ---------- disclosure ----------

# Burned into every generated image, not just shown in the app.
#
# The app's own banner protects nobody: the moment an agent saves the file and
# sends it on, the disclosure is gone and the picture is just a photograph of a
# house that does not look like that. Most MLS rules and state advertising law
# want the label on the image itself, so that is where it goes.
#
# Bottom-LEFT on purpose -- listing photos routinely carry an MLS copyright in
# the bottom-right, and covering someone else's notice to place your own is a
# poor trade.
DISCLOSURE_TEXT = "Virtually staged \u2014 for illustration only"


def stamp_disclosure(data, text=DISCLOSURE_TEXT):
    """Return the image with a legibility-guaranteed disclosure burned in.

    Sized as a fraction of the image so it stays readable at any resolution,
    and drawn on a dark pill so it survives a pale floor or a bright window
    underneath -- white-on-white would be a disclosure that discloses nothing.
    """
    import io as _io

    from PIL import Image, ImageDraw, ImageFont

    img = Image.open(_io.BytesIO(data)).convert("RGB")
    width, height = img.size

    size = max(13, int(height * 0.026))
    font = None
    # DejaVu ships with Pillow; the rest are Windows fallbacks. The bitmap
    # default is the last resort and ignores size, hence the explicit hunt.
    for name in ("DejaVuSans.ttf", "arial.ttf", "segoeui.ttf", "calibri.ttf"):
        try:
            font = ImageFont.truetype(name, size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()

    draw = ImageDraw.Draw(img, "RGBA")
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]

    pad_x, pad_y = int(size * 0.85), int(size * 0.55)
    margin = int(height * 0.022)
    x0, y0 = margin, height - margin - th - pad_y * 2
    x1, y1 = x0 + tw + pad_x * 2, height - margin

    radius = int((y1 - y0) / 2)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=(0, 0, 0, 170))
    draw.text((x0 + pad_x - box[0], y0 + pad_y - box[1]), text,
              font=font, fill=(255, 255, 255, 236))

    out = _io.BytesIO()
    img.save(out, format="JPEG", quality=92)
    return out.getvalue()
