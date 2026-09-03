"""
Reading a property from the outside, so an exterior camera move is honest.

The interior problem was a pan inventing a door. The exterior problem is
bigger: asked to fly from the front of a house to the back, a model that has
seen only the front elevation will invent a back. It will be a convincing
back -- correct roof pitch, matching siding, a deck, maybe a pool -- and it
will be a photograph of a house that does not exist, published as a listing.

No prompt fixes that, because the rear of the building is not in the request.
Two things do, and they are the same two that fixed the interior:

  1. `end_image`. Kling accepts a final frame. Give it the front photograph
     and the REAR photograph and the flight travels between two real pictures
     of the real house instead of imagining the far side.

  2. Refusing the move when there is no rear photograph. If the listing does
     not show the back, a front-to-back flyover cannot be rendered honestly,
     and the useful thing is to say so before the money is spent.

So the real output of this module is an ANCHOR -- which photo ends the
flight -- and a verdict on whether each exterior move can be made at all.

The satellite image is here for orientation rather than beauty: it shows the
footprint, which side meets the street and how much land is behind the house,
which is what says whether "front to back" is even a short flight. It is
fetched keylessly from Esri and is often a few years old, so it is used to
judge layout and never as evidence about the building's condition.

Deliberately NOT read from contact sheets, which is how room sorting works.
Sorting a room is a coarse call that survives a 320x240 tile; deciding
whether a photograph shows the REAR ELEVATION, or whether an aerial is close
enough to fly through, is not. Asked from a sheet this missed a rear
elevation plainly in it and called a close aerial of the house "not close".
There are only ever a handful of exterior photographs, so they go one per
image at full size.
"""
import io
import json
import os
import re

from contact_sheet import local_path_for

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "studio", "_site")

# The labels room sorting already assigns. Only these photographs are worth
# sending: an exterior analysis has nothing to learn from a bathroom.
OUTSIDE_ROOMS = ("exterior_front", "exterior_back", "aerial", "outdoor_space")


class SiteError(Exception):
    """The site could not be analysed."""


# Only the aerials are sent, plus the front elevation for reference. Which
# photograph is the front, the rear or an aerial is already known -- room
# sorting labelled every photo and got it right. Asking a model to re-derive
# that from nine images produced a different wrong answer every run, so the
# question is now the narrow one that labels cannot answer: is any of these
# aerials close enough to this house to be flown through.
AERIAL_PROMPT = """The FIRST image is the front of a house, at ground level.

The images after it are aerial photographs from the same listing, numbered
from 0 in the order given.

Which ONE of the numbered aerials shows THAT SAME HOUSE from above, close
enough that its roof and frontage fill much of the frame -- close enough to
be the midpoint of a drone flight over that house?

A wide neighbourhood or streetscape view, where the house is one roof among
many and hard to pick out, does NOT count.

Answer ONLY with a JSON object, no prose, no markdown fence:

{"aerial": <the number, or null if none is close enough>,
 "why": "<one short sentence>"}
"""

SITE_PROMPT = """This is an overhead satellite view of a property, and then a
photograph of the front of the house on it.

Answer ONLY with a JSON object, no prose, no markdown fence:

{"front_faces": "<which way the front of the house faces: north, south, east,
                  west, or unknown>",
 "depth": "<short|medium|long -- how far from the street frontage to the back
            of the plot>",
 "notes": "<one sentence on the layout>"}
"""


def cache_path(lead_id):
    return os.path.join(CACHE_DIR, "lead%s.json" % lead_id)


def load_cached(lead_id):
    try:
        with open(cache_path(lead_id), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def save_cached(lead_id, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    try:
        with open(cache_path(lead_id), "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
    except OSError:
        pass


def outside_photos(photo_urls, photo_rooms):
    """The exterior photographs, in a sensible flight order.

    Front first, then aerials, then the rest: the order the analysis reads
    them in is the order a person would describe the property.
    """
    rooms = photo_rooms or {}
    rank = {room: i for i, room in enumerate(OUTSIDE_ROOMS)}

    outside = [u for u in photo_urls
               if (rooms.get(u) or {}).get("room") in OUTSIDE_ROOMS]
    outside.sort(key=lambda u: rank.get((rooms.get(u) or {}).get("room"), 99))
    return outside


def satellite_bytes(address):
    """An overhead view of the address, or None.

    Imported from the app lazily: the fetcher lives with the geocoding it
    depends on, and importing it at module scope would have services depend on
    studio, which imports services.
    """
    if not address:
        return None
    try:
        from studio import fetch_satellite_image, geocode_address
    except ImportError:
        return None

    coords = geocode_address(address)
    if not coords:
        return None
    try:
        return fetch_satellite_image(coords[0], coords[1])
    except Exception:  # noqa: BLE001 -- an absent map is not a failed analysis
        return None


def _readable(url, longest=1100):
    """One photograph, scaled down enough to send but large enough to judge.

    1100px keeps a rear elevation legible and a roof recognisable, which a
    320x240 contact-sheet tile did not.
    """
    from PIL import Image

    try:
        with Image.open(local_path_for(url)) as img:
            img = img.convert("RGB")
            img.thumbnail((longest, longest))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            return buf.getvalue()
    except (OSError, ValueError):
        # A photo that will not open is skipped; a bug in here is not. A bare
        # `except Exception` hid a NameError for io and turned it into "none
        # of the exterior photographs could be read".
        return None


def _parse(text):
    """The JSON object out of a model reply, fence or no fence."""
    body = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", body, re.S)
    if fence:
        body = fence.group(1).strip()
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end < start:
        raise SiteError("the analysis did not come back as JSON")
    try:
        return json.loads(body[start:end + 1])
    except ValueError as exc:
        raise SiteError("the analysis was not valid JSON") from exc


def _by_room(photo_urls, photo_rooms, room):
    rooms = photo_rooms or {}
    return [u for u in photo_urls if (rooms.get(u) or {}).get("room") == room]


def analyse(lead_id, address, photo_urls, photo_rooms, force=False):
    """What the outside of this property looks like, and what can be flown.

    Structure comes from the room labels, which are already right. The model
    is asked two narrow questions it can actually answer: which aerial is
    close enough to fly through, and which way the plot runs.

    Cached per lead: a house does not move, and this runs before a render
    rather than adding a minute to one.
    """
    outside = outside_photos(photo_urls, photo_rooms)
    if not outside:
        raise SiteError("this listing has no exterior photographs")

    if not force:
        cached = load_cached(lead_id)
        if cached and cached.get("count") == len(outside):
            return cached

    from services import gemini_image

    fronts = _by_room(photo_urls, photo_rooms, "exterior_front")
    rears = _by_room(photo_urls, photo_rooms, "exterior_back")
    aerials = _by_room(photo_urls, photo_rooms, "aerial")

    front = fronts[0] if fronts else None
    rear = rears[0] if rears else None

    # Which aerial can carry the middle of the flight.
    aerial_close, aerial_why = None, ""
    if front and aerials:
        images = [_readable(front)] + [_readable(u) for u in aerials]
        if all(images):
            try:
                raw = _parse(gemini_image.ask_about_images(
                    images, AERIAL_PROMPT, timeout=120))
                index = raw.get("aerial")
                if isinstance(index, int) and 0 <= index < len(aerials):
                    aerial_close = aerials[index]
                    aerial_why = (raw.get("why") or "").strip()
            except (SiteError, Exception):  # noqa: BLE001
                aerial_close = None

    # Which way the plot runs, from the satellite.
    faces, depth, notes = "unknown", "unknown", ""
    sat = satellite_bytes(address)
    if sat and front:
        try:
            raw = _parse(gemini_image.ask_about_images(
                [sat, _readable(front)], SITE_PROMPT, timeout=120))
            faces = (raw.get("front_faces") or "unknown").strip().lower()
            depth = (raw.get("depth") or "unknown").strip().lower()
            notes = (raw.get("notes") or "").strip()
        except (SiteError, Exception):  # noqa: BLE001
            pass

    data = {
        "count": len(outside),
        "satellite": bool(sat),
        "photos": outside,
        "front": front,
        "rear": rear,
        "aerials": aerials,
        "aerial_close": aerial_close,
        "aerial_why": aerial_why,
        "front_faces": faces,
        "depth": depth,
        "notes": notes,
    }
    save_cached(lead_id, data)
    return data


# --------------------------------------------------------------------------
# What can be flown
# --------------------------------------------------------------------------

def check_move(move, photo, site):
    """{level, reason, anchor} for one exterior move on one photo.

    level is "anchored" (ends on a real photograph), "safe" (stays inside the
    frame it was given) or "blocked" (cannot be rendered honestly).
    """
    from services.video import needs_anchor

    rear = (site or {}).get("rear")
    front = (site or {}).get("front")
    aerial = (site or {}).get("aerial_close")

    if move == "flyover_front_to_back":
        # Refused when there IS an aerial, because we have watched this fail.
        #
        # Rendered front-to-back in one leg, the camera reaches the ridge with
        # no photograph anywhere near it and the roof turns to mush: shingles
        # smear, the ridge line warps, and around the apex the frame collapses
        # into a grey band before snapping to the rear. The two photographs it
        # was given are both far away from the moment it fails.
        #
        # The aerial sits exactly where that hole is. Two legs through it give
        # the model a real picture at the point it was previously guessing, so
        # when one exists the one-leg version is not offered.
        if aerial:
            # Allowed, but flagged. It was blocked for a while on the strength
            # of one bad render; that is a reason to warn, not to refuse. The
            # user can see the same footage and decide, and refusing a shot
            # somebody wants on our judgement of quality is not this module's
            # job -- refusing what cannot be rendered HONESTLY is.
            return {
                "level": "risky",
                "reason": "One leg means the roof crossing has no photograph "
                          "near it; last time it smeared there. The two legs "
                          "through the aerial avoid that.",
                "anchor": rear,
            }
        if not rear:
            return {
                "level": "blocked",
                "reason": "No photograph shows the back of this house, so the "
                          "flight would have to invent it.",
                "anchor": None,
            }
        if photo == rear:
            return {
                "level": "blocked",
                "reason": "This is the rear photograph — the flight ends here "
                          "rather than starting here.",
                "anchor": None,
            }
        if front and photo != front:
            return {
                "level": "anchored",
                "reason": "Ends on the rear photograph. Starting from the "
                          "front shot usually reads better.",
                "anchor": rear,
            }
        return {
            "level": "anchored",
            "reason": "Front to rear, ending on a real photograph of the back.",
            "anchor": rear,
        }

    if move == "rise_over_roof":
        if not aerial:
            return {"level": "blocked",
                    "reason": "No aerial photograph shows this house from above, "
                              "so the climb has nowhere real to arrive.",
                    "anchor": None}
        if photo == aerial:
            return {"level": "blocked",
                    "reason": "This is the aerial the climb ends on.",
                    "anchor": None}
        return {"level": "anchored",
                "reason": "Ends on the aerial view of this house.",
                "anchor": aerial}

    if move == "cross_to_rear":
        if not rear:
            return {"level": "blocked",
                    "reason": "No photograph shows the back of this house, so the "
                              "flight would have to invent it.",
                    "anchor": None}
        if aerial and photo != aerial:
            return {"level": "safe",
                    "reason": "Start this leg from the aerial view -- crossing the "
                              "roof from ground level is the jump that dissolves.",
                    "anchor": rear}
        return {"level": "anchored",
                "reason": "Over the roof and down to the rear photograph.",
                "anchor": rear}

    if needs_anchor(move):
        return {"level": "blocked",
                "reason": "This move needs a photograph of where it ends.",
                "anchor": None}

    # The rest stay with the elevation they were given. They are safe by
    # construction -- their prompts forbid travelling round the building --
    # so the only judgement left is how much room the move has.
    if move == "rise_reveal" and (site or {}).get("depth") == "short":
        return {"level": "safe",
                "reason": "Tight plot, so keep the climb short.",
                "anchor": None}

    return {"level": "safe", "reason": "Stays with the elevation shown.",
            "anchor": None}


def verdicts(site, clips):
    """check_move over a list of {photo, move}."""
    out = []
    for clip in clips or []:
        move = clip.get("move")
        photo = clip.get("photo")
        verdict = check_move(move, photo, site)
        verdict.update({"photo": photo, "move": move})
        out.append(verdict)
    return out


def recommend(site):
    """A sensible exterior sequence for this property.

    Front-to-back only when it can be anchored; otherwise the moves that stay
    with the elevation they are given.
    """
    plan = []
    front = (site or {}).get("front")
    rear = (site or {}).get("rear")
    aerial = (site or {}).get("aerial_close")

    # The flight, in two legs through the aerial. Straight from the ground-level
    # front to the ground-level rear is the version that dissolved: the two
    # photographs share no surface, so there is no path to interpolate. Going
    # via the overhead gives each leg a viewpoint it overlaps with.
    if front and aerial and rear:
        plan.append({"photo": front, "move": "rise_over_roof", "anchor": aerial})
        plan.append({"photo": aerial, "move": "cross_to_rear", "anchor": rear})
    elif front and rear:
        plan.append({"photo": front, "move": "flyover_front_to_back", "anchor": rear})
    elif front and aerial:
        plan.append({"photo": front, "move": "rise_over_roof", "anchor": aerial})
    elif front:
        plan.append({"photo": front, "move": "approach_front", "anchor": None})

    # Any wide aerial is a establishing shot rather than part of the flight.
    for photo in (site or {}).get("aerials") or []:
        if photo != aerial:
            plan.append({"photo": photo, "move": "pull_back_wide", "anchor": None})

    return plan
