"""
Stage 3: an image editor for the Google Earth captures.

What is being edited matters, because it decides what is honest here.

These are not photographs of the property. They are screenshots of Earth's
3D mesh: the roof is a smeared triangle, the walls are projected texture,
and anything smaller than a car is a suggestion. Nobody is going to mistake
one for a photo of the house, and nobody sends one to a client. It is the
plate a drone flight gets planned and generated from.

So generation is the right tool here, where it was the wrong tool for a
listing photograph. Asked to retouch a real photo, Gemini's image model
redraws the fixtures -- which on a listing means an agent sending a client a
door handle the house does not have. Asked to sharpen a mesh into something
that looks like a building, redrawing is the entire job.

What keeps it honest is the reference photographs. The listing's own
exterior shots go up alongside the capture, so when the model resolves that
smear into a roof it is resolving it toward the roof this house actually
has: its colour, its pitch, its materials. Without them the model would
invent a plausible house. With them it is copying from the real one.

Cropping is separate and deliberately dumb: PIL, exact pixels, no model
involved. Framing a shot is not a judgement anything needs to make for you.
"""
import os

from services import gemini_image

# How many exterior photographs go up with the capture. Enough to establish
# the house from more than one side; few enough that the capture is still
# clearly the subject rather than one image among many.
MAX_REFERENCES = 4

# Which room labels count as a look at the outside of the building. Same set
# the video stage uses to split exterior from interior.
EXTERIOR_ROOMS = ("exterior_front", "exterior_back", "aerial", "outdoor_space")

# The model this stage uses, which is deliberately NOT the one staging uses.
# gemini-2.5-flash-image returns about a megapixel whatever you ask for --
# 1248x832, below the 1920 wide a 1080p clip starts from. gemini-3.1-flash-image
# honours imageSize and returned 2508x1664 on the same capture with the same
# prompt: four times the pixels, and the difference between "melted" and
# "photograph". Both are settings rather than constants because the newer
# model's free allowance is Google's to change.
MODEL = "gemini-3.1-flash-image"
IMAGE_SIZE = "2K"


def _model_settings(cfg=None):
    cfg = cfg or gemini_image.load_config()
    return (cfg.get("enhance_model") or MODEL,
            cfg.get("enhance_image_size") or IMAGE_SIZE)


class EnhanceError(Exception):
    """The capture could not be edited."""


PROMPT = """Redraw this Google Earth screenshot as a real photograph of
this house, at the highest quality you can produce.

THE CAMERA DOES NOT MOVE. This is the rule that matters most. The result is
shot from the same place as the screenshot: the same height, the same angle,
the same distance, the same framing. An aerial view stays an aerial view --
do not descend to the ground, do not swing round the building, do not
re-centre it. Every roof, fence and driveway stays in the position it
occupies in the screenshot.

The first image is the screenshot. Every image after it is a photograph of
THAT SAME HOUSE from the ground. They are the truth about the building, not
a camera position to copy.

MAKE IT A PHOTOGRAPH, from that same viewpoint:
- sharp throughout, no blur, no smearing, no melted geometry
- real materials with real texture: individual roof shingles, the grain and
  seams of the siding, the courses of the brick, the boards of the fence
- clean straight architectural edges: the roof line, the eaves, the window
  frames, the garage door panels, the corners of the walls
- real glass in the windows, with reflection and depth rather than flat grey
- lawn that reads as grass, concrete that reads as concrete, gravel that
  reads as stones
- natural sunlight, with the shadows falling exactly where the screenshot's
  fall
- the crisp detail and colour of a professional drone photograph

TAKE FROM THE REFERENCE PHOTOGRAPHS:
- the colour and material of every wall
- the roof colour and pitch
- the trim, the front door, the garage door, the porch, the railings
- the fencing, the driveway, the path, the planting and the ground cover

The screenshot may include Google Earth's own interface -- menus, a search
box, a toolbar, a scale bar, a logo, a status line -- and Earth's map labels
painted over the scene, such as house numbers floating above roofs and
street names lying along the roads. None of that is part of the property.
Render the landscape underneath instead: no menus, no toolbars, no floating
numbers, no street names, and no band of interface at any edge.

Do not add or remove buildings, vehicles, people or trees. Do not add text,
logos or watermarks, and do not copy a watermark out of the reference
photographs. Do not produce an illustration, a painting or a 3D render.

This is a substantial upgrade, not a touch-up: the screenshot is soft and
synthetic, the result is sharp and photographic. Do not return the first
image unchanged -- and do not move the camera to achieve it."""


def exterior_references(lead, limit=MAX_REFERENCES):
    """The listing's own photographs of the outside of the house.

    Front elevations first: they show the most of the building and are what a
    flight usually opens on. Falls back to any photo at all rather than none,
    because an unsorted listing still knows what its house looks like.
    """
    photos = lead.photo_urls or []
    rooms = lead.photo_rooms or {}

    def room_of(photo):
        entry = rooms.get(photo)
        return (entry.get("room") if isinstance(entry, dict) else entry) or ""

    ranked = []
    for preferred in EXTERIOR_ROOMS:
        ranked += [u for u in photos if room_of(u) == preferred]
    if not ranked:
        ranked = list(photos)
    return ranked[:limit]


def _paths_for(urls):
    from studio import local_path_from_url

    paths = []
    for url in urls:
        path = local_path_from_url(url)
        if path and path.exists():
            paths.append(str(path))
    return paths


def enhance_capture(lead, url, references=None, cfg=None):
    """Redraw one Earth capture as a photograph of this house.

    `references` is the listing photos to match against. Chosen by hand when
    the caller passes them -- which side of the house a capture shows is
    obvious to a person and guesswork here -- and the exterior shots by
    default.

    Returns the saved URL of the new image. The capture it came from is left
    on disk untouched: reverting is a swap, not a restore.
    """
    from studio import UPLOAD_DIR, local_path_from_url

    path = local_path_from_url(url)
    if not path or not path.exists():
        raise EnhanceError("that capture is not on disk any more")

    chosen = [u for u in (references or []) if u in (lead.photo_urls or [])]
    references = _paths_for(chosen or exterior_references(lead))
    if not references:
        raise EnhanceError(
            "this listing has no exterior photos, so there is nothing to "
            "match the building against. Add some at the listing step first.")

    model, image_size = _model_settings(cfg)
    try:
        blob = gemini_image.edit_with_references(
            str(path), PROMPT, references, cfg=cfg,
            model=model, image_size=image_size)
    except gemini_image.GeminiError as exc:
        raise EnhanceError(str(exc)) from exc

    return _save(UPLOAD_DIR, path, blob, "enhanced")


def crop_capture(lead, url, box):
    """Crop one capture to a box given in its own pixels.

    No model: a crop is exact, and asking anything to interpret a rectangle
    the user drew would only introduce a way for it to be wrong.
    """
    from PIL import Image

    from studio import UPLOAD_DIR, local_path_from_url

    path = local_path_from_url(url)
    if not path or not path.exists():
        raise EnhanceError("that capture is not on disk any more")

    image = Image.open(str(path)).convert("RGB")
    try:
        left, top, right, bottom = (int(round(float(v))) for v in box)
    except (TypeError, ValueError) as exc:
        raise EnhanceError("that crop is not a rectangle") from exc

    left, top = max(0, left), max(0, top)
    right, bottom = min(image.width, right), min(image.height, bottom)
    if right - left < 32 or bottom - top < 32:
        raise EnhanceError("that crop is too small to be a shot")

    cropped = image.crop((left, top, right, bottom))
    out = UPLOAD_DIR / _name_for(path, "cropped", ".jpg")
    cropped.save(out, "JPEG", quality=94, subsampling=0)
    return "/studio/static/uploads/%s" % out.name


def _name_for(path, suffix, ext):
    """A name that says what happened, without stacking suffixes forever.

    Cropping an enhanced capture should not produce
    "x-enhanced-cropped-enhanced-cropped.jpg" after a few passes, so the
    previous suffix is replaced rather than appended.
    """
    base = os.path.splitext(os.path.basename(str(path)))[0]
    for known in ("-enhanced", "-cropped"):
        if base.endswith(known):
            base = base[: -len(known)]
    return "%s-%s%s" % (base, suffix, ext)


def _save(upload_dir, source_path, blob, suffix):
    import uuid

    # A unique name rather than a predictable one: an edit has to be a NEW
    # file every time, because the old one is still referenced by the gallery
    # until the swap goes through, and by the browser's cache after it.
    name = _name_for(source_path, "%s-%s" % (suffix, uuid.uuid4().hex[:8]), ".png")
    (upload_dir / name).write_bytes(blob)
    return "/studio/static/uploads/%s" % name
