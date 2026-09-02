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
"""
import json
import os
import re

from contact_sheet import build_sheets

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "studio", "_site")

# The labels room sorting already assigns. Only these photographs are worth
# sending: an exterior analysis has nothing to learn from a bathroom.
OUTSIDE_ROOMS = ("exterior_front", "exterior_back", "aerial", "outdoor_space")


class SiteError(Exception):
    """The site could not be analysed."""


PROMPT = """You are looking at the OUTSIDE of one property, to plan a drone shot.

The first image is an overhead satellite view of the property, if one was
available. The remaining images are numbered contact sheets of the listing's
own exterior photographs. Each photo has its number printed on it, and the
numbering STARTS AT 0. Answer with those printed numbers exactly.

Answer ONLY with a JSON object, no prose, no markdown fence:

{
  "front": <number of the single best photograph of the FRONT of the house --
            the street-facing elevation, usually with the main door, driveway
            or garage -- or null if none shows it>,
  "rear": <number of the single best photograph of the BACK of the house --
           the elevation facing the garden or yard -- or null if NO photograph
           shows the rear of the building>,
  "aerials": [<numbers of any photographs taken from the air>],
  "front_faces": "<which way the front of the house faces in the satellite
                   view: north, south, east, west, or unknown>",
  "rear_shown": <true only if one of the photographs genuinely shows the back
                 of the BUILDING. A photograph of a garden, deck or pool that
                 does not show the rear wall of the house is NOT the rear.>,
  "depth": "<short|medium|long> -- how far it is from the street frontage to
            the back of the plot, judged from the satellite view>",
  "notes": "<one or two sentences on the layout: where the street is, what is
             behind the house, anything that would make a flight over the
             property go wrong>"
}

Be strict about "rear". Getting this wrong causes a video that invents a back
of a house that nobody has photographed. If you are not certain a photograph
shows the rear elevation of the building, answer null and false.
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


def analyse(lead_id, address, photo_urls, photo_rooms, force=False):
    """What the outside of this property looks like, and what can be flown.

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

    sheets = build_sheets("site%s" % lead_id, outside)
    if not sheets:
        raise SiteError("no contact sheet could be built for the exteriors")

    images = []
    sat = satellite_bytes(address)
    if sat:
        images.append(sat)
    for sheet in sheets:
        with open(sheet, "rb") as fh:
            images.append(fh.read())

    raw = _parse(gemini_image.ask_about_images(images, PROMPT, timeout=180))

    def photo_at(number):
        # The contact sheets print ZERO-based indexes, over `outside` rather
        # than over every photo in the listing. Reading them as 1-based made
        # the analysis look wrong when it was right -- it named the back of
        # the house and this returned the front.
        try:
            index = int(number)
        except (TypeError, ValueError):
            return None
        return outside[index] if 0 <= index < len(outside) else None

    front = photo_at(raw.get("front"))
    rear = photo_at(raw.get("rear")) if raw.get("rear_shown") else None

    data = {
        "count": len(outside),
        "satellite": bool(sat),
        "photos": outside,
        "front": front,
        "rear": rear,
        "aerials": [p for p in (photo_at(n) for n in raw.get("aerials") or []) if p],
        "front_faces": raw.get("front_faces") or "unknown",
        "depth": raw.get("depth") or "unknown",
        "notes": (raw.get("notes") or "").strip(),
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

    if move == "flyover_front_to_back":
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

    if front and rear:
        plan.append({"photo": front, "move": "flyover_front_to_back", "anchor": rear})
    elif front:
        plan.append({"photo": front, "move": "approach_front", "anchor": None})

    for photo in (site or {}).get("aerials") or []:
        plan.append({"photo": photo, "move": "pull_back_wide", "anchor": None})

    if front and not rear:
        plan.append({"photo": front, "move": "rise_reveal", "anchor": None})

    return plan
