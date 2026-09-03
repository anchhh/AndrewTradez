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

# How many images go up with the capture by default. The picker can send
# more: the run that produced the shot this was rebuilt around used four --
# an oblique Earth view, a top-down satellite, a street-level view and a
# listing photograph -- and the mix mattered more than the count.
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


# Short on purpose.
#
# The long version of this -- two and a half thousand characters of rules,
# a camera lock and a ban list -- produced a careful, mediocre picture. The
# same model given one sentence about what to make produced the shot that was
# actually wanted. It is the prompt ladder's lesson again from the other end:
# rules earn their place by fixing an observed failure, and every one that is
# there "to be safe" is spending attention that would otherwise go on the
# photograph.
#
# What is left: the task, which images are which, and the two failures that
# were real -- Earth's interface, and its map labels.
PROMPT = """Use the attached satellite and aerial views of this property,
together with the ground photographs of the same home, to produce a
realistic drone photograph of it from above.

The first image is the view to work from: stay over the property, looking at
what it is looking at. The ground photographs are the truth about the
building -- its colours, materials, roof, windows, doors, fencing, driveway
and planting.

The result is a real photograph: sharp, detailed, naturally lit.

Do not include Google Earth's interface, and do not include its map labels --
no floating house numbers over the roofs, no street names along the roads."""


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

    # References can be listing photographs OR this property's other captures.
    # Sending the top-down satellite alongside the oblique view is what tells
    # the model the shape of the plot; sending only one leaves it guessing at
    # the half it cannot see. Anything not belonging to this lead is dropped
    # rather than trusted.
    from services import dronepath

    allowed = set(lead.photo_urls or []) | set(dronepath.images_of(lead.drone_path or {}))
    chosen = [u for u in (references or []) if u in allowed and u != url]
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
