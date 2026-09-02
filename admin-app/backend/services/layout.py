"""
Working out how a house fits together, so a camera move reveals what is
actually there.

The problem this exists for, found the hard way on the first real clip: the
camera panned right out of a living room and the model invented a door.
Panning right in that house actually reaches the kitchen. Seedance is given
ONE photograph and a prompt -- it cannot see the other thirty-six -- so when
the move leaves the frame it has nothing to draw on and makes something up.

No prompt fixes that, because the information is not in the request. Two
things do:

  1. `last_image`. Seedance accepts a final frame as well as a first one. Give
     it the living room and the kitchen and it interpolates between two real
     photographs instead of inventing the space between them. This is the
     actual fix, and it is why this module's real output is a NEIGHBOUR, not a
     description.

  2. Refusing to render moves that would leave the known house. If nothing in
     the listing shows what is to the right of a photo, panning right is a
     guess, and the honest answer is to say so before the money is spent
     rather than after.

The analysis runs on contact sheets rather than thirty-seven separate images:
the model needs to compare photographs with each other to place them, which is
exactly what a numbered grid is for, and it is one request instead of thirty-
seven. Gemini does it on the free tier.
"""
import json
import os
import re

# Contact sheets are already built for room sorting; the same numbering is
# reused here so an index means the same photo in both.
from contact_sheet import build_sheets

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "studio", "_layout")

# Which move leaves the frame in which direction. "static" is absent on
# purpose: it never leaves the frame, so it never needs a neighbour and is
# always safe.
MOVE_DIRECTION = {
    "pan_left": "left",
    "orbit_left": "left",
    "pan_right": "right",
    "orbit_right": "right",
    "push_in": "forward",
    "pull_out": "behind",
    "rise": "above",
    "tilt_up": "above",
}

# Moves that stay inside the photograph. Nothing outside the frame is
# revealed, so nothing can be invented to fill it.
SAFE_ANYWHERE = {"static"}

PROMPT = """You are looking at contact sheets of every photograph from one property
listing. Each tile is numbered.

Work out how this house fits together, then answer for EVERY numbered photo.

For each photo, decide what a camera would see if it moved off each edge of
that photograph, and whether another numbered photo shows it.

Reply with ONLY a JSON array, one object per photo, no prose:

[{"i": 0,
  "room": "short room name",
  "left": {"is": "what is off the left edge", "photo": 12},
  "right": {"is": "...", "photo": null},
  "forward": {"is": "what is further into the scene", "photo": 5},
  "behind": {"is": "what is behind the camera", "photo": null},
  "above": {"is": "what is above the frame", "photo": null}}]

Rules:
- "photo" is the number of another tile that actually SHOWS that space, or
  null if no photo in this listing shows it. Be strict: only give a number
  when you are confident it is the same space, recognisable by shared
  flooring, walls, fittings or the view through an opening.
- "is" is a short phrase like "kitchen through the doorway", "blank wall",
  "the front garden", or "unknown".
- If you cannot tell what is beyond an edge, use "unknown" and null.
- Exterior and aerial photos: the neighbours are usually null.
- Never invent a room the photographs do not show."""


class LayoutError(Exception):
    """The analysis could not be produced."""


def cache_path(lead_id):
    return os.path.join(CACHE_DIR, "lead%s.json" % lead_id)


def load_cached(lead_id):
    path = cache_path(lead_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError):
        return None


def save_cached(lead_id, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(cache_path(lead_id), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)


def _parse(text):
    """The JSON array out of whatever the model wrapped it in."""
    if not text:
        raise LayoutError("the layout analysis came back empty")
    match = re.search(r"\[.*\]", text, re.S)
    if not match:
        raise LayoutError("no JSON found in the layout analysis")
    try:
        parsed = json.loads(match.group(0))
    except ValueError as exc:
        raise LayoutError("the layout analysis was not valid JSON: %s" % exc) from exc
    if not isinstance(parsed, list):
        raise LayoutError("the layout analysis was not a list")
    return parsed


def analyse(lead_id, photo_urls, force=False):
    """{index: {room, left, right, forward, behind, above}} for a listing.

    Cached per lead: the layout of a house does not change, and the whole
    point is to run this before a render without adding a minute to it.
    """
    if not force:
        cached = load_cached(lead_id)
        if cached and cached.get("count") == len(photo_urls):
            return cached

    from services import gemini_image

    sheets = build_sheets(lead_id, photo_urls)
    if not sheets:
        raise LayoutError("no contact sheets could be built for this listing")

    images = []
    for sheet in sheets:
        with open(sheet, "rb") as fh:
            images.append(fh.read())

    text = gemini_image.ask_about_images(images, PROMPT, timeout=180)
    rows = _parse(text)

    by_index = {}
    for row in rows:
        try:
            index = int(row.get("i"))
        except (TypeError, ValueError):
            continue
        if not 0 <= index < len(photo_urls):
            continue
        entry = {"room": row.get("room") or ""}
        for direction in ("left", "right", "forward", "behind", "above"):
            side = row.get(direction) or {}
            neighbour = side.get("photo")
            if not isinstance(neighbour, int) or not 0 <= neighbour < len(photo_urls):
                neighbour = None
            if neighbour == index:
                neighbour = None
            entry[direction] = {"is": (side.get("is") or "unknown"), "photo": neighbour}
        by_index[index] = entry

    data = {"count": len(photo_urls), "photos": by_index}
    save_cached(lead_id, data)
    return data


def check_move(layout, photo_index, move):
    """Is this move safe on this photo, and what should the last frame be?

    Returns {ok, level, reason, neighbour} where level is:
      "safe"    -- the move stays inside the photograph
      "anchored" -- it leaves the frame, but another photo shows what is there,
                    so that photo can be the final frame and nothing is invented
      "risky"   -- it leaves the frame into space no photograph shows
    """
    if move in SAFE_ANYWHERE:
        return {"ok": True, "level": "safe", "neighbour": None,
                "reason": "The camera stays inside the photograph."}

    direction = MOVE_DIRECTION.get(move)
    if not direction:
        return {"ok": True, "level": "safe", "neighbour": None, "reason": ""}

    entry = ((layout or {}).get("photos") or {}).get(photo_index) \
        or ((layout or {}).get("photos") or {}).get(str(photo_index))
    if not entry:
        return {"ok": False, "level": "risky", "neighbour": None,
                "reason": "This photo hasn't been analysed yet."}

    side = entry.get(direction) or {}
    what = side.get("is") or "unknown"
    neighbour = side.get("photo")

    if neighbour is not None:
        return {"ok": True, "level": "anchored", "neighbour": neighbour,
                "reason": "Moves toward %s, which photo %s shows — that photo "
                          "becomes the final frame." % (what, neighbour + 1)}

    if what.lower().startswith("unknown"):
        return {"ok": False, "level": "risky", "neighbour": None,
                "reason": "Nothing in the listing shows what is %s of this "
                          "photo, so the model would invent it." % direction}

    return {"ok": False, "level": "risky", "neighbour": None,
            "reason": "Moves toward %s, but no photo shows it — the model "
                      "would invent it." % what}


# Which moves are worth having, best first, when several are equally safe.
#
# An anchored move beats a hold every time -- it is real motion between two
# real photographs, which is the whole point of a listing video. Among
# anchored moves this is the order a tour would actually use: push through a
# space, pull back to reveal it, then the sideways ones, then the vertical
# ones, which are mostly exterior shots.
PREFERENCE = [
    "push_in", "pull_out", "pan_left", "pan_right",
    "orbit_left", "orbit_right", "rise", "tilt_up",
]

ALL_MOVES = PREFERENCE + ["static"]


def verdicts(layout, photo_index):
    """Every move judged for one photo, best first.

    The ordering is the recommendation: anchored moves first in preference
    order, then the hold, then anything that would invent.
    """
    rows = []
    for move in ALL_MOVES:
        check = check_move(layout, photo_index, move)
        rows.append({
            "move": move,
            "level": check["level"],
            "reason": check["reason"],
            "neighbour": check["neighbour"],
        })

    rank = {"anchored": 0, "safe": 1, "risky": 2}
    order = {move: i for i, move in enumerate(ALL_MOVES)}
    rows.sort(key=lambda r: (rank.get(r["level"], 3), order.get(r["move"], 99)))
    return rows


def recommend(layout, photo_index):
    """The move to use on this photo, and why.

    Never returns a risky move. If nothing is anchored the answer is the hold,
    because a still that barely moves is always publishable and a pan into
    invented architecture is not.
    """
    rows = verdicts(layout, photo_index)
    best = next((r for r in rows if r["level"] in ("anchored", "safe")), None)
    if best is None:
        return {"move": "static", "level": "safe",
                "reason": "Nothing else can be done safely on this photo."}
    return {"move": best["move"], "level": best["level"], "reason": best["reason"]}
