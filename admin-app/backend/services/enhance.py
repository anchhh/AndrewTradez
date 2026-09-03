"""
The Earth captures: framing them, and turning them into photographs.

Generation ran here, then moved to Google Flow by hand, and has come back.
The detour was worth its cost in what it settled: the shot that was actually
wanted came out of Nano Banana Pro, so that is the model this uses. Driving
Flow's own page turned out to be three guesses deep and still landing in the
asset library, and this does the same job in one call.

Cropping stays what it always was -- exact, free, and nothing a model should
be involved in.
"""
import os

from services import atlas_image

# Where the generation goes. Atlas Cloud, because the video already goes
# there: one account, one balance, one bill. It is also the cheaper route to
# the resolution this stage wants -- Google charges $0.24 an image at 4K and
# Atlas lists the same model at $0.15.
#
# The model itself is Nano Banana Pro either way. Which one was never in
# doubt after Flow: it made the shot that was actually wanted.


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
def _reflow(text):
    """Paragraphs on one line each.

    The text below is wrapped to the source file's margin, which never
    mattered while it only went to a model. It is on screen now, and a
    sentence broken across three lines in a textarea reads as damage. Blank
    lines still separate paragraphs; everything else is one flowing line.
    """
    sep = chr(10) * 2
    return sep.join(" ".join(block.split())
                    for block in text.split(sep) if block.strip())


# Which face of the house is being drawn. Now that the whole board goes in,
# including photographs of the other side, this is the rule doing the work
# the old ration used to do -- and it says it twice, at the top of the prompt
# and again as the last line, because that is where a long instruction is
# actually read.
SIDE_RULES = {
    "front": {
        "name": "FRONT",
        "other": "back",
        "shows": "the street and the driveway in frame, the front door and "
                 "the garage facing the camera, the front yard and the "
                 "approach in the foreground",
        "never": "no back garden, no patio, no rear deck, no back fence line",
    },
    "back": {
        "name": "BACK",
        "other": "front",
        "shows": "the garden and whatever sits in it -- lawn, patio, deck, "
                 "fence line -- in the foreground, the rear elevation facing "
                 "the camera, and the street only in the distance behind the "
                 "house",
        "never": "no front door, no driveway, no garage doors, no street "
                 "frontage in the foreground",
    },
}


PROMPT_TEMPLATE = """Use the attached satellite and aerial views of this
property, together with the ground photographs of the same home, to produce a
realistic drone photograph of it from above.

THIS SHOT IS THE %(name)s OF THE HOUSE. It shows %(shows)s. It does not show
the %(other)s of the building: %(never)s -- not in the distance, not at the
edges, not in a corner of the frame.

The first image is the view to work from: stay over the property, looking at
what it is looking at. THE SUBJECT IS THE HOUSE IN THE CENTRE OF THAT FRAME.
Anything else in shot is a neighbour: keep it where it is, but the centre
house is the one being rebuilt and the one every reference photograph is of.

The ground photographs are the truth about that house -- its colours,
materials, roof, windows, doors, fencing, driveway and planting. Its roof is
one continuous structure: do not break it into stepped blocks or invent a
second roof over the garage. Every roof plane on the house -- the main roof,
the garage, the porch below the windows -- is the same shingle in the same
colour; from above the lower ones are simply in more shadow.

If one of the attached images is a finished aerial photograph of the
%(other)s of this house, it is the SAME BUILDING you are drawing and it is
the authority on the building itself: match its number of storeys, its roof
pitch and ridge direction, its depth and its materials exactly, so the two
views are recognisably one house. Everything about the building that it shows
outranks the satellite views.

Several of the other attached images show the %(other)s of this same house,
and several show the houses either side of it. They are colour and material
swatches only. Take the siding, the shingle, the stone and the trim from
them, and take nothing else: not the layout, not the orientation, not a
single feature. A %(other)s elevation among the references is NOT the view
being drawn.

Geometry comes from the first image and from nothing else: where the road
runs, which way the roof faces, and what sits in the foreground.

The result is a real photograph: sharp, detailed, naturally lit.

Do not include Google Earth's interface, and do not include its map labels --
no floating house numbers over the roofs, no street names along the roads.

The camera is over the %(name)s of the house, looking at the %(name)s."""


def prompt_for(side):
    """The wording for one side. Falls back to the front rather than failing.

    Two prompts rather than one with an "if it shows the back" clause. The
    clause was there because the code did not know which side it was drawing;
    it does, and asking a model to work out from the picture what the caller
    already knew was spending its attention on the wrong question.
    """
    rules = SIDE_RULES.get(side) or SIDE_RULES["front"]
    return _reflow(PROMPT_TEMPLATE % rules)


# The front's wording, kept under the old name for anything that just wants
# to see what these look like.
PROMPT = prompt_for("front")


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


# Listing photographs carry the agency's watermark along the bottom edge,
# and the model has copied it into the output every time -- a generated shot
# with someone else's copyright bar burned into it. Telling it not to did not
# work; not showing it the bar does.
WATERMARK_STRIP = 0.045


def _paths_for(urls, trim_watermark=False):
    from studio import local_path_from_url

    paths = []
    for url in urls:
        path = local_path_from_url(url)
        if not (path and path.exists()):
            continue
        paths.append(_trimmed(path) if trim_watermark else str(path))
    return paths


def _trimmed(path):
    """A copy with the bottom strip removed, or the original if that fails.

    Written to a temporary file rather than the uploads folder: it is an
    input to one call, not something the listing should end up owning.
    """
    import tempfile

    from PIL import Image

    try:
        image = Image.open(str(path)).convert("RGB")
        height = int(image.height * (1 - WATERMARK_STRIP))
        if height < 64:
            return str(path)
        handle = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        image.crop((0, 0, image.width, height)).save(handle.name, "JPEG", quality=95)
        handle.close()
        return handle.name
    except Exception:  # noqa: BLE001 -- a reference that will not open is
        return str(path)  # not worth failing a generation over


# A ceiling on an edited prompt. Not a rule about what to write -- it is
# there so a paste accident cannot send a novel to a paid endpoint.
MAX_PROMPT = 6000


# What the three calls cost in time, measured rather than guessed: 21s to
# enlarge a 1400px capture, 70s to redraw it at 4K, 50s to restore detail.
# Used to weight a progress bar, so the bar moves at roughly the rate the
# work does instead of at a constant rate that stalls on the slow part.
PHASES = (("Sharpening the capture", 21),
          ("Redrawing the house", 70),
          ("Restoring the detail", 50))


def enhance_capture(lead, url, references=None, cfg=None, model=None,
                    prompt=None, side=None, on_phase=None):
    """Redraw one Earth capture as a photograph of this house.

    `references` is what to match against -- this property's other captures
    and its listing photographs. Chosen by hand when the caller passes them,
    because which side of a house a view shows is obvious to a person and
    guesswork here, and the board's own order otherwise.

    `side` decides the default wording: which face of the house this is a
    view of is the thing the result gets wrong, and it is known here rather
    than something the model should be working out from the picture.

    `prompt` overrides that wording for this one run. The page shows
    the real text before it spends anything, and a prompt you can read but
    not change is a strange thing to show someone -- especially this one,
    which is only what it is because it was rewritten against results.

    Returns the saved URL of the new image. The capture it came from is left
    on disk untouched: reverting is a swap, not a restore.
    """
    from studio import UPLOAD_DIR, local_path_from_url

    path = local_path_from_url(url)
    if not path or not path.exists():
        raise EnhanceError("that capture is not on disk any more")

    # References can be listing photographs OR this property's other
    # captures. Sending the top-down satellite alongside the oblique view is
    # what tells the model the shape of the plot; sending only one leaves it
    # guessing at the half it cannot see. Anything not belonging to this lead
    # is dropped rather than trusted.
    from services import dronepath

    allowed = (set(lead.photo_urls or [])
               | set(dronepath.images_of(lead.drone_path or {}))
               | set(dronepath.generated_of(lead.drone_path or {}).values()))
    chosen = [u for u in (references or []) if u in allowed and u != url]
    # Trimmed, because these are the listing's own photographs and they
    # carry its watermark.
    references = _paths_for(chosen or placed_references(lead), trim_watermark=True)
    if not references:
        raise EnhanceError(
            "this listing has no exterior photos, so there is nothing to "
            "match the building against. Add some at the listing step first.")

    # The capture first: Atlas passes the list straight through and the model
    # treats the first image as the subject. Everything after it is context.
    wording = (prompt or "").strip() or prompt_for(side)
    if len(wording) > MAX_PROMPT:
        raise EnhanceError("that prompt is too long to send")

    # The crop decides the framing, not the model. Whoever tightened the
    # capture on the house at the previous step made a choice, and coming
    # back with the street and half the sky in it throws that choice away.
    from PIL import Image

    try:
        shape = atlas_image.nearest_aspect(*Image.open(str(path)).size)
    except Exception:  # noqa: BLE001 -- framing is a preference, not a gate
        shape = None

    say = on_phase or (lambda index: None)

    say(0)
    enlarged = _enlarged(path, cfg)

    say(1)
    try:
        blob = atlas_image.edit([enlarged] + references, wording,
                                cfg=cfg, model=model, aspect=shape)
    except atlas_image.AtlasImageError as exc:
        raise EnhanceError(str(exc)) from exc

    say(2)
    return _save(UPLOAD_DIR, path, _sharpened(blob, cfg), "enhanced")


# The two passes that decide how the result LOOKS, as opposed to what is in
# it. Both are super-resolution; they sit at opposite ends of the generation
# for different reasons.
#
# An Earth capture is a browser screenshot, about 1400 across. Asking for 4K
# from that is asking the model to spread 1.4 megapixels of information over
# sixteen, and it does: at 1:1 the shingles were blurred blobs, the garage
# door panels indistinct, the porch light a smear. Enlarging the capture
# first gives it real pixels to redraw, and the same prompt with the same
# references then came back with individual shingle courses.
#
# The second pass is for what the model still softens on its way out. Run on
# the finished image at its own size, it restores micro-texture without
# touching the composition -- and composition is the expensive part, so this
# is the safe end to sharpen at.
BASE_SCALE = 3.0
BASE_ENOUGH = 2400  # already big enough that enlarging would only cost time


def _enlarged(path, cfg):
    """The capture with more pixels in it, or the capture.

    Best-effort throughout: a sharpening step that fails must not lose the
    generation behind it, so every failure here returns the original and the
    run carries on.
    """
    from PIL import Image

    try:
        if Image.open(str(path)).width >= BASE_ENOUGH:
            return str(path)
        blob = atlas_image.upscale(str(path), cfg=cfg, percent=BASE_SCALE)
    except Exception:  # noqa: BLE001 -- see above
        return str(path)
    return _temp(blob) or str(path)


def _sharpened(blob, cfg):
    """The finished image with its detail restored, or the finished image."""
    handle = _temp(blob)
    if not handle:
        return blob
    try:
        return atlas_image.upscale(handle, cfg=cfg, percent=1.0)
    except Exception:  # noqa: BLE001
        return blob


def _temp(blob):
    import tempfile

    try:
        fh = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        fh.write(blob)
        fh.close()
        return fh.name
    except Exception:  # noqa: BLE001
        return None


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
