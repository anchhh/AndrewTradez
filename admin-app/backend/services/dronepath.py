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

What replaces them is better anyway: the app FETCHES the overhead itself, so
there is no screenshot step, the framing is consistent, and the same image
can be recovered later. A screenshot from Earth can still be uploaded when
the 3D oblique view is wanted, which keeps the manual route open.

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


def overhead_for(lead):
    """An overhead image of this lead's address, saved and returned as a URL.

    Esri, keyless and free -- the same source the projects already use. A
    Google Static Maps image would look more familiar, but that API is not
    enabled on this project's key, and an overhead is an overhead.
    """
    from studio import UPLOAD_DIR, fetch_satellite_image, geocode_address

    coords = geocode_address(lead.address or "")
    if not coords:
        raise PathError("that address could not be placed on a map")

    blob = fetch_satellite_image(coords[0], coords[1])
    if not blob:
        raise PathError("no overhead imagery came back for that address")

    name = "overhead-lead%s.png" % lead.id
    (UPLOAD_DIR / name).write_bytes(blob)
    return {
        "url": "/studio/static/uploads/%s" % name,
        "lat": coords[0],
        "lon": coords[1],
        "earth_url": earth_url(lead.address, coords[0], coords[1]),
    }
