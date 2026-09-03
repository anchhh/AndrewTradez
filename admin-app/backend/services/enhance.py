"""
Stage 3: making a listing photograph look like it was shot properly.

The obvious way to build this does not work, and it is worth writing down
why before someone tries it again.

Gemini's image model was asked to retouch a photograph, twice, the second
time with wording that forbade redrawing in six different ways. Both times
it returned a *regenerated* picture: the canvas came back 1248x832 instead
of 1280x849, a light switch lost its outlet, the picture frames on the wall
changed shape, and the "(c) IRES" watermark came back mirrored. It is an
image generator. Asked for the same photograph slightly brighter, it paints
a new photograph that looks similar -- and on a listing that means an agent
sending a client a picture of fixtures the house does not have.

So the work is split at the seam where each side is good:

  * Gemini LOOKS. Vision is what it is reliable at, it is free, and this app
    already trusts it to sort rooms and read a site. It returns numbers --
    how far out the exposure is, which way the colour leans.
  * The app APPLIES those numbers with PIL. Arithmetic on the real pixels:
    nothing invented, nothing moved, the dimensions unchanged and the
    watermark exactly where the photographer put it.

The result is a smaller correction than a generated "enhancement", and it is
a correction to the photograph that was actually taken.

Reference photographs are the other pictures of the same property, sent so
the judgement is made knowing what colour the brick really is rather than
guessing from one frame.
"""
import json
import os
import re

from services import gemini_image

# How many other photographs go along for context. Enough to establish the
# property's real colours and light; not so many that the reply drifts into
# describing the listing.
MAX_REFERENCES = 3

# Bounds on every correction. A model asked for a number will occasionally
# answer with a large one, and a listing photo pushed two stops is a worse
# photograph, not a bolder one. The ceiling is what a careful edit looks
# like, so the worst case here is "not enough", never "ruined".
LIMITS = {
    "exposure": (-0.35, 0.60),    # stops, roughly
    "contrast": (-0.20, 0.35),
    "warmth": (-0.30, 0.30),      # negative cools, positive warms
    "saturation": (-0.20, 0.30),
    "shadows": (0.0, 0.45),       # lift only; crushing blacks is not a fix
    "highlights": (-0.40, 0.0),   # recover only
    "sharpen": (0.0, 0.60),
}

QUESTION = """You are a photo editor judging one real-estate photograph.

The FIRST image is the photograph to judge. Any images after it are other
photographs of the same property, for context about its true colours and
lighting -- do not judge those.

Reply with ONLY a JSON object, no prose and no code fence:

{"exposure": 0.0, "contrast": 0.0, "warmth": 0.0, "saturation": 0.0,
 "shadows": 0.0, "highlights": 0.0, "sharpen": 0.0, "note": ""}

  exposure    -0.35..0.60  how much brighter the whole frame should be
  contrast    -0.20..0.35
  warmth      -0.30..0.30  positive warms a blue cast, negative cools an
                           orange one
  saturation  -0.20..0.30
  shadows      0.00..0.45  lifting dark areas only
  highlights  -0.40..0.00  recovering bright areas only
  sharpen      0.00..0.60
  note        one short sentence on what is wrong with the photograph

Judge conservatively. A photograph that is already well exposed should come
back as zeros -- there is no credit for finding something to change. These
numbers are applied arithmetically to the real pixels, so anything large
will look obviously edited."""


class EnhanceError(Exception):
    """The photograph could not be enhanced."""


def references_for(lead, url, limit=MAX_REFERENCES):
    """Other photographs of the same property, for colour and light.

    Same room first: a bedroom says more about a bedroom's real lighting
    than the front elevation does.
    """
    photos = [u for u in (lead.photo_urls or []) if u != url]
    if not photos:
        return []

    rooms = lead.photo_rooms or {}

    def room_of(photo):
        entry = rooms.get(photo)
        return (entry.get("room") if isinstance(entry, dict) else entry) or ""

    here = room_of(url)
    same = [u for u in photos if here and room_of(u) == here]
    return (same + [u for u in photos if u not in same])[:limit]


def _clamp(values):
    """Every number inside its limit, and anything unparseable at zero."""
    clean = {}
    for key, (low, high) in LIMITS.items():
        try:
            value = float(values.get(key, 0) or 0)
        except (TypeError, ValueError):
            value = 0.0
        clean[key] = max(low, min(high, value))
    clean["note"] = str(values.get("note") or "")[:200]
    return clean


def judge(lead, url, cfg=None):
    """What this photograph needs, as numbers."""
    from studio import local_path_from_url

    path = local_path_from_url(url)
    if not path or not path.exists():
        raise EnhanceError("that photo is not on disk any more")

    images = [path.read_bytes()]
    for other in references_for(lead, url):
        other_path = local_path_from_url(other)
        if other_path and other_path.exists():
            images.append(other_path.read_bytes())

    try:
        answer = gemini_image.ask_about_images(images, QUESTION, cfg=cfg)
    except gemini_image.GeminiError as exc:
        raise EnhanceError(str(exc)) from exc

    # Models fence JSON however they like; take the first object in the reply.
    match = re.search(r"\{.*\}", answer or "", re.S)
    if not match:
        raise EnhanceError("Gemini did not answer with any corrections")
    try:
        return _clamp(json.loads(match.group(0)))
    except ValueError as exc:
        raise EnhanceError("Gemini's answer was not readable JSON") from exc


def apply_corrections(path, c):
    """The numbers, applied to the real pixels.

    Order follows how a darkroom works: tone first, then colour, then
    sharpening last so it is not amplifying a curve applied after it.
    """
    from PIL import Image, ImageEnhance, ImageFilter

    image = Image.open(path).convert("RGB")

    # Exposure, shadow lift and highlight recovery are all curve moves, so
    # they go through one lookup table rather than three passes over the
    # pixels -- and a curve cannot clip the way a flat multiply does.
    if c["exposure"] or c["shadows"] or c["highlights"]:
        table = []
        for i in range(256):
            v = i / 255.0
            if c["exposure"]:
                v = min(1.0, v * (2 ** c["exposure"]))
            if c["shadows"]:
                # Strongest in the darks, nothing at white.
                v = v + c["shadows"] * (1 - v) ** 2 * (v ** 0.5)
            if c["highlights"]:
                # Strongest in the brights, nothing at black.
                v = v + c["highlights"] * (v ** 3)
            table.append(max(0, min(255, round(v * 255))))
        image = image.point(table * 3)

    if c["contrast"]:
        image = ImageEnhance.Contrast(image).enhance(1 + c["contrast"])
    if c["saturation"]:
        image = ImageEnhance.Color(image).enhance(1 + c["saturation"])

    if c["warmth"]:
        # Red up and blue down together, which is what a white-balance slider
        # does; a small coefficient keeps neutrals neutral.
        amount = c["warmth"]
        r, g, b = image.split()
        r = r.point(lambda i: max(0, min(255, round(i * (1 + amount * 0.12)))))
        b = b.point(lambda i: max(0, min(255, round(i * (1 - amount * 0.12)))))
        image = Image.merge("RGB", (r, g, b))

    if c["sharpen"]:
        image = image.filter(ImageFilter.UnsharpMask(
            radius=1.6, percent=int(60 * c["sharpen"]), threshold=3))

    return image


def enhance_photo(lead, url, cfg=None):
    """Judge one photograph and save the corrected version.

    The original is never touched: the corrected file is a new one, and the
    mapping between them is what makes reverting a deleted line rather than a
    restore from somewhere.
    """
    from studio import UPLOAD_DIR, local_path_from_url

    if url not in (lead.photo_urls or []):
        raise EnhanceError("that photo does not belong to this listing")

    corrections = judge(lead, url, cfg=cfg)

    # A photograph that needs nothing gets nothing. Writing a re-encoded copy
    # of an already-good picture would cost a JPEG generation for no gain and
    # leave the listing claiming an enhancement it did not receive.
    if not any(corrections[k] for k in LIMITS):
        return None, corrections

    path = local_path_from_url(url)
    image = apply_corrections(str(path), corrections)

    # Quality high enough not to add its own artefacts to a photograph that
    # is about to be rendered into video. Named after the original so the
    # pair is obvious, and overwritten on a re-run rather than piling up.
    base = os.path.splitext(os.path.basename(str(path)))[0]
    name = "%s-enhanced.jpg" % base
    image.save(UPLOAD_DIR / name, "JPEG", quality=92, subsampling=0)
    return "/studio/static/uploads/%s" % name, corrections


def rendered_url(lead, url):
    """Which file a render should actually use for this photo."""
    if lead is None:
        return url
    return (lead.enhanced_photos or {}).get(url) or url
