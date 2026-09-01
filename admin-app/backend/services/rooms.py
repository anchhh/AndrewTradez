"""
Sorting a listing's photos into rooms.

Photos arrive in whatever order the listing site happened to serve them, which
makes a gallery tedious to read and makes a generated video a slideshow of
unrelated angles. Labelling each photo turns both into something structured:
the profile groups them, and the video generator can order a walkthrough and
pick one good shot per room instead of six near-identical kitchens.

Two economies matter here, because this runs on every captured lead:

  Photos are downscaled before sending. Image tokens scale with area, and a
  512px-wide copy is more than enough to tell a kitchen from a bathroom -- it
  costs about a quarter of what the full-size photo would.

  Photos go up in batches rather than one request each, so 57 photos is about
  eight calls instead of fifty-seven.

Nothing here is load-bearing: if it fails, the lead keeps all its photos
unsorted, exactly as before.
"""
import base64
import io
import json
import logging
import os
import re

log = logging.getLogger(__name__)

MODEL = "claude-opus-5"
BATCH_SIZE = 8
MAX_EDGE = 512          # px; enough to identify a room, a quarter the tokens
JPEG_QUALITY = 70

# A closed vocabulary. Free-form labels drift ("Master Bath" vs "Primary
# Bathroom" vs "En-suite") and can't be grouped or sorted afterwards.
ROOMS = [
    "exterior_front", "exterior_back", "aerial", "living", "kitchen", "dining",
    "primary_bedroom", "bedroom", "primary_bath", "bath", "office", "laundry",
    "garage", "basement", "stairs_hall", "closet", "outdoor_space",
    "floor_plan", "other",
]

# How a label reads in the UI, and the order a walkthrough should follow --
# the sequence a person would walk the house in, not alphabetical.
ROOM_LABELS = [
    ("exterior_front", "Front exterior"),
    ("aerial", "Aerial"),
    ("living", "Living"),
    ("kitchen", "Kitchen"),
    ("dining", "Dining"),
    ("stairs_hall", "Stairs & hallway"),
    ("primary_bedroom", "Primary bedroom"),
    ("primary_bath", "Primary bath"),
    ("bedroom", "Bedroom"),
    ("bath", "Bath"),
    ("office", "Office"),
    ("closet", "Closet"),
    ("laundry", "Laundry"),
    ("basement", "Basement"),
    ("garage", "Garage"),
    ("outdoor_space", "Outdoor space"),
    ("exterior_back", "Back exterior"),
    ("floor_plan", "Floor plan"),
    ("other", "Other"),
]
ROOM_ORDER = {key: i for i, (key, _) in enumerate(ROOM_LABELS)}
ROOM_DISPLAY = dict(ROOM_LABELS)

SYSTEM = f"""You label real-estate listing photos by which room or area they show.

For each image, return exactly one label from this list:
{", ".join(ROOMS)}

Rules:
- "primary_bedroom" / "primary_bath" only when it is clearly the main suite
  (largest bedroom, en-suite, double vanity). A plain guest room is "bedroom".
- "floor_plan" is a drawn plan or diagram, not a photograph.
- "aerial" is a drone or satellite view; "exterior_front" is the street-facing
  elevation from the ground.
- "outdoor_space" is a deck, patio, pool or garden; "exterior_back" is the rear
  elevation of the building itself.
- If genuinely unclear, use "other" and a low confidence rather than guessing.

Reply with ONLY a JSON array, one object per image, in the order given:
[{{"i": 0, "room": "kitchen", "confidence": 0.95}}]
No prose, no code fences."""


class RoomsNotConfigured(Exception):
    """No Anthropic API key available."""


class RoomsError(Exception):
    """The classification call failed."""


def is_configured():
    """Whether a key is available. The SDK also resolves an `ant auth login`
    profile, but this app is only ever configured by key."""
    return bool(os.environ.get("ANTHROPIC_API_KEY") or _key_from_file())


def _key_from_file():
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "anthropic.json"
    )
    if not os.path.exists(path):
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("api_key") or ""
    except (OSError, ValueError):
        return ""


def _client():
    import anthropic

    key = os.environ.get("ANTHROPIC_API_KEY") or _key_from_file()
    if not key:
        raise RoomsNotConfigured(
            "Room sorting isn't connected. Put an Anthropic API key in "
            "studio/anthropic.json (or set ANTHROPIC_API_KEY)."
        )
    return anthropic.Anthropic(api_key=key)


def local_path_for(photo_url):
    name = os.path.basename((photo_url or "").split("?")[0])
    return os.path.join("studio", "static", "uploads", name)


def _encode(path):
    """A downscaled JPEG of the photo, base64'd. None if unreadable."""
    from PIL import Image

    try:
        with Image.open(path) as img:
            img = img.convert("RGB")
            img.thumbnail((MAX_EDGE, MAX_EDGE))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=JPEG_QUALITY)
        return base64.standard_b64encode(buf.getvalue()).decode("utf-8")
    except Exception:  # noqa: BLE001 -- a bad file shouldn't sink the batch
        log.warning("could not read photo for classification: %s", path)
        return None


def _parse(text, count):
    """The model's JSON array, tolerant of stray prose or fences."""
    if not text:
        return []
    match = re.search(r"\[.*\]", text, re.S)
    if not match:
        return []
    try:
        rows = json.loads(match.group(0))
    except ValueError:
        return []

    out = []
    for row in rows if isinstance(rows, list) else []:
        try:
            index = int(row.get("i"))
        except (TypeError, ValueError):
            continue
        room = row.get("room")
        if room not in ROOMS or not (0 <= index < count):
            continue
        try:
            confidence = float(row.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0
        out.append({"i": index, "room": room, "confidence": confidence})
    return out


def classify_batch(client, paths):
    """Labels for one batch of local photo paths, keyed by their index."""
    content = []
    kept = []
    for path in paths:
        data = _encode(path)
        if data is None:
            continue
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": data},
        })
        kept.append(path)

    if not content:
        return {}, []

    content.append({"type": "text", "text": f"Label these {len(kept)} images."})

    import anthropic

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=2000,
            system=SYSTEM,
            # Telling a kitchen from a bathroom does not need deep reasoning,
            # and low effort keeps this affordable to run on every lead.
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIStatusError as exc:
        raise RoomsError(f"HTTP {exc.status_code}: {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise RoomsError(f"could not reach the API: {exc}") from exc

    if response.stop_reason == "refusal":
        raise RoomsError("the request was declined")

    text = "".join(b.text for b in response.content if b.type == "text")
    return {row["i"]: row for row in _parse(text, len(kept))}, kept


def classify_photos(photo_urls, on_progress=None):
    """Label every photo. Returns {photo_url: {room, label, confidence}}.

    Photos that fail to read, or that the model doesn't return a row for, are
    simply absent from the result -- they stay unsorted rather than being
    guessed at.
    """
    client = _client()
    results = {}

    for start in range(0, len(photo_urls), BATCH_SIZE):
        chunk = photo_urls[start:start + BATCH_SIZE]
        paths = [local_path_for(u) for u in chunk]
        by_path = dict(zip(paths, chunk))

        labelled, kept = classify_batch(client, paths)
        for index, row in labelled.items():
            url = by_path.get(kept[index])
            if url:
                results[url] = {
                    "room": row["room"],
                    "label": ROOM_DISPLAY.get(row["room"], row["room"]),
                    "confidence": round(row["confidence"], 2),
                    # Walkthrough rank, carried with the label so the browser
                    # can order photos without a second copy of this list.
                    "order": ROOM_ORDER.get(row["room"], 999),
                }
        if on_progress:
            on_progress(len(results), len(photo_urls))

    return results


def group_photos(photo_urls, rooms):
    """Photos grouped by room, in walkthrough order.

    Returns [{room, label, photos:[...]}]. Anything unlabelled lands in a
    trailing "Unsorted" group rather than being hidden.
    """
    buckets = {}
    unsorted_photos = []
    for url in photo_urls or []:
        entry = (rooms or {}).get(url)
        if not entry:
            unsorted_photos.append(url)
            continue
        buckets.setdefault(entry["room"], []).append(url)

    groups = [
        {
            "room": room,
            "label": ROOM_DISPLAY.get(room, room),
            "photos": buckets[room],
        }
        for room in sorted(buckets, key=lambda r: ROOM_ORDER.get(r, 999))
    ]
    if unsorted_photos:
        groups.append({"room": "unsorted", "label": "Unsorted", "photos": unsorted_photos})
    return groups
