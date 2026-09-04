"""
Planning a drone flight on an overhead image, and turning it into words.

The workflow this replaces is manual: open Google Earth, screenshot it, draw
a red line for the path. Two parts of that cannot be brought inside the app,
and it is worth being exact about which:

  * earth.google.com sends X-Frame-Options: SAMEORIGIN, so it cannot be put
    in an iframe.
  * A cross-origin iframe cannot be screenshotted from JavaScript at all --
    the canvas would be tainted. So a "capture" button over an embedded map
    has nothing to capture.

So the screenshot is taken outside the app and handed back to it. The Google
Earth stage is that handover: a link out searched for the full address, and
somewhere to drop what comes back. It is stored against the lead, so the
flight planner two screens later opens on it rather than asking again.

The app used to fetch a satellite overhead of its own as a substitute. That
is gone: once Earth supplies the view, a second and worse picture of the
same roof is only something to tell apart from the real one.

The drawn line then becomes prompt text. It cannot become anything else: the
video model accepts a first frame, a last frame and words -- there is no
third image and no camera-path parameter -- so a picture of a path would
never be seen. Turning it into a bearing and a distance is the honest way to
make the model follow it.
"""
import math
import os

# North-up, because that is how every overhead source draws it.
COMPASS = [
    (0, "north"), (45, "north-east"), (90, "east"), (135, "south-east"),
    (180, "south"), (225, "south-west"), (270, "west"), (315, "north-west"),
]


class PathError(Exception):
    """The path could not be read or planned."""


# How many captures one property is worth keeping. A flight is planned from a
# handful of angles, not from a photo album, and every one of these is a full
# screen PNG sitting in the uploads folder.
MAX_IMAGES = 12


def images_of(path):
    """Every captured view, oldest first.

    Reads the older single-image shape too: a path saved before captures were
    a list still has one, and it is the same picture.
    """
    path = path or {}
    images = [url for url in (path.get("images") or []) if isinstance(url, str)]
    single = path.get("image")
    if single and single not in images:
        images.insert(0, single)
    return images


def add_image(lead, url):
    """Append a capture, and draw on it if nothing was chosen yet.

    Adding never changes which view the path is drawn on once one is set --
    taking a second angle should not silently move the line onto it.
    """
    path = dict(lead.drone_path or {})
    images = images_of(path)
    if url not in images:
        images.append(url)
    path["images"] = images[-MAX_IMAGES:]
    if not path.get("image"):
        path["image"] = url
    return _stamped(lead, path)


def replace_image(lead, old_url, new_url, geometry_changed=True):
    """Swap an edited version in where the capture was.

    The edit takes the capture's PLACE rather than being added beside it: a
    cropped view and its uncropped self are the same view, and a gallery that
    shows both is a gallery you have to think about. What it came from is
    remembered so the edit can be undone.

    A crop or a re-render moves the pixels, so a path drawn on that view no
    longer describes it -- the line is dropped when the edited view is the
    one being drawn on.
    """
    path = dict(lead.drone_path or {})
    images = images_of(path)
    if old_url not in images:
        raise PathError("that view is not one of this listing's captures")

    path["images"] = [new_url if u == old_url else u for u in images]

    # Chained edits (crop, then enhance) still point back at the first file,
    # so Revert always returns the original capture rather than the step
    # before it.
    originals = dict(path.get("originals") or {})
    originals[new_url] = originals.pop(old_url, old_url)
    path["originals"] = originals

    # A cropped front overhead is still the front overhead, in every box it
    # was in.
    slots = slots_of(path)
    for slot, urls in slots.items():
        slots[slot] = [new_url if u == old_url else u for u in urls]
    path["slots"] = slots

    if path.get("image") == old_url:
        path["image"] = new_url
        if geometry_changed:
            path.pop("points", None)
    return _stamped(lead, path)


def original_of(path, url):
    """The capture an edited view came from, or None."""
    return (path or {}).get("originals", {}).get(url)


def set_primary(lead, url):
    """Choose the view the flight path is drawn on."""
    path = dict(lead.drone_path or {})
    if url not in images_of(path):
        raise PathError("that view is not one of this listing's captures")
    # The line was drawn in the coordinates of the old picture, so it cannot
    # be carried across to a different one. Better to lose it here, visibly,
    # than to keep a path that no longer matches what is under it.
    if path.get("image") != url:
        path.pop("points", None)
    path["image"] = url
    return _stamped(lead, path)


def remove_image(lead, url):
    """Drop one capture. Removing the one being drawn on moves to another."""
    path = dict(lead.drone_path or {})
    images = [u for u in images_of(path) if u != url]
    path["images"] = images
    originals = dict(path.get("originals") or {})
    originals.pop(url, None)
    path["originals"] = originals

    # Gone from the gallery means gone from every box it was in.
    slots = {slot: [u for u in urls if u != url]
             for slot, urls in slots_of(path).items()}
    path["slots"] = {slot: urls for slot, urls in slots.items() if urls}
    if path.get("image") == url:
        path["image"] = images[0] if images else None
        path.pop("points", None)
    return _stamped(lead, path)


def _stamped(lead, path):
    from datetime import datetime, timezone

    path["saved_at"] = datetime.now(timezone.utc).isoformat()
    lead.drone_path = path
    return path


# What to capture, before anything is generated from it.
#
# A single oblique view leaves the model guessing at the half of the plot it
# cannot see, and guessing is where invented patio furniture comes from. The
# fix is coverage: the same property from a few angles and a few sources, so
# every surface appears in at least one input.
#
# Grouped by what the flight actually needs. The front is the establishing
# shot and gets the most; the back is where the flight lands; the
# neighbours matter because a house is rebuilt in the context either side of
# it and a model with no reference for that invents the street.
#
# "Reference" entries are not captures -- they are the listing's own
# photographs, already on the lead. They are listed because the plan is
# about what the enhancer will be given, and half of that comes from the
# listing rather than from Earth.
SHOT_PLAN = [
    {
        "key": "front",
        "label": "Front",
        "note": "The establishing shot. Worth getting all four.",
        "shots": [
            {"key": "front_street", "label": "Street views",
             "hint": "Earth's ground-level view from the road", "multi": True},
            {"key": "front_overhead", "label": "Satellite overhead",
             "hint": "Straight down, framed on the plot", "multi": True},
            {"key": "front_3d", "label": "Satellite 3D",
             "hint": "Tilted, looking at the front of the house", "multi": True},
            {"key": "front_reference", "label": "Reference photos",
             "hint": "Front elevations from the listing — as many as show it well",
             "source": "listing", "multi": True},
        ],
    },
    {
        "key": "back",
        "label": "Back",
        "note": "Where a front-to-back flight ends up.",
        "shots": [
            {"key": "back_overhead", "label": "Satellite overhead",
             "hint": "Straight down over the rear of the plot", "multi": True},
            {"key": "back_3d", "label": "Satellite 3D",
             "hint": "Tilted, looking at the back of the house", "multi": True},
            {"key": "back_reference", "label": "Reference photos",
             "hint": "Rear elevations from the listing — as many as show it well",
             "source": "listing", "multi": True},
        ],
    },
    {
        "key": "neighbours",
        "label": "Neighbours",
        "note": "The house is rebuilt in its street; without these the "
                "street gets invented too.",
        "shots": [
            {"key": "nb_overhead", "label": "Satellite overhead",
             "hint": "Wider, both sides of the property", "multi": True},
            {"key": "nb_3d", "label": "Satellite 3D",
             "hint": "Tilted along the row", "multi": True},
            {"key": "nb_street", "label": "Street views",
             "hint": "Down the road, past the house", "multi": True},
        ],
    },
]

# Flat lookup, for labelling one capture without walking the plan.
SHOT_LABELS = {shot["key"]: "%s — %s" % (group["label"], shot["label"])
               for group in SHOT_PLAN for shot in group["shots"]}

# Every slot in the plan, whether it is filled from Earth or from the
# listing. A reference photo is a choice now rather than an automatic pick:
# the app cannot tell a front elevation from a side one reliably, and the
# enhancer is only as good as the photograph it is told to match.
CAPTURE_SLOTS = [shot["key"] for group in SHOT_PLAN for shot in group["shots"]]

LISTING_SLOTS = [shot["key"] for group in SHOT_PLAN for shot in group["shots"]
                 if shot.get("source") == "listing"]

# Slots that hold more than one image, which is now all of them. The first
# version made capture slots single on the theory that there is only one
# front overhead. There is not: there is one at each height, and the model is
# being asked to match a building rather than to copy a picture. A second
# view of the same thing is another answer to the same question.
MULTI_SLOTS = {shot["key"] for group in SHOT_PLAN for shot in group["shots"]
               if shot.get("multi")}

# A ceiling per slot, because every image is another one the model has to
# weigh and the capture has to stay the subject.
MAX_PER_SLOT = 6


# Where Google Flow lives. A link, because that is all it can be: Flow has
# no public API and no documented URL parameter that pre-fills a prompt or
# attaches an image. Anything claiming to "send" a job there would be
# scraping a web tool.
FLOW_URL = "https://labs.google/fx/tools/flow"


def group_of(slot):
    """Which group of the plan a slot belongs to."""
    for group in SHOT_PLAN:
        if any(shot["key"] == slot for shot in group["shots"]):
            return group["key"]
    return None


# The camera move every shot in this flow uses. Not a default that can be
# overridden -- the only one. The route is drawn at stage 5 and the two ends
# are photographs, so what is left to say about the camera is "fly it like a
# drone", and a menu offering "orbit" or "pull back wide" instead was offering
# a different shot than the one the flow is building.
MOVE = "drone_flight"

# The establishing shot on the drone flow's second tab: a short push over a
# wide photograph, a whip, and then one long zoom down onto the front
# (services/whip.py cuts them together). With no closer view chosen it is
# the zoom alone.
AERIAL_MOVE = "aerial_push"
AERIAL_ZOOM = "aerial_zoom"

# The two shots a flight is built from. One picture of the front and one of
# the back: a flyover starts on one and lands on the other, and everything
# else on the board exists to make those two right.
SIDES = ("front", "back")

# The model takes ten images including the subject, so nine references fill
# it. An earlier run with ten came back worse than one with three, but that
# test was confounded: it also used a wide crop, which turned out to be the
# real problem. What was actually wrong was the ORDER -- the real photographs
# of the house sat fourth and later, behind street views. Ordered properly,
# more context helps, and the truncation drops what matters least.
MAX_REFERENCES = 9

# Nothing is held back any more. There used to be a hard ration on how many
# photographs of the OTHER side could ride along, because the first attempt at
# merging both sides redrew a back elevation as the front door. The prompt is
# what fixes that -- it now names the side out loud, at the top and again at
# the bottom, and says a photograph of the other face is a swatch and not the
# view. With that in place the ration was solving a problem twice, badly.


def _ordered(lead, side):
    """The base, and every placed image ranked by how much it decides.

    Ranked rather than filtered, because the model takes ten and a full board
    runs to more: whatever falls off the end has to be the least useful thing
    on it. This side's own photographs first -- this house, from the face
    being drawn -- then this side's other captures, then the other side of
    the same building, which is the same siding and the same shingle. The
    neighbours come last: they are context for the street rather than
    evidence about the subject, and if anything is going to be dropped it
    should be somebody else's roof.
    """
    slots = slots_of(lead.drone_path or {})
    other = "back" if side == "front" else "front"

    base = None
    for key in ("%s_3d" % side, "%s_overhead" % side, "%s_street" % side):
        for url in slots.get(key) or []:
            base = base or url

    def collect(keys):
        out = []
        for key in keys:
            for url in slots.get(key) or []:
                if url != base and url not in out:
                    out.append(url)
        return out

    # The shot already made for the OTHER side, first of all.
    #
    # This is the one thing that ties the two ends together. They were
    # generated in complete ignorance of each other -- each from its own
    # capture with its own references -- so nothing made the back agree with
    # the front about how many storeys the house has, which way the ridge
    # runs, or how deep the building is. They came out as two different
    # houses, and no video prompt can fly between two different houses: the
    # clip crossed one roof and arrived at a building that did not match, so
    # it put a fence between them and made them neighbours.
    #
    # First in the list because the model weighs early images most, and this
    # one is not a swatch -- it is the same building, already drawn.
    made = generated_of(lead.drone_path or {})
    counterpart = made.get("back" if side == "front" else "front")
    lead_in = [counterpart] if counterpart and counterpart != base else []

    mine = collect(["%s_reference" % side, "%s_3d" % side,
                    "%s_overhead" % side, "%s_street" % side])
    theirs = collect(["%s_reference" % other, "%s_3d" % other,
                      "%s_overhead" % other, "%s_street" % other])
    nearby = collect(["nb_3d", "nb_overhead", "nb_street"])

    ranked = []
    for url in lead_in + mine + theirs + nearby:
        if url not in ranked:
            ranked.append(url)
    return base, ranked


def base_for(lead, side):
    """The capture a side's shot is built ON, and what to match it against.

    The base is that side's oblique: it already looks like a photograph taken
    from the air, so the model has least to invent from it. The references
    are the whole board -- both sides and the neighbours -- cut only where
    the model's own ceiling cuts it.
    """
    base, ranked = _ordered(lead, side)
    return base, ranked[:MAX_REFERENCES]


def reference_count(lead, side):
    """(sent, placed) -- how much of the board fits, and how much there is.

    Worth saying on the page rather than quietly truncating: someone who has
    filled every box deserves to know that three of them did not go.
    """
    _, ranked = _ordered(lead, side)
    return min(len(ranked), MAX_REFERENCES), len(ranked)


# What a flight is drawn ON. An overhead, always: a path is a shape from
# above and a guess from anywhere else. Ranked so the property's own overhead
# comes before the one that was filed under the neighbours, which is often
# the same picture anyway.
OVERHEAD_SLOTS = ("front_overhead", "back_overhead", "nb_overhead",
                  "front_3d", "back_3d", "nb_3d")


def overheads(lead):
    """The captures worth drawing a path on, best first."""
    slots = slots_of(lead.drone_path or {})
    out = []
    for key in OVERHEAD_SLOTS:
        for url in slots.get(key) or []:
            if url not in out:
                out.append(url)
    # Better a picture than an empty page: an unfiled capture still shows the
    # plot, and someone who never used the board still has a flight to plan.
    for url in images_of(lead.drone_path or {}):
        if url not in out:
            out.append(url)
    return out


def flight_of(path):
    """The drawn line: {image, width, height, points}, or empty.

    Kept at the top of the record rather than under a key of its own, because
    describe() has read it from there since the first planner and a flight is
    a flight however it was drawn.
    """
    path = path or {}
    points = path.get("points") or []
    if len(points) < 2:
        return {}
    return {"image": path.get("path_image") or path.get("image"),
            "width": path.get("width"), "height": path.get("height"),
            "points": points}


def set_flight(lead, image, width, height, points):
    """Record the line. Two points or more, in the drawing image's pixels."""
    points = [[float(x), float(y)] for x, y in (points or [])]
    if len(points) < 2:
        raise PathError("a flight needs a start and an end")
    if not (width and height):
        raise PathError("that path has no picture to belong to")

    path = dict(lead.drone_path or {})
    path["points"] = points
    path["width"] = float(width)
    path["height"] = float(height)
    # Named separately from the board's own primary image: which capture the
    # LINE is in the coordinates of is a different question from which one the
    # gallery leads with, and conflating them lost paths before.
    path["path_image"] = image or None
    return _stamped(lead, path)


def route_image_of(path):
    """The flattened picture of the drawn route, if one has been made."""
    return (path or {}).get("route_image")


# What the line looks like when it is baked into a picture rather than drawn
# over one by the browser. Same colours as the planner, so the two read as
# the same object.
ROUTE_CASING = (12, 10, 8, 200)
ROUTE_LINE = (255, 107, 53, 255)
ROUTE_START = (255, 107, 53, 255)
ROUTE_END = (31, 122, 77, 255)


def render_route(lead):
    """Burn the drawn route into a new image and file it against the lead.

    A canvas drawn over a photograph exists only while that page is open. This
    makes the route a file: something the recap can show without running any
    script, something that survives being emailed to somebody, and something
    that is unambiguously a record of what was planned.

    Returns the saved URL, or None when there is nothing to draw.
    """
    from PIL import Image, ImageDraw

    from studio import UPLOAD_DIR, local_path_from_url

    path = lead.drone_path or {}
    flight = flight_of(path)
    points = flight.get("points") or []
    source = local_path_from_url(flight.get("image") or "")
    if len(points) < 2 or not source or not source.exists():
        return None

    image = Image.open(str(source)).convert("RGB")
    # The line was drawn against the image's own pixels at the size the
    # planner reported. If that disagrees with the file -- a re-cropped
    # capture, say -- scale rather than draw the line in the wrong place.
    sx = image.width / float(flight.get("width") or image.width)
    sy = image.height / float(flight.get("height") or image.height)
    line = [(p[0] * sx, p[1] * sy) for p in points]

    # Widths from the picture rather than fixed, so a 1400px capture and a
    # 5000px one get the same line, not the same number of pixels.
    unit = max(2.0, image.width / 320.0)
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    pen = ImageDraw.Draw(layer)
    pen.line(line, fill=ROUTE_CASING, width=int(unit * 2.2), joint="curve")
    pen.line(line, fill=ROUTE_LINE, width=int(unit), joint="curve")

    for point, colour in ((line[0], ROUTE_START), (line[-1], ROUTE_END)):
        r = unit * 2.0
        box = [point[0] - r, point[1] - r, point[0] + r, point[1] + r]
        pen.ellipse(box, fill=colour, outline=(255, 255, 255, 255),
                    width=max(1, int(unit * 0.6)))

    out = Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB")
    name = "%s-route.jpg" % os.path.splitext(os.path.basename(str(source)))[0]
    out.save(UPLOAD_DIR / name, "JPEG", quality=92, subsampling=0)

    url = "/studio/static/uploads/%s" % name
    path = dict(lead.drone_path or {})
    path["route_image"] = url
    _stamped(lead, path)
    return url


def clear_flight(lead):
    path = dict(lead.drone_path or {})
    for key in ("points", "width", "height", "path_image", "route_image"):
        path.pop(key, None)
    return _stamped(lead, path)


def progress(lead):
    """What this property already has, and how far the flow got.

    The drone flow keeps everything on the lead -- captures, which box each
    was placed in, the two generated shots, the drawn route -- so coming back
    to a listing you have worked on restores it all. It just never SAID so.
    The basic flow tells you it picked up where you left off, and a flow that
    quietly reproduces a board you spent ten minutes filling is unsettling in
    exactly the way that sentence fixes.
    """
    path = lead.drone_path or {}
    made = generated_of(path)
    placed = sum(len(v) for v in slots_of(path).values())
    flight = flight_of(path)

    done = []
    captures = len(images_of(path))
    if captures:
        done.append("%d capture%s" % (captures, "" if captures == 1 else "s"))
    if placed:
        done.append("%d placed on the board" % placed)
    if made.get("front") and made.get("back"):
        done.append("both shots generated")
    elif made.get("front") or made.get("back"):
        done.append("one shot generated")
    if flight.get("points"):
        done.append("a route drawn")

    # The furthest stage the work reaches, so "carry on" lands there rather
    # than at the start of a flow you are halfway through.
    if made.get("front") and made.get("back"):
        stage = ("Drone shot", "/studio/create/video/drone?lead_id=%s&style=drone" % lead.id)
        if flight.get("points"):
            pass  # the shot stage is still the right place to carry on
        else:
            stage = ("Flight path", "/studio/create/video/flight?lead_id=%s&style=drone" % lead.id)
    elif placed:
        stage = ("Generate", "/studio/create/video/generate?lead_id=%s&style=drone" % lead.id)
    elif captures:
        stage = ("Crop", "/studio/create/video/crop?lead_id=%s&style=drone" % lead.id)
    else:
        stage = None

    return {"done": done, "summary": ", ".join(done), "stage": stage}


def clear_all(lead):
    """Forget everything the drone flow knows about this property.

    The captures stay on disk -- they cost a browser window and a crop, and
    somebody starting the board again may want them back. What goes is every
    decision made ON them.
    """
    path = dict(lead.drone_path or {})
    for key in ("slots", "generated", "points", "width", "height",
                "path_image", "route_image", "aerial_opening", "image"):
        path.pop(key, None)
    return _stamped(lead, path)


def aerial_opening_of(path):
    """Which wide view the establishing shot opens on."""
    return (path or {}).get("aerial_opening")


def aerial_middle_of(path):
    """The optional frame it passes through on the way down.

    With one set, the model flies only from HERE down to the house, and the
    jump from the opening photograph into this one is a whip -- a speed
    blur built from the photograph (services/whip.py), added after the
    render. Generating that stretch instead had the model turning the
    neighbourhood into a different one on the way.
    """
    return (path or {}).get("aerial_middle")


def set_aerial_opening(lead, url, middle=None):
    """Remember them, so the choices survive leaving the page."""
    path = dict(lead.drone_path or {})
    if url:
        path["aerial_opening"] = url
    else:
        path.pop("aerial_opening", None)
    if middle:
        path["aerial_middle"] = middle
    else:
        path.pop("aerial_middle", None)
    return _stamped(lead, path)


def generated_of(path):
    """{side: url} for the shots already made."""
    return dict((path or {}).get("generated") or {})


def set_generated(lead, side, url):
    """Record the shot made for one side, or clear it with url=None."""
    if side not in SIDES:
        raise PathError("there is no such side")
    path = dict(lead.drone_path or {})
    made = generated_of(path)
    if url:
        made[side] = url
    else:
        made.pop(side, None)
    path["generated"] = made
    return _stamped(lead, path)


def placed_by_group(lead):
    """{group key: [urls]} in plan order, for handing to something else.

    Grouped rather than flat because the front and the back are separate
    briefs: a flight is generated from one or the other, and sending both
    sets as one pile is how a back-garden shot gets the front door.
    """
    slots = slots_of(lead.drone_path or {})
    out = {}
    for key in CAPTURE_SLOTS:
        group = group_of(key)
        for url in slots.get(key) or []:
            bucket = out.setdefault(group, [])
            if url not in bucket:
                bucket.append(url)
    return out


def placed(lead):
    """Everything put in a box, in plan order.

    This is what the enhancer should be given: the views and photographs a
    person chose for this property, in the order the plan lists them, rather
    than whatever the room labels happened to pick out.
    """
    slots = slots_of(lead.drone_path or {})
    ordered = []
    for key in CAPTURE_SLOTS:
        for url in slots.get(key) or []:
            # An image in two boxes is still one image to send.
            if url not in ordered:
                ordered.append(url)
    return ordered


def slots_of(path):
    """{slot key: [urls]} -- what is in each box.

    Keyed by slot rather than by image, because an image can be in more than
    one box: the same oblique view can be the front 3D and the neighbours 3D,
    and making the picture pick one was an artefact of the storage rather
    than anything about the property.

    Reads the older {url: slot} shape too. Boards were filled in before this
    changed and none of that work should have to be redone.
    """
    stored = (path or {}).get("slots") or {}
    if stored and all(isinstance(v, str) for v in stored.values()):
        by_slot = {}
        for url, slot in stored.items():
            by_slot.setdefault(slot, []).append(url)
        return by_slot
    return {slot: [u for u in (urls or []) if isinstance(u, str)]
            for slot, urls in stored.items()}


def slots_for(path, url):
    """Every box this image is in."""
    return [slot for slot, urls in slots_of(path).items() if url in urls]


def set_slot(lead, url, slot):
    """Put an image in a box.

    Additive: it does not take the image out of any other box. One picture
    can honestly answer two questions -- an oblique that shows the front of
    this house also shows the neighbour's -- and forcing a choice between
    them lost information for no reason.
    """
    path = dict(lead.drone_path or {})
    _check(lead, path, url, slot)

    slots = slots_of(path)
    holding = list(slots.get(slot) or [])
    if url in holding:
        return _stamped(lead, path)          # already there; nothing to say
    if len(holding) >= MAX_PER_SLOT:
        raise PathError("that box already holds %d images" % MAX_PER_SLOT)

    holding.append(url)
    slots[slot] = holding
    path["slots"] = slots
    return _stamped(lead, path)


def unset_slot(lead, url, slot):
    """Take one image out of one box, leaving it in any others."""
    path = dict(lead.drone_path or {})
    _check(lead, path, url, slot)

    slots = slots_of(path)
    holding = [u for u in (slots.get(slot) or []) if u != url]
    if holding:
        slots[slot] = holding
    else:
        slots.pop(slot, None)
    path["slots"] = slots
    return _stamped(lead, path)


def _check(lead, path, url, slot):
    if url not in images_of(path) and url not in (lead.photo_urls or []):
        raise PathError("that image is not one of this listing's")
    if slot not in CAPTURE_SLOTS:
        raise PathError("there is no such shot in the plan")


def full_address(lead):
    """Kept as a function because the callers here read like one.

    The assembly itself lives on the model, so a page showing the address and
    a link searching for it cannot disagree about what it is.
    """
    return lead.full_address


def earth_url(address, lat=None, lon=None):
    """A Google Earth link for this property.

    Offered as a link rather than an embed because Earth refuses to be
    framed. Clicking it is one tab away, and the 3D view it gives can come
    back as an uploaded image.
    """
    if lat is not None and lon is not None:
        # Earth's web URL: lat,lon,altitude then camera distance and tilt. A
        # 300m distance at 45 degrees is roughly what a listing flyover shows.
        return ("https://earth.google.com/web/@%s,%s,0a,300d,45y,0h,45t,0r"
                % (lat, lon))
    if not address:
        return None
    from urllib.parse import quote
    return "https://earth.google.com/web/search/" + quote(address)


def bearing(start, end):
    """Compass direction from one point to another on the image.

    Image coordinates: y grows downward, so a line drawn upward is north.
    """
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    if dx == 0 and dy == 0:
        return None
    degrees = (math.degrees(math.atan2(dx, -dy)) + 360) % 360
    best = min(COMPASS, key=lambda c: min(abs(degrees - c[0]),
                                          360 - abs(degrees - c[0])))
    return best[1]


# How close to the middle of the frame a line has to pass before it counts as
# crossing the house. The captures are cropped tight to the subject at stage
# 3 -- that is the stage's whole instruction -- so the centre of the frame is
# the building, and the two fixed ends both sit on the vertical centre line,
# which makes the default straight run an over-the-roof flight by
# construction.
OVER_HOUSE = 0.16


def _near_centre(points, width, height):
    """Does the line pass over the middle of the frame?

    Measured to the SEGMENTS rather than the points: a straight A-to-B path
    is two points at the top and bottom of the frame and nothing near the
    middle, yet it crosses the house squarely. Testing the corners of a line
    is not testing the line.
    """
    cx, cy = width / 2.0, height / 2.0
    best = None
    for i in range(len(points) - 1):
        (ax, ay), (bx, by) = points[i], points[i + 1]
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        # Where the centre falls along this segment, clamped to its ends so a
        # segment that merely POINTS at the house does not count as crossing
        # it.
        t = 0.0 if not length else max(0.0, min(
            1.0, ((cx - ax) * dx + (cy - ay) * dy) / length))
        gap = math.hypot((ax + t * dx - cx) / width, (ay + t * dy - cy) / height)
        best = gap if best is None else min(best, gap)
    return best is not None and best <= OVER_HOUSE


# The most legs a route is worth describing in. A drawn line has dozens of
# samples and a flight has two or three intentions; past that the sentence
# gets longer than the prompt budget and no more faithful.
MAX_LEGS = 3

# How sharp a turn has to be before it starts a new leg. Below this it is the
# same intention with a wobble in it.
TURN = 30.0


def _simplify(points):
    """The drawn line reduced to the turns that were meant.

    Kept because the route is the thing being asked for. Reducing the whole
    polyline to one start-to-end bearing threw away the shape -- a dogleg
    round the side of the house and a straight run became the same sentence,
    and the model was never told the difference.
    """
    if len(points) < 3:
        return list(points)

    kept = [points[0]]
    heading = None
    for i in range(1, len(points)):
        ax, ay = kept[-1]
        bx, by = points[i]
        if abs(bx - ax) < 1e-6 and abs(by - ay) < 1e-6:
            continue
        angle = math.degrees(math.atan2(bx - ax, -(by - ay))) % 360
        if heading is None:
            heading = angle
            continue
        turn = abs((angle - heading + 180) % 360 - 180)
        if turn >= TURN:
            kept.append(points[i - 1])
            heading = angle
    kept.append(points[-1])

    # Merge the shortest legs until it fits, so what survives is the biggest
    # turns rather than the first ones.
    while len(kept) - 1 > MAX_LEGS:
        spans = [math.hypot(kept[i + 1][0] - kept[i][0],
                            kept[i + 1][1] - kept[i][1])
                 for i in range(len(kept) - 1)]
        kept.pop(spans.index(min(spans)) + 1 if spans.index(min(spans)) < len(kept) - 2
                 else len(kept) - 2)
    return kept


def _leg_crosses(a, b, width, height):
    return _near_centre([a, b], width, height)


def describe(path):
    """The drawn line, as an ordered instruction the model can fly.

    Leg by leg, in the order they were drawn. The previous version reduced
    the whole polyline to one start-to-end bearing and a "curved" flag, which
    meant a straight run and a dogleg round the side of the house produced
    almost the same sentence -- the shape someone had taken the trouble to
    draw was thrown away before it reached the model.

    Each leg carries the one thing that decides altitude: whether it passes
    over the building. A leg across the middle of the plot is a drone over
    the roof; a leg down the side is not, and telling it to climb over a roof
    it never reaches is how a clip ends up flown by nobody.
    """
    points = (path or {}).get("points") or []
    if len(points) < 2:
        return ""

    width = float((path or {}).get("width") or 1) or 1
    height = float((path or {}).get("height") or 1) or 1

    legs = _simplify(points)
    if len(legs) < 2:
        return ""

    steps = []
    crossed = False
    said = None
    for i in range(len(legs) - 1):
        a, b = legs[i], legs[i + 1]
        head = bearing(a, b)
        if not head:
            continue
        # Two legs the same way over the same thing are one intention. The
        # simplifier keeps a turn that rounds to the same compass point, and
        # without this the route read "north over the house; then north over
        # the house".
        here = (head, _leg_crosses(a, b, width, height))
        if here == said and i != len(legs) - 2:
            continue
        said = here
        last = i == len(legs) - 2
        if last and steps and here == (said[0], True) and crossed:
            steps[-1] += " and settling over the garden behind it"
            continue
        if here[1]:
            crossed = True
            # A final leg that crosses the roof still has to land somewhere,
            # and "clearing its ridge" on its own leaves the flight in the
            # air over the middle of the house.
            steps.append("%s DIRECTLY OVER THE HOUSE, clearing its ridge%s"
                         % (head, " and settling over the garden behind it"
                            if last else ""))
        elif not steps:
            steps.append("%s across the plot" % head)
        elif last:
            steps.append("%s to settle over the garden" % head)
        else:
            steps.append("%s alongside the house" % head)
    if not steps:
        return ""

    span = math.hypot((legs[-1][0] - legs[0][0]) / width,
                      (legs[-1][1] - legs[0][1]) / height)

    line = ("FLY THIS ROUTE, the way a drone operator filming this property "
            "would, in this order: " + "; then ".join(steps) + ".")
    if span < 0.25:
        line += " It is a short run -- do not travel far."
    line += (" Keep that order and shape. Do not orbit the building or fly "
             "past the property; the only turn is the camera's half-circle "
             "at the ridge.")
    if not crossed:
        line += " This route never crosses the roof: stay beside it."
    return line
