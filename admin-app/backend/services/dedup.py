"""
Cross-source deduplication.

Goal: the same physical property showing up from two different feeds
(e.g. a licensed Zillow partner feed AND a Realtor.com feed) should collapse
into one Lead row, not two. We can't rely on external_id for this since
each source mints its own IDs for the same property -- so the dedup key is
built from the property's address instead, normalized enough that minor
formatting differences from different sources still match.

This is a heuristic, not a guarantee: legitimately distinct units at the
same building/zip with very similar address text could theoretically
collide. Good enough for a v1; tighten with unit-number-aware parsing if
that turns out to matter in practice.
"""
import re

_ABBREVIATIONS = {
    "street": "st", "avenue": "ave", "boulevard": "blvd", "drive": "dr",
    "lane": "ln", "road": "rd", "court": "ct", "circle": "cir",
    "place": "pl", "terrace": "ter", "parkway": "pkwy", "highway": "hwy",
    "apartment": "apt", "suite": "ste", "north": "n", "south": "s",
    "east": "e", "west": "w",
}


def normalize_address(address):
    if not address:
        return ""
    text = address.lower().strip()
    text = re.sub(r"[.,#]", " ", text)
    text = re.sub(r"\s+", " ", text)
    words = text.split(" ")
    words = [_ABBREVIATIONS.get(w, w) for w in words]
    return " ".join(words).strip()


def compute_dedup_key(address, zip_code=None):
    normalized = normalize_address(address)
    if not normalized:
        return None
    zip_part = (zip_code or "").strip()
    return f"{normalized}|{zip_part}"
