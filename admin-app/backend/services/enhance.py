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


class EnhanceError(Exception):
    """The capture could not be edited."""


PROMPT = """EDIT THE FIRST IMAGE. Return the first image, redrawn. Do not
return any of the other images.

The first image is a screenshot of Google Earth's 3D view of a property.
Make it look like a photograph taken from exactly that position.

THE CAMERA DOES NOT MOVE. Whatever the first image is looking at, from
whatever height and angle, the result looks at the same thing from the same
height and the same angle, with the same things in the same places in the
frame. If the first image looks straight down, the result looks straight
down. If a house sits in the lower left of the first image, it sits in the
lower left of the result.

The images after the first are photographs of THAT SAME HOUSE, taken from
the ground. They are reference for what the building looks like, not
pictures to return and not a camera position to copy. Take from them: the
colour and material of the walls, the roof colour and pitch, the windows,
the garage, the door, the driveway, the landscaping.

DO:
- resolve the soft, melted 3D geometry into clean architecture, matching
  what the reference photographs show
- clean up smeared texture on the roof, the walls, the road and the grass
- keep the lighting natural for the time of day already in the capture

DO NOT:
- change the viewpoint, the angle, the height, the framing or the crop
- change the layout of the plot, or move the house, the driveway, the fences
  or the neighbouring buildings
- add or remove buildings, vehicles, people, pools or trees
- produce an illustration, a render or a painting: the result is a
  photograph
- add text, logos, watermarks or a border

If the reference photographs do not show a part of the building, leave that
part as the first image has it rather than inventing it.

Again: the output is the FIRST image, from its own camera position, redrawn
to look like a photograph."""


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


def enhance_capture(lead, url, cfg=None):
    """Redraw one Earth capture as a photograph of this house.

    Returns the saved URL of the new image. The capture it came from is left
    on disk untouched -- reverting is a swap, not a restore.
    """
    from studio import UPLOAD_DIR, local_path_from_url

    path = local_path_from_url(url)
    if not path or not path.exists():
        raise EnhanceError("that capture is not on disk any more")

    references = _paths_for(exterior_references(lead))
    if not references:
        raise EnhanceError(
            "this listing has no exterior photos, so there is nothing to "
            "match the building against. Add some at the listing step first.")

    try:
        blob = gemini_image.edit_with_references(str(path), PROMPT, references, cfg=cfg)
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
