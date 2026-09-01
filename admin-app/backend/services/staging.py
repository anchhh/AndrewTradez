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
    "No people, no pets, no text, no logos, no watermark."
)

# The tie-breaker, kept separate from FIDELITY because emptying a room needs
# the opposite one -- see EMPTY_RULE. Appended only to the furnishing styles.
WHEN_UNSURE_KEEP = (
    " If you are unsure whether something is furniture or part of the "
    "building, treat it as part of the building and leave it alone."
)

# Stated first, so the model reads the constraint before the instruction.
PREFIX = NEVER_CHANGE + " " + CHANGE_ONLY + " "

# ...and again last, where it is weighted most.
KEEP = " " + CHANGE_ONLY + " " + NEVER_CHANGE + " " + FIDELITY + WHEN_UNSURE_KEEP


# Emptying a room needs the opposite tie-breaker to furnishing one.
#
# The shared rule ends "if unsure, treat it as part of the building and leave
# it alone", which is correct for the eight furnishing styles and exactly
# wrong here: a plant stand, an urn or a vase is precisely the ambiguous case,
# so the model kept them and returned a room that was not empty. Observed --
# chairs, rug, lamp and art removed, while a pampas vase and a wrought-iron
# plant stand stayed.
#
# So for this one style the ambiguity resolves toward removal, bounded by a
# physical test the model can actually apply: is it attached to the building?
EMPTY_RULE = (
    "The room must end up COMPLETELY EMPTY of movable objects. "
    "Apply this test to every object: if it could be carried out of the room "
    "by one or two people, it must be removed. "
    "Something counts as part of the building ONLY if it is plumbed in, wired "
    "into the electrical system, or built into the structure. "
    "Hanging on a nail, hook, bracket or screw does NOT make something part "
    "of the building: pictures, mirrors, clocks, wall shelves, wall racks, "
    "hooks and wall decor all come off the wall and must be removed, leaving "
    "the wall clean and unmarked. "
    "When in doubt about an object, REMOVE it. "
    "Remove in particular, and do not leave any of these behind: sofas, "
    "chairs, stools, tables, side tables, desks, beds, dressers, shelving "
    "units, rugs, mats, floor lamps, table lamps, televisions, artwork, "
    "framed pictures, mirrors that merely hang or lean, clocks, vases, urns, "
    "jars, pots, potted plants, dried flowers, decorative branches, plant "
    "stands, baskets, boxes, books, cushions, throws, and every ornament on "
    "every surface. "
    "Leave window treatments alone: curtains, drapes, blinds and their rods "
    "stay exactly as they are. An empty room is one with no furniture in it, "
    "not one with bare windows. "
    "When you are finished, every floor area, window sill, hearth and "
    "countertop must be completely bare, and the only things left in the room "
    "must be the building itself and its fixed fittings."
)


def _style(instruction):
    """Wrap a style instruction in the constraints, front and back."""
    return PREFIX + instruction + KEEP


def _empty(instruction):
    """Same, for emptying: the removal rule leads, and closes it out too."""
    return (
        NEVER_CHANGE + " " + EMPTY_RULE + " " + instruction + " "
        + NEVER_CHANGE + " " + EMPTY_RULE + " " + FIDELITY
    )


STYLE_PROMPTS = {
    # The inverse job, and one agents ask for constantly: an occupied house
    # photographs as somebody else's home. Emptying it is how a buyer pictures
    # their own furniture in the room. It is also the safest of these to
    # publish, because removing furniture cannot invent a feature.
    "unfurnished": _empty(
        "Show this room completely empty, as it would look on the day of a "
        "move-out inspection with nothing left in it. Reconstruct the floor, "
        "walls and skirting that were hidden behind the removed objects so "
        "they match the surrounding surfaces exactly, with correct perspective "
        "and consistent shadows -- the empty room must look naturally "
        "photographed, never smeared, blurred or patched. "
        "Built-in and fixed items stay exactly where they are: cabinetry, "
        "counters, sinks, taps, appliances, radiators, and every light fitting."
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

    data, _ = stage_room_with_report(local_path, style, cfg)
    return data


def stage_room_with_report(local_path, style, cfg=None, on_progress=None):
    """(image_bytes, leftovers). `leftovers` is "" when there is nothing to say.

    The caller wants both: three attempts can still come back with a wall
    clock in the corner, and shipping that silently is the thing to avoid.
    Knowing WHICH images are doubtful is worth more than pretending none are.
    """
    cfg = cfg or load_config()
    prompt = prompt_for(style)

    # Emptying is checkable, so it is checked -- see check_empty.
    if style == "unfurnished" and cfg["provider"] == "gemini":
        return _stage_until_empty(prompt, local_path, cfg, on_progress)

    return _stage_once(prompt, local_path, cfg), ""


def _stage_until_empty(prompt, local_path, cfg, on_progress=None):
    """Empty the room, then keep removing whatever the check still sees.

    The first pass does the real work. Every pass after it edits the previous
    result and deletes only the named leftovers, which converges where
    repeated full attempts did not -- the earlier version restarted from the
    original photo each time and tended to make the same mistake again.

    The best attempt is kept, not the last: pass four leaving one lamp is a
    better answer than pass five putting the sofa back.
    """
    import logging

    from services import gemini_image

    log = logging.getLogger(__name__)

    data = _stage_once(prompt, local_path, cfg)
    ok, leftovers = check_empty(data, cfg)
    if on_progress:
        on_progress(1, MAX_EMPTY_ATTEMPTS, leftovers)
    if ok:
        return data, ""

    best, best_count = data, _leftover_count(leftovers)
    best_leftovers = leftovers

    for attempt in range(2, MAX_EMPTY_ATTEMPTS + 1):
        log.info("attempt %s left: %s", attempt - 1, leftovers)
        try:
            data = gemini_image.edit_bytes(
                data, REMOVE_LEFTOVERS.format(leftovers=leftovers)
            )
        except (gemini_image.GeminiError, gemini_image.GeminiNotConfigured) as exc:
            log.warning("refinement pass failed: %s", exc)
            break

        ok, leftovers = check_empty(data, cfg)
        if on_progress:
            on_progress(attempt, MAX_EMPTY_ATTEMPTS, leftovers)
        if ok:
            log.info("room emptied on pass %s", attempt)
            return data, ""

        count = _leftover_count(leftovers)
        if count < best_count:
            best, best_count, best_leftovers = data, count, leftovers

    return best, best_leftovers


def _leftover_count(leftovers):
    """How many things the check named, for picking the best attempt."""
    return len([bit for bit in (leftovers or "").split(",") if bit.strip()])


def _stage_once(prompt, local_path, cfg):
    """One generation, whichever provider is configured."""
    import time

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
    prediction_id = submit_stage(image_url, None, cfg=cfg, prompt=prompt)

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


# ---------- checking the model's own work ----------

# Emptying a room is the one style with an objectively checkable result: the
# room is either empty or it is not. Prompting alone got 3 of 6 rooms clean --
# floor furniture went reliably, wall-hung decor survived, and one room came
# back untouched. No wording fixes the last case, because it is the model
# ignoring the instruction rather than misreading it.
#
# So the result is inspected and, if anything is left, generated again with
# the leftovers named. Naming them is the part that works: "the wall clock and
# the dresser are still there" is a far stronger instruction than any amount
# of up-front prohibition.
#
# Only unfurnished gets this. "Is this room empty" has a right answer; "is
# this a good coastal living room" does not, and a retry loop on taste would
# just burn quota.
EMPTY_CHECK = (
    "You are checking a real-estate photograph of a room that is supposed to "
    "be completely empty. "
    "Look ONLY at the main room in the foreground -- the one the camera is "
    "standing in. "
    "List every movable object still in it: furniture, rugs, mats, artwork, "
    "framed pictures, mirrors, clocks, wall decor, wall shelves, televisions, "
    "plants, vases, ornaments, boxes, clutter. "
    "Do NOT list anything built into the building: fitted cabinets, counters, "
    "sinks, taps, appliances, radiators, ceiling lights, ceiling fans, doors, "
    "windows, fireplaces, mantels, skirting, or vents. "
    "Do NOT list curtains, drapes, blinds or curtain rods -- those are "
    "expected to stay. "
    "Do NOT list anything that is in a different room or area, even if you "
    "can see it through a doorway, an archway, a serving hatch, a window, or "
    "across an open-plan space. Only the foreground room counts. "
    "If the room is completely empty of movable objects, reply with exactly "
    "the single word EMPTY. Otherwise reply with a short comma-separated list "
    "of what remains, and nothing else."
)

MAX_EMPTY_ATTEMPTS = 5

# The second pass and later do not redo the job -- they edit the previous
# attempt and remove only what the check found. Taking a nearly-empty room and
# deleting one dresser is a far smaller ask than emptying the room again from
# scratch, which is why restarting from the original kept failing the same way.
REMOVE_LEFTOVERS = (
    "This photograph of a room is supposed to be completely empty, but these "
    "objects are still in it: {leftovers}. "
    "Remove exactly those objects and nothing else. "
    "Reconstruct the floor, wall and skirting behind each one so it matches "
    "the surrounding surfaces exactly, with correct perspective, texture and "
    "shadows. "
    "Change NOTHING else in the picture: do not move the camera, do not alter "
    "the lighting, and do not add anything. "
    "Leave the building and its fixed fittings exactly as they are -- walls, "
    "windows, doors, ceiling, floor, skirting, ceiling fans, light fittings, "
    "vents, outlets, switches, radiators, built-in cabinetry -- and leave "
    "curtains, blinds and their rods alone. "
    "The result must be the same room with those objects gone."
)


def check_empty(image_bytes, cfg=None):
    """(is_empty, leftovers). Falls open: an unusable answer is not a failure.

    If the check itself errors, the image is accepted rather than discarded --
    a broken checker must not throw away a good result or spin the retry loop.
    """
    cfg = cfg or load_config()
    if cfg["provider"] != "gemini":
        return True, ""

    from services import gemini_image

    try:
        answer = gemini_image.ask_about_image(image_bytes, EMPTY_CHECK, timeout=60)
    except Exception:  # noqa: BLE001
        return True, ""

    cleaned = (answer or "").strip().strip(".").strip()
    if not cleaned:
        return True, ""
    if cleaned.upper().startswith("EMPTY"):
        return True, ""
    # A refusal or a paragraph is not a leftovers list; do not retry on it.
    if len(cleaned) > 300:
        return True, ""
    return False, cleaned
