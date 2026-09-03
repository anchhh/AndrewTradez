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


def describe(path):
    """The drawn line, as a sentence the model can act on.

    Deliberately about the CAMERA, not the scenery. What the line crosses is
    a matter for the photographs; what it says about the flight is a heading
    and a distance, and those are things a prompt can carry.
    """
    points = (path or {}).get("points") or []
    if len(points) < 2:
        return ""

    start, end = points[0], points[-1]
    heading = bearing(start, end)
    if not heading:
        return ""

    # Length as a fraction of the image, which is the only scale available
    # without knowing the ground resolution. Long/short is enough to say
    # whether the flight travels or hovers.
    width = float((path or {}).get("width") or 1) or 1
    height = float((path or {}).get("height") or 1) or 1
    span = math.hypot((end[0] - start[0]) / width, (end[1] - start[1]) / height)

    # Turning: the angle between the first leg and the last says whether the
    # planned flight is straight or arcs around the building.
    curved = False
    if len(points) >= 3:
        first = bearing(points[0], points[1])
        last = bearing(points[-2], points[-1])
        curved = bool(first and last and first != last)

    parts = ["FLIGHT PATH, planned on an overhead view of this property: fly "
             "%s across the plot" % heading]
    if span < 0.25:
        parts.append("a short distance only")
    elif span > 0.6:
        parts.append("the full width of the plot, steadily")
    if curved:
        parts.append("curving as you go rather than travelling straight")
    return ", ".join(parts) + ". Hold that heading; do not reverse or circle back."
