"""
The Earth captures: framing them, and describing what to do with them.

Generating the shots themselves happens in Google Flow, by hand. That was a
decision made after trying it here: Gemini's image models are reachable from
this app and they do work, but the run that produced the shot actually
wanted was made in Flow, and a second path that produces a worse version of
the same thing is a second path to maintain and a bill to explain.

So what is left here is everything around that. Cropping, which is exact and
free and nothing a model should be involved in. The prompt, which travels to
Flow in the bundle. And which photographs go with which capture, which is
the judgement the whole board stage exists to record.
"""
import os

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


def placed_references(lead):
    """What stage 2's board says describes this property.

    Preferred over the room-label guess wherever the board has been filled
    in, because it is a person's answer to the same question.
    """
    from services import dronepath

    return dronepath.placed(lead) or exterior_references(lead)


def _paths_for(urls):
    from studio import local_path_from_url

    paths = []
    for url in urls:
        path = local_path_from_url(url)
        if path and path.exists():
            paths.append(str(path))
    return paths


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
