"""
estly Studio -- real estate listing intake + AI video generation, mounted as
a Flask Blueprint at /studio/* inside the Estly Admin app.

Originally a standalone Flask app; merged in so leads captured by the admin
ingestion pipeline can flow straight into video creation (see the "Create
Video" link on each lead, which opens /studio/create?lead_id=<id>).

Auth is intentionally separate from Estly Admin's Basic Auth gate: this
blueprint has its own account system (email/password + optional Google
OAuth), scoped entirely to paths under /studio/ (Estly Admin's Basic Auth
only gates bare /api/* paths -- see backend/auth.py -- so it never applies
here). Data still lives in flat JSON files (projects.json/users.json) next
to this package rather than the SQLAlchemy `db` the rest of the admin app
uses; unifying those is future work.
"""
import base64
import binascii
import io
import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlencode, quote, urljoin, urlparse

import requests
from authlib.integrations.flask_client import OAuth
from bs4 import BeautifulSoup
from flask import (Blueprint, jsonify, redirect, render_template, request,
                   send_file, session, url_for)
from PIL import Image
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
PROJECTS_FILE = BASE_DIR / "projects.json"
USERS_FILE = BASE_DIR / "users.json"
SECRET_KEY_FILE = BASE_DIR / ".secret_key"
GOOGLE_OAUTH_CONFIG_FILE = BASE_DIR / "google_oauth.json"
GOOGLE_MAPS_CONFIG_FILE = BASE_DIR / "google_maps.json"
ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "heic"}
ALLOWED_VIDEO_EXTENSIONS = {"mp4", "mov", "webm", "m4v"}
ALLOWED_EXTENSIONS = ALLOWED_IMAGE_EXTENSIONS | ALLOWED_VIDEO_EXTENSIONS

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

studio_bp = Blueprint(
    "studio",
    __name__,
    template_folder="templates",
    static_folder="static",
    # Flask prepends the blueprint's own url_prefix to static_url_path too,
    # so "/static" here becomes the intended "/studio/static" -- passing
    # "/studio/static" directly double-prefixes to "/studio/studio/static".
    static_url_path="/static",
    url_prefix="/studio",
)

oauth = OAuth()
GOOGLE_OAUTH_ENABLED = False
STREETVIEW_ENABLED = False
GOOGLE_MAPS_API_KEY = None


def init_studio(app):
    """Wires this blueprint's app-level needs (secret key, OAuth, size
    limit) into the shared Flask app, then registers the blueprint. Call
    once from the main app's create_app()."""
    global GOOGLE_OAUTH_ENABLED, STREETVIEW_ENABLED, GOOGLE_MAPS_API_KEY

    if not app.secret_key:
        if SECRET_KEY_FILE.exists():
            app.secret_key = SECRET_KEY_FILE.read_text(encoding="utf-8").strip()
        else:
            app.secret_key = secrets.token_hex(32)
            SECRET_KEY_FILE.write_text(app.secret_key, encoding="utf-8")

    app.config["MAX_CONTENT_LENGTH"] = max(
        app.config.get("MAX_CONTENT_LENGTH") or 0, 2 * 1024 * 1024 * 1024
    )

    _google_config = {}
    if GOOGLE_OAUTH_CONFIG_FILE.exists():
        try:
            _google_config = json.loads(GOOGLE_OAUTH_CONFIG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _google_config = {}
    google_client_id = os.environ.get("GOOGLE_CLIENT_ID") or _google_config.get("client_id")
    google_client_secret = os.environ.get("GOOGLE_CLIENT_SECRET") or _google_config.get("client_secret")
    GOOGLE_OAUTH_ENABLED = bool(google_client_id and google_client_secret)

    oauth.init_app(app)
    if GOOGLE_OAUTH_ENABLED:
        oauth.register(
            name="google",
            client_id=google_client_id,
            client_secret=google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )

    _google_maps_config = {}
    if GOOGLE_MAPS_CONFIG_FILE.exists():
        try:
            _google_maps_config = json.loads(GOOGLE_MAPS_CONFIG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            _google_maps_config = {}
    GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY") or _google_maps_config.get("api_key")
    STREETVIEW_ENABLED = bool(GOOGLE_MAPS_API_KEY)

    app.register_blueprint(studio_bp)


BLOCK_SIGNS = [
    "captcha",
    "access denied",
    "px-captcha",
    "are you a human",
    "request unsuccessful",
    "unusual traffic",
    "verify you are a human",
]

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

SKIP_URL_HINTS = (
    "sprite",
    "icon",
    "favicon",
    "logo",
    "avatar",
    "placeholder",
    "blank.gif",
    "pixel.",
    "1x1.",
    "spacer.",
    "tracking",
    "noscript",
    "collector",
    "share_thumbnail",
    "nophoto",
    "/static/images/",
)

MAX_IMAGE_CANDIDATES = 250

# Geocoding (Nominatim/OpenStreetMap) and satellite export (Esri World
# Imagery) are both free, keyless, and have global coverage -- no API key
# setup required to get overhead/aerial context for drone-style video framing.
NOMINATIM_HEADERS = {
    "User-Agent": "estly-studio-app/1.0 (local dev tool; contact: local-user)"
}
SATELLITE_EXPORT_URL = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export"
# (buffer in degrees, image size in px) tried in order, widest-context first;
# falls back to a wider/lower-res view if the imagery cache can't satisfy a
# tighter zoom in that area (common outside dense suburban/urban regions).
SATELLITE_ZOOM_LADDER = [(0.0012, 1024), (0.0025, 800), (0.005, 600), (0.01, 600)]

CONTENT_TYPE_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

# Matches an image URL either written plainly in HTML/CSS or embedded inside a
# JSON blob in an inline <script> tag (where "/" is often escaped as "\/").
RAW_IMAGE_URL_RE = re.compile(
    r"https?:\\?/\\?/[^\s\"'()<>]+?\.(?:jpg|jpeg|png|webp)", re.IGNORECASE
)

# Size/format variant tokens that real-estate & listing CDNs (Zillow, Redfin,
# Airbnb, etc.) append to an otherwise-identical photo URL. Stripping these
# collapses "the same photo at 8 sizes x 2 formats" down to one dedup key
# before we ever download anything.
VARIANT_SUFFIX_RE = re.compile(
    r"[-_](?:"
    r"cc_ft_\d+"
    r"|uncropped_scaled_within_\d+_\d+"
    r"|scaled_within_\d+_\d+"
    r"|\d{2,4}x\d{2,4}"
    r"|\d{2,4}w"
    r"|[a-z]_[a-z]"
    r"|thumb(?:nail)?"
    r"|small|medium|large|orig(?:inal)?"
    r")$",
    re.IGNORECASE,
)
RETINA_SUFFIX_RE = re.compile(r"@\d+x$")
SIZE_HINT_RE = re.compile(r"\d{2,4}")
FORMAT_RANK = {"jpg": 0, "jpeg": 0, "png": 1, "webp": 2, "gif": 3}


# Redfin serves each gallery photo from three sibling paths under the same
# media bundle -- ".../<bundle>/item_47.jpg", ".../genLdpUgcMediaBrowserUrl/
# item_47.jpg" and ".../genLdpUgcMediaBrowserUrlComp/item_47.jpg". They differ
# by directory, not filename, so the suffix-based key below saw three separate
# photos. Measured on a real listing: 22 photos were arriving as 66.
REDFIN_RENDITION_RE = re.compile(r"/gen[A-Za-z]*MediaBrowserUrl[A-Za-z]*(?=/)", re.I)

# The other Redfin shape varies only by a size directory --
# /photo/158/{mbpaddedwide,mbphotov3,midphoto}/538/genMid.1890538_14_1.jpg is
# one photo in three renditions. Same problem, same fix: collapse the segment
# so they key alike.
REDFIN_SIZE_DIR_RE = re.compile(r"(/photo/\d+/)[a-z0-9]+(/\d+/)", re.I)

# A media bundle carries five renditions of every photo -- bare,
# genFirstLookEmail, genLdpUgcMediaBrowserUrl, ...Comp and genLdpUgcThumb --
# so a 56-photo listing arrives as 280 URLs unless they key alike.
REDFIN_BUNDLE_RENDITION_RE = re.compile(
    r"(/system_files/media/[^/]+/)gen[A-Za-z0-9]+/", re.I
)

# --- Isolating the listing you're on from everything else on the page -----
#
# These pages embed carousels of *other* homes, and a scan of the HTML can't
# tell them apart by itself. Each rule below was derived by counting real
# pages against the photo count the site itself displays, not assumed.

# Zillow: gallery photos are served in "cc_ft" (content) renditions; photos of
# other listings appear only as "sr_" (search-result) renditions. On
# 6127 W 16th St: 58 distinct photo hashes in the HTML, exactly 35 with a
# cc_ft variant, and the page reads "See all 35 photos". Zero overlap between
# the two sets.
ZILLOW_GALLERY_MARKER = "-cc_ft_"

# Redfin uses two different URL shapes depending on the listing, and og:image
# points into whichever one the subject uses -- either a numbered media bundle
# (/system_files/media/1242747_JPG/item_47.jpg) or a photo id
# (/photo/158/mbpaddedwide/538/genMid.1890538_0.jpg). Both carry an id that
# the subject's photos share and other listings' don't.
REDFIN_PHOTO_ID_RE = re.compile(r"/system_files/media/(\d+)_|genMid\.(\d+)_", re.I)

# Redfin serves each gallery photo from three sibling paths under the same
# media bundle -- ".../<bundle>/item_47.jpg", ".../genLdpUgcMediaBrowserUrl/
# item_47.jpg" and ".../genLdpUgcMediaBrowserUrlComp/item_47.jpg". They differ
# by directory, not filename, so the suffix-based key below saw three separate
# photos. Measured on a real listing: 22 photos were arriving as 66.
REDFIN_RENDITION_RE = re.compile(r"/gen[A-Za-z]*MediaBrowserUrl[A-Za-z]*(?=/)", re.I)

# The other Redfin shape varies only by a size directory --
# /photo/158/{mbpaddedwide,mbphotov3,midphoto}/538/genMid.1890538_14_1.jpg is
# one photo in three renditions. Same problem, same fix: collapse the segment
# so they key alike.
REDFIN_SIZE_DIR_RE = re.compile(r"(/photo/\d+/)[a-z0-9]+(/\d+/)", re.I)

# A media bundle carries five renditions of every photo -- bare,
# genFirstLookEmail, genLdpUgcMediaBrowserUrl, ...Comp and genLdpUgcThumb --
# so a 56-photo listing arrives as 280 URLs unless they key alike.
REDFIN_BUNDLE_RENDITION_RE = re.compile(
    r"(/system_files/media/[^/]+/)gen[A-Za-z0-9]+/", re.I
)


def _listing_slug(page_url):
    """The address slug a site puts in its own URL. homes.com repeats it in
    every real photo's filename and in none of its chrome."""
    match = re.search(r"/(?:property|homedetails)/([^/]+)", page_url or "", re.I)
    return match.group(1).lower() if match else None


def subject_photos_only(urls: list[str], og_image: str | None, page_url: str | None = None) -> list[str]:
    """Drop images belonging to *other* listings shown on the same page.

    Anchors on og:image, which is always a photo of the listing you're
    actually looking at. Returns the input unchanged when no rule applies,
    and never returns an empty list -- a filter that matched nothing means
    the assumption was wrong, and some photos beat none.
    """
    if not urls:
        return urls
    og = og_image or ""

    if "zillowstatic.com" in og:
        kept = [u for u in urls if ZILLOW_GALLERY_MARKER in u]
        return kept or urls

    redfin = REDFIN_PHOTO_ID_RE.search(og)
    if redfin:
        photo_id = redfin.group(1) or redfin.group(2)
        in_filename = re.compile(r"(^|[/.])" + re.escape(photo_id) + "_")
        kept = [
            u for u in urls
            if f"/media/{photo_id}_" in u or in_filename.search(u.rsplit("/", 1)[-1])
        ]
        return kept or urls

    slug = _listing_slug(page_url)
    if slug:
        kept = [u for u in urls if slug in u.lower()]
        return kept or urls

    # Generic fallback for sites without a verified rule (Realtor.com today --
    # it answers 429 to this server, so no real page was available to derive
    # one from). A gallery is normally served from one directory, and og:image
    # is always a photo of the subject, so prefer that directory when it
    # accounts for more than a lone image. Otherwise at least stay on the CDN
    # og:image came from, which drops unrelated hosts.
    if og.startswith("http"):
        directory = og.split("?")[0].rsplit("/", 1)[0] + "/"
        kept = [u for u in urls if u.startswith(directory)]
        if len(kept) > 1:
            return kept
        host = urlparse(og).netloc
        kept = [u for u in urls if urlparse(u).netloc == host]
        return kept or urls

    return urls


def normalize_photo_key(url: str) -> str:
    """Collapse different size/format variants of the same photo to one key."""
    path = url.split("?")[0].split("#")[0]
    # Strip the rendition prefix first: the directory collapses below remove
    # the slash this pattern needs to anchor on.
    path = re.sub(r"/gen[A-Za-z]+\.(?=\d)", "/", path)
    path = REDFIN_RENDITION_RE.sub("", path)
    path = REDFIN_BUNDLE_RENDITION_RE.sub(r"\1", path)
    path = REDFIN_SIZE_DIR_RE.sub(r"\1\2", path)
    if "." in path.rsplit("/", 1)[-1]:
        base, ext = path.rsplit(".", 1)
    else:
        base, ext = path, ""
    base = VARIANT_SUFFIX_RE.sub("", base)
    base = RETINA_SUFFIX_RE.sub("", base)
    return base.lower()


def photo_quality_rank(url: str):
    """Higher is better: prefer the largest size hint, then a broadly
    compatible format (jpg/png over webp/gif). Only looks at the size/variant
    suffix that normalize_photo_key() strips off -- not the whole URL -- so
    digits inside the photo's own hash/id never get mistaken for a size."""
    path = url.split("?")[0].split("#")[0]
    if "." in path.rsplit("/", 1)[-1]:
        base, ext = path.rsplit(".", 1)
    else:
        base, ext = path, ""
    stripped = RETINA_SUFFIX_RE.sub("", VARIANT_SUFFIX_RE.sub("", base))
    suffix = base[len(stripped):]
    sizes = [int(n) for n in SIZE_HINT_RE.findall(suffix)]
    max_size = max(sizes) if sizes else 0
    # Among Redfin's renditions of one photo, the "...Comp" path is the
    # compressed copy; prefer anything else.
    rendition_rank = 0 if "comp/" in url.lower() else 1
    return (max_size, rendition_rank, -FORMAT_RANK.get(ext.lower(), 5))


def dedupe_photo_variants(urls: list[str]) -> list[str]:
    """Group same-photo size/format variants and keep the single best URL
    from each group, preserving first-seen order."""
    groups: dict[str, list[str]] = {}
    order: list[str] = []
    for url in urls:
        key = normalize_photo_key(url)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(url)
    return [max(groups[key], key=photo_quality_rank) for key in order]


def average_hash(image_bytes: bytes, hash_size: int = 8):
    """Perceptual hash: treats visually-identical images (including resized
    or re-encoded copies of the same photo) as duplicates, unlike a byte- or
    URL-based comparison."""
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("L").resize(
            (hash_size, hash_size), Image.LANCZOS
        )
    except Exception:
        return None
    pixels = list(img.getdata())
    avg = sum(pixels) / len(pixels)
    bits = "".join("1" if p > avg else "0" for p in pixels)
    return int(bits, 2)


def hamming_distance(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


DUPLICATE_HASH_THRESHOLD = 4  # out of 64 bits. Measured against real listing
# photos: genuine same-photo-different-size/format duplicates land at
# distance 0-3, while distinct (but visually similar, e.g. two bedrooms with
# the same paint color) photos start at 5+. 4 sits in the gap between them.


def local_path_from_url(url: str):
    if url and "/studio/static/uploads/" in url:
        return UPLOAD_DIR / url.rsplit("/", 1)[-1]
    return None


def hash_existing_photos(urls: list[str]) -> list[int]:
    hashes = []
    for url in urls or []:
        path = local_path_from_url(url)
        if path and path.exists():
            h = average_hash(path.read_bytes())
            if h is not None:
                hashes.append(h)
    return hashes


def is_duplicate(new_hash: int, known_hashes: list[int]) -> bool:
    return any(hamming_distance(new_hash, h) <= DUPLICATE_HASH_THRESHOLD for h in known_hashes)


def geocode_address(address: str):
    """Free, keyless geocoding via OpenStreetMap's Nominatim. Returns
    (lat, lon) or None. Respects Nominatim's usage policy: one request per
    call site, identifying User-Agent, no bulk/parallel hammering."""
    if not address or not address.strip():
        return None
    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": address, "format": "json", "limit": 1},
            headers=NOMINATIM_HEADERS,
            timeout=10,
        )
        results = resp.json()
        if not results:
            return None
        return float(results[0]["lat"]), float(results[0]["lon"])
    except (requests.RequestException, ValueError, KeyError, IndexError):
        return None


def fetch_satellite_image(lat: float, lon: float):
    """Free, keyless overhead/satellite export via Esri World Imagery.
    Tries progressively wider/lower-res crops (SATELLITE_ZOOM_LADDER) since a
    tight zoom can exceed the cached imagery's max resolution in less-dense
    areas. Returns image bytes or None."""
    for buf, size in SATELLITE_ZOOM_LADDER:
        bbox = f"{lon - buf:.6f},{lat - buf:.6f},{lon + buf:.6f},{lat + buf:.6f}"
        try:
            resp = requests.get(
                SATELLITE_EXPORT_URL,
                params={
                    "bbox": bbox,
                    "bboxSR": "4326",
                    "size": f"{size},{size}",
                    "format": "png",
                    "f": "image",
                },
                timeout=15,
            )
            if resp.status_code == 200 and "image" in resp.headers.get("Content-Type", ""):
                return resp.content
        except requests.RequestException:
            continue
    return None


def save_satellite_image_for_address(address: str):
    """Geocode an address and fetch+save its overhead view in one step.
    Returns (local_url, lat, lon) or (None, None, None)."""
    coords = geocode_address(address)
    if not coords:
        return None, None, None
    lat, lon = coords
    image_bytes = fetch_satellite_image(lat, lon)
    if not image_bytes:
        return None, lat, lon
    unique_name = secure_filename(f"{uuid.uuid4().hex}.png")
    (UPLOAD_DIR / unique_name).write_bytes(image_bytes)
    return f"/studio/static/uploads/{unique_name}", lat, lon


def load_projects():
    if PROJECTS_FILE.exists():
        return json.loads(PROJECTS_FILE.read_text(encoding="utf-8"))
    return []


def save_projects(projects):
    PROJECTS_FILE.write_text(json.dumps(projects, indent=2), encoding="utf-8")


def load_users():
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    return []


def save_users(users):
    USERS_FILE.write_text(json.dumps(users, indent=2), encoding="utf-8")


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def find_user_by_email(email):
    email = (email or "").strip().lower()
    return next((u for u in load_users() if u["email"] == email), None)


def find_user_by_google_id(google_id):
    return next((u for u in load_users() if u.get("google_id") == google_id), None)


def create_user(email, password=None, google_id=None):
    """Creates the account and, if this is the very first account on a fresh
    install, hands it any projects that were created before accounts existed
    instead of orphaning them."""
    users = load_users()
    is_first_user = len(users) == 0
    user = {
        "id": uuid.uuid4().hex,
        "email": email.strip().lower(),
        "password_hash": generate_password_hash(password) if password else None,
        "google_id": google_id,
        "created_at": time.time(),
    }
    users.append(user)
    save_users(users)

    if is_first_user:
        projects = load_projects()
        changed = False
        for p in projects:
            if not p.get("owner"):
                p["owner"] = user["id"]
                changed = True
        if changed:
            save_projects(projects)

    return user


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return next((u for u in load_users() if u["id"] == user_id), None)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("studio.login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def user_api_key(user):
    """Per-account key the Chrome extension sends so a captured lead can be
    attributed to its owner. The extension posts to the admin API with a
    single shared Basic Auth credential, which says nothing about *who* is
    clipping -- this does. Generated on first read and persisted."""
    if not user:
        return None
    if not user.get("api_key"):
        users = load_users()
        record = next((u for u in users if u["id"] == user["id"]), None)
        if not record:
            return None
        record["api_key"] = secrets.token_urlsafe(24)
        save_users(users)
        user["api_key"] = record["api_key"]
    return user["api_key"]


def user_id_for_api_key(key):
    """Resolve an extension key back to its account. Used by the admin
    /api/leads POST the extension talks to, which has no Studio session."""
    if not key:
        return None
    for user in load_users():
        if user.get("api_key") and secrets.compare_digest(user["api_key"], key):
            return user["id"]
    return None


def owned_leads_query():
    """Base query for the signed-in user's leads. Every /studio/* lead route
    goes through this so one account never sees another's."""
    from models import Lead

    return Lead.query.filter(Lead.owner_id == session.get("user_id"))


def get_owned_lead(lead_id):
    """The lead, or None -- both when it doesn't exist and when it belongs to
    someone else, so a wrong id and someone else's id are indistinguishable
    from outside."""
    from models import Lead

    return (
        Lead.query.filter(Lead.id == lead_id, Lead.owner_id == session.get("user_id")).first()
    )


def display_name_for(user):
    """A first-name-ish greeting name derived from the account's email
    (there's no separate "name" field on the account) -- e.g.
    "andrew.mc42+leads@icloud.com" -> "Andrew"."""
    if not user or not user.get("email"):
        return None
    local_part = user["email"].split("@", 1)[0]
    first_token = re.split(r"[.\-_+0-9]+", local_part, maxsplit=1)[0]
    return first_token.capitalize() or local_part


@studio_bp.context_processor
def inject_user():
    user = current_user()
    return {
        "user": user,
        "display_name": display_name_for(user),
        "google_oauth_enabled": GOOGLE_OAUTH_ENABLED,
        "streetview_enabled": STREETVIEW_ENABLED,
        "google_maps_key": GOOGLE_MAPS_API_KEY or "",
    }


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def best_from_srcset(srcset: str) -> str | None:
    """srcset is a comma-separated list of 'url descriptor' pairs; take the
    widest/highest-density candidate, which is usually the last one listed."""
    candidates = [c.strip() for c in srcset.split(",") if c.strip()]
    if not candidates:
        return None
    last = candidates[-1].split()
    return last[0] if last else None


def looks_like_content_image(url: str) -> bool:
    lower = url.lower()
    if lower.startswith("data:"):
        return False
    if lower.endswith(".svg"):
        return False
    return not any(hint in lower for hint in SKIP_URL_HINTS)


def collect_image_urls(soup: BeautifulSoup, base_url: str, raw_html: str) -> list[str]:
    found = []
    seen = set()
    og_image = None

    def add(raw_url):
        if not raw_url:
            return
        absolute = urljoin(base_url, raw_url.strip())
        key = absolute.split("?")[0]
        if key in seen or not looks_like_content_image(absolute):
            return
        seen.add(key)
        found.append(absolute)

    # Open Graph / Twitter card images
    for prop in ("og:image", "og:image:secure_url", "twitter:image"):
        tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
        if tag and tag.get("content"):
            if og_image is None:
                og_image = urljoin(base_url, tag["content"].strip())
            add(tag["content"])

    # JSON-LD structured data (schema.org) often lists the full photo set
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        for item in data if isinstance(data, list) else [data]:
            if not isinstance(item, dict):
                continue
            image_field = item.get("image")
            if isinstance(image_field, str):
                add(image_field)
            elif isinstance(image_field, list):
                for entry in image_field:
                    if isinstance(entry, str):
                        add(entry)
                    elif isinstance(entry, dict):
                        add(entry.get("url"))
            elif isinstance(image_field, dict):
                add(image_field.get("url"))

    # Plain <img> and <source> tags, including common lazy-load attributes
    for tag in soup.find_all(["img", "source"]):
        for attr in ("src", "data-src", "data-lazy-src", "data-original"):
            if tag.get(attr):
                add(tag[attr])
        if tag.get("srcset"):
            add(best_from_srcset(tag["srcset"]))
        if tag.get("data-srcset"):
            add(best_from_srcset(tag["data-srcset"]))

    # Full-page fallback: many modern listing sites (Zillow, Redfin, etc.)
    # render their photo gallery from a JSON blob embedded in an inline
    # <script> tag rather than plain <img> tags. A plain-text regex scan over
    # the unescaped HTML catches those URLs regardless of the site's
    # particular JS framework/data format.
    unescaped = raw_html.replace("\\/", "/")
    for match in RAW_IMAGE_URL_RE.findall(unescaped):
        add(match)

    # The scan above finds every size/format variant of each photo (a single
    # real-estate photo commonly appears as 10-20 near-duplicate URLs); group
    # and keep just the best one per photo before this ever reaches the user.
    return dedupe_photo_variants(
        subject_photos_only(found, og_image, base_url)
    )[:MAX_IMAGE_CANDIDATES]


def guess_source(url: str) -> str:
    host = url.lower()
    if "zillow." in host:
        return "zillow"
    if "airbnb." in host:
        return "airbnb"
    if "redfin." in host:
        return "redfin"
    if "realtor.com" in host:
        return "realtor"
    if "homes.com" in host:
        return "homes"
    if "vrbo." in host:
        return "vrbo"
    return "other"


def extract_meta(url: str) -> dict:
    """Best-effort extraction from a listing URL's *public* preview metadata
    (Open Graph / Twitter Card / JSON-LD tags) -- the same data a site exposes
    for link unfurling in iMessage/Slack/Twitter. Does not attempt to defeat
    bot detection; if the site blocks the request, we say so plainly.
    """
    source = guess_source(url)
    result = {
        "url": url,
        "source": source,
        "blocked": False,
        "error": None,
        "title": None,
        "description": None,
        "image": None,
        "site_name": None,
        "images": [],
        "beds": None,
        "baths": None,
        "sqft": None,
        "property_type": None,
        "satellite_image": None,
        "lat": None,
        "lon": None,
    }

    try:
        resp = requests.get(url, headers=BROWSER_HEADERS, timeout=10)
    except requests.RequestException as exc:
        result["error"] = f"Could not reach that URL ({exc.__class__.__name__})."
        return result

    if resp.status_code in (403, 429):
        result["blocked"] = True
        if source == "homes":
            # Not transient and not fixable here: homes.com refuses this
            # server for both the page and its image CDN, whatever headers
            # are sent. The extension reads the photos in the browser instead.
            result["error"] = (
                "Homes.com blocks servers from reading its pages, so photos can't be "
                "fetched here. Capture the listing with the Estly extension and its "
                "photos come across automatically."
            )
        else:
            result["error"] = (
                f"{source.capitalize()} returned status {resp.status_code} "
                f"({'rate limiting' if resp.status_code == 429 else 'bot detection'}). "
                "Capturing with the Estly extension avoids this, or add the details manually."
            )
        return result

    if resp.status_code != 200:
        result["error"] = f"Site returned status {resp.status_code}."
        return result

    lower_body = resp.text[:20000].lower()
    if any(sign in lower_body for sign in BLOCK_SIGNS):
        result["blocked"] = True
        result["error"] = (
            f"{source.capitalize()} appears to have served a bot-check page. "
            "Enter the details manually and upload photos below."
        )
        return result

    soup = BeautifulSoup(resp.text, "lxml")

    def meta(*names):
        for name in names:
            tag = soup.find("meta", property=name) or soup.find("meta", attrs={"name": name})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return None

    result["title"] = meta("og:title", "twitter:title") or (
        soup.title.string.strip() if soup.title and soup.title.string else None
    )
    result["description"] = meta("og:description", "twitter:description", "description")
    result["image"] = meta("og:image", "twitter:image")
    result["site_name"] = meta("og:site_name")
    result["images"] = collect_image_urls(soup, url, resp.text)

    # Best-effort structured data (schema.org JSON-LD), also public metadata.
    # Beyond the address, grab whatever property facts are available (beds,
    # baths, floor size, property type) -- extra context for AI video
    # generation later, at no extra request cost since we already have this page.
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        candidates = data if isinstance(data, list) else [data]
        for item in candidates:
            if not isinstance(item, dict):
                continue
            addr = item.get("address")
            if addr and not result.get("address"):
                if isinstance(addr, dict):
                    parts = [
                        addr.get("streetAddress"),
                        addr.get("addressLocality"),
                        addr.get("addressRegion"),
                        addr.get("postalCode"),
                    ]
                    result["address"] = ", ".join(p for p in parts if p)
                elif isinstance(addr, str):
                    result["address"] = addr

            if not result.get("beds") and item.get("numberOfBedrooms") is not None:
                result["beds"] = item.get("numberOfBedrooms")
            if not result.get("baths") and item.get("numberOfBathroomsTotal") is not None:
                result["baths"] = item.get("numberOfBathroomsTotal")
            floor_size = item.get("floorSize")
            if not result.get("sqft") and isinstance(floor_size, dict) and floor_size.get("value"):
                result["sqft"] = floor_size.get("value")
            item_type = item.get("@type")
            if not result.get("property_type") and isinstance(item_type, str) and item_type not in (
                "WebPage", "BreadcrumbList", "Organization", "Product",
            ):
                result["property_type"] = item_type

    # Structured JSON-LD addresses are inconsistently present (many for-sale
    # listing pages omit them even though Zillow/Redfin/Realtor always put the
    # address at the front of the page <title>, e.g. "123 Main St, City, ST
    # 12345 | MLS #... | Zillow"). Fall back to that when nothing structured
    # was found -- it's the only address-shaped info we need for geocoding.
    if not result.get("address") and result.get("title"):
        candidate = result["title"].split("|")[0].strip()
        if re.search(r"\d", candidate) and len(candidate) < 100:
            result["address"] = candidate

    # Zillow-style meta descriptions spell out facts in prose even when
    # they're missing from JSON-LD, e.g. "This 1,461 square feet Condo home
    # has 3 bedrooms and 3 bathrooms." Parse that as a fallback source.
    if result.get("description") and not (result.get("beds") and result.get("baths")):
        desc_match = re.search(
            r"([\d,]+)\s*square\s*feet\s+(\w+)\s+home\s+has\s+(\d+)\s+bedrooms?\s+and\s+(\d+)\s+bathrooms?",
            result["description"],
            re.IGNORECASE,
        )
        if desc_match:
            if not result.get("sqft"):
                result["sqft"] = desc_match.group(1).replace(",", "")
            if not result.get("property_type"):
                result["property_type"] = desc_match.group(2)
            if not result.get("beds"):
                result["beds"] = int(desc_match.group(3))
            if not result.get("baths"):
                result["baths"] = int(desc_match.group(4))

    # Overhead/satellite context for later drone-style video generation --
    # free & keyless (OpenStreetMap geocoding + Esri World Imagery export),
    # so this runs automatically whenever we have an address, no setup needed.
    result["satellite_image"] = None
    result["lat"] = None
    result["lon"] = None
    if result.get("address"):
        sat_url, lat, lon = save_satellite_image_for_address(result["address"])
        result["satellite_image"] = sat_url
        result["lat"] = lat
        result["lon"] = lon

    if not result["title"] and not result["images"]:
        result["blocked"] = True
        result["error"] = (
            f"Couldn't read public content from that {source} link "
            "(page likely requires JavaScript / blocks automated requests). "
            "Use manual upload instead."
        )
    elif not result["images"]:
        result["error"] = (
            f"Found the listing title/description, but no usable photos in {source}'s "
            "page HTML (its gallery likely loads via JavaScript). Use manual upload for photos."
        )

    return result


def _lead_prefill(lead_id):
    """Looks up a Lead from the admin ingestion pipeline (same process, same
    DB) and shapes it into the same fields a link-extraction would produce,
    so a lead flows into Create Video exactly like a pasted listing URL
    would. Returns None if the lead doesn't exist or the models aren't
    importable (e.g. this blueprint ever runs standalone again)."""
    try:
        from models import Lead
    except ImportError:
        return None

    lead = get_owned_lead(lead_id)
    if not lead:
        return None

    return {
        "lead_id": lead.id,
        "name": lead.full_address,
        "address": lead.full_address,
        "url": lead.listing_url,
        "source": lead.source,
        "photos": lead.photo_urls,
        # Room labels travel with the lead so Create Video can group the
        # photos the way the finished video should run.
        "photo_rooms": lead.photo_rooms,
        "beds": lead.beds,
        "baths": lead.baths,
        "sqft": lead.sqft,
        "property_type": lead.property_type,
    }


@studio_bp.route("/signup", methods=["GET", "POST"])
def signup():
    if session.get("user_id"):
        return redirect(url_for("studio.home"))

    error = None
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""
        confirm = request.form.get("confirm") or ""

        if not email or not password:
            error = "Email and password are required."
        elif not EMAIL_RE.match(email):
            error = "Enter a valid email address."
        elif password != confirm:
            error = "Passwords don't match."
        elif len(password) < 6:
            error = "Password must be at least 6 characters."
        elif find_user_by_email(email):
            error = "An account with that email already exists."
        else:
            user = create_user(email, password=password)
            session["user_id"] = user["id"]
            return redirect(request.args.get("next") or url_for("studio.home"))

    return render_template("signup.html", error=error)


@studio_bp.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("studio.home"))

    error = None
    if request.method == "POST":
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""
        user = find_user_by_email(email)
        if user and user.get("password_hash") and check_password_hash(user["password_hash"], password):
            session["user_id"] = user["id"]
            return redirect(request.args.get("next") or url_for("studio.home"))
        elif user and not user.get("password_hash"):
            error = "That account signed up with Google. Use \"Continue with Google\" instead."
        else:
            error = "Incorrect email or password."

    return render_template("login.html", error=error)


@studio_bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("studio.login"))


@studio_bp.route("/auth/google")
def auth_google():
    if not GOOGLE_OAUTH_ENABLED:
        return redirect(url_for("studio.login"))
    session["oauth_next"] = request.args.get("next") or url_for("studio.home")
    redirect_uri = url_for("studio.auth_google_callback", _external=True)
    return oauth.google.authorize_redirect(redirect_uri)


@studio_bp.route("/auth/google/callback")
def auth_google_callback():
    if not GOOGLE_OAUTH_ENABLED:
        return redirect(url_for("studio.login"))

    try:
        token = oauth.google.authorize_access_token()
        userinfo = token.get("userinfo") or {}
        google_id = userinfo.get("sub")
        email = (userinfo.get("email") or "").strip().lower()
    except Exception:
        return render_template("login.html", error="Google sign-in failed. Please try again.")

    if not google_id or not email:
        return render_template("login.html", error="Google didn't return an email address.")

    user = find_user_by_google_id(google_id) or find_user_by_email(email)
    if user:
        if not user.get("google_id"):
            users = load_users()
            for u in users:
                if u["id"] == user["id"]:
                    u["google_id"] = google_id
            save_users(users)
    else:
        user = create_user(email, google_id=google_id)

    session["user_id"] = user["id"]
    return redirect(session.pop("oauth_next", None) or url_for("studio.home"))


@studio_bp.route("/")
@login_required
def home():
    return render_template("home.html")


def _carry():
    """The lead or project being worked on, kept across the chooser screens.

    Two forms, because one is appended to a bare path and the other to a path
    that already has a query on it. Returned together so a template never has
    to guess which it needs.
    """
    keep = {k: v for k, v in request.args.items() if k in ("lead_id", "project")}
    if not keep:
        return "", "?"
    query = urlencode(keep)
    return "?" + query, "?" + query + "&"


# The stages of a run, per style. A drone flight has two a walkthrough does
# not: the Earth view the flight is planned on, and the enhancement pass over
# the photographs it will be flown across. Written here rather than in the
# templates because inserting a stage used to mean renumbering two lists of
# hand-written <li>s and hoping they agreed.
STEP_FLOWS = {
    # Stage 4 is not the same job in the two flows and does not share a page.
    # A walkthrough is a clip per photograph with a camera move on each; a
    # drone shot is one flight between two frames of the same property. They
    # were sharing the shots step, which meant a drone run arrived at a
    # room-by-room picker that had nothing to do with it.
    "drone": ["Listing", "Google Earth", "Crop", "Generate", "Drone shot", "Clips"],
    None: ["Listing", "Style & shots", "Clips"],
}

# Stages that exist in the bar but not yet in the app. Marked rather than
# hidden: the numbering is the promise, and a gap in it is worse than a
# stage that says it is coming.
STEPS_SOON = set()


def _steps(style, current):
    """The stage bar, as [{num, label, state, soon}].

    `current` is the label of the stage being shown. Everything before it is
    done, everything after is still to come.
    """
    labels = STEP_FLOWS.get(style if style == "drone" else None)
    here = labels.index(current) if current in labels else 0
    return [
        {
            "num": i + 1,
            "label": label,
            "state": "done" if i < here else ("current" if i == here else "todo"),
            "soon": label in STEPS_SOON,
        }
        for i, label in enumerate(labels)
    ]


STYLE_NAMES = {"basic": "Basic", "walkthrough": "Walkthrough", "drone": "Drone"}


# Where each stage sits in the run, and what it takes to link back to it.
# Written next to STEP_FLOWS because they are the same sequence: the bar says
# where you are, Back walks the same line in reverse. They disagreed before,
# and Back from Enhance went to the listing step -- the start of the flow --
# because the trail was built by style rather than by stage.
STAGE_PAGES = {
    "listing": ("Listing", "/studio/create/video/listing"),
    "earth": ("Google Earth", "/studio/create/video/earth"),
    "enhance": ("Crop", "/studio/create/video/crop"),
    "generate": ("Generate", "/studio/create/video/generate"),
    "render": ("Style & shots", "/studio/create/render"),
    "drone": ("Drone shot", "/studio/create/video/drone"),
}

# The stage each page belongs to, for pages that are not stages themselves.
# The flight planner is opened from the shots step and belongs behind it.
STAGE_OF = {"path": "drone"}


def _create_crumbs(here, style=None, project_id=None):
    """The Create trail, as [(label, href_or_None)] ending on where you are.

    Only the last linked entry is rendered -- as Back -- so what this really
    decides is which page Back goes to. It walks the stage flow in reverse,
    which is why the stage bar and the Back button always agree.

    Every earlier crumb keeps the lead or project, so going back two screens
    does not lose the listing you were working on.
    """
    keep = {k: v for k, v in request.args.items() if k in ("lead_id", "project")}
    # The render page names it `lead`, everything upstream names it
    # `lead_id`. Without this the trail from a render dropped the listing and
    # sent you back to an empty Create.
    if "lead_id" not in keep and request.args.get("lead"):
        keep["lead_id"] = request.args["lead"]
    if project_id and "project" not in keep:
        keep["project"] = project_id

    def link(path, **extra):
        query = dict(keep, **{k: v for k, v in extra.items() if v})
        # The shots step takes `lead`, not `lead_id`, and sending it the
        # wrong one lands on an empty picker.
        if path.endswith("/create/render") and "lead_id" in query:
            query["lead"] = query.pop("lead_id")
        return path + ("?" + urlencode(query) if query else "")

    trail = [("Create", link("/studio/create"))]

    if here == "choose":
        return [("Create", None)]

    if here == "scenery":
        trail.append(("Staging", None))
        return trail

    # The video branch.
    trail.append(("Video", link("/studio/create/video")))
    if here == "style":
        trail[-1] = ("Video", None)
        return trail

    name = STYLE_NAMES.get(style)
    if name:
        trail.append((name, link("/studio/create/video/listing", style=style)))

    # Now the stages, in the order this style actually runs them, stopping at
    # the one being shown. The last linked entry is the stage before it, so
    # Back is one step rather than a jump to the beginning.
    stage = STAGE_OF.get(here, here)
    labels = STEP_FLOWS.get(style if style == "drone" else None)
    order = [key for key in ("listing", "earth", "enhance", "generate",
                             "render", "drone")
             if STAGE_PAGES[key][0] in labels]

    if stage not in order:
        return trail

    # A page that IS a stage links back through the ones before it. A page
    # that merely belongs to one -- the flight planner, opened from the shots
    # step -- links back through that stage too, because that is where it was
    # opened from.
    upto = order.index(stage) + (0 if here in STAGE_PAGES else 1)
    for key in order[:upto]:
        label, path = STAGE_PAGES[key]
        # The listing step is already in the trail under the style's name
        # when there is one; a second entry for it would make Back a
        # no-op-looking link to the page it came from.
        if key == "listing" and name:
            continue
        trail.append((label, link(path, style=style)))

    # And the page itself, unlinked, which marks where you are.
    if here in STAGE_PAGES:
        label = STAGE_PAGES[here][0]
        if here == "listing" and name:
            trail[-1] = (name, None)
        else:
            trail.append((label, None))
    else:
        trail.append(({"path": "Flight path"}.get(here, here.title()), None))
    return trail


@studio_bp.route("/create")
@login_required
def create_choose():
    """What to make. This page asks one question and shows nothing else."""
    from services import showcase

    carry, _ = _carry()
    return render_template("create_choose.html", showcase=showcase.status(),
                           carry=carry, crumbs=_create_crumbs("choose"))


@studio_bp.route("/create/video")
@login_required
def create_video_style():
    """How the video should move, before any listing is chosen.

    The same three styles the shots step offers; choosing here only sets the
    starting point, and every clip can still be changed individually later.
    """
    carry, carry_amp = _carry()
    styles = [
        ("basic", "Basic", "Simple photo-to-video pans, quick and clean",
         "/studio/create/video/listing" + carry_amp + "style=basic"),
        ("walkthrough", "Walkthrough",
         "Steady room-to-room glide, a classic listing tour",
         "/studio/create/video/listing" + carry_amp + "style=walkthrough"),
        # Drone goes to the same listing step as the others -- it just asks
        # for a lead and nothing else, because a flight needs an address to
        # plan over and a lead is where the address comes from.
        ("drone", "Drone", "Sweeping aerial establishing shots, orbits and rises",
         "/studio/create/video/listing" + carry_amp + "style=drone"),
    ]
    return render_template(
        "create_style.html", carry=carry, carry_amp=carry_amp,
        crumbs=_create_crumbs("style"), styles=styles)


@studio_bp.route("/create/video/earth")
@login_required
def create_earth():
    """Stage 2 of a drone run: get a view of the property from Earth.

    Needs a lead, because the whole stage is one address. Without one there
    is nothing to search for, so it sends you back to pick a listing.
    """
    from services import dronepath

    lead_id = request.args.get("lead_id")
    lead = get_owned_lead(int(lead_id)) if (lead_id or "").isdigit() else None
    if lead is None:
        return redirect(url_for("studio.create", style="drone"))

    project_id = request.args.get("project")
    tail = "project=%s" % quote(project_id) if project_id else "lead=%s" % lead.id

    # The listing's own exterior photographs, offered to be dragged into the
    # reference boxes. Offered rather than picked automatically: the app
    # cannot reliably tell a front elevation from a side one, and a reference
    # is only useful if it shows the side the capture shows.
    from services import enhance

    rooms = lead.photo_rooms or {}

    def room_of(url):
        entry = rooms.get(url)
        return (entry.get("room") if isinstance(entry, dict) else entry) or ""

    outside = [u for u in (lead.photo_urls or [])
               if room_of(u) in enhance.EXTERIOR_ROOMS]

    path = lead.drone_path or {}
    return render_template(
        "create_earth.html", lead=lead,
        plan=dronepath.SHOT_PLAN,
        captures=dronepath.images_of(path),
        slots=dronepath.slots_of(path),
        listing_photos=outside or (lead.photo_urls or []),
        photo_rooms=rooms,
        earth_url=dronepath.earth_url(dronepath.full_address(lead)),
        back_href="/studio/create/video/listing?style=drone&lead_id=%s" % lead.id,
        next_href=("/studio/create/video/enhance?lead_id=%s&style=drone" % lead.id
                   + ("&project=%s" % quote(project_id) if project_id else "")),
        steps=_steps("drone", "Google Earth"),
        crumbs=_create_crumbs("earth", style="drone"))


@studio_bp.route("/create/video/crop")
@studio_bp.route("/create/video/enhance")   # the name it had before it split
@login_required
def create_enhance():
    """Stage 3: framing the captures.

    Called create_enhance because that is the URL it had when it did more
    than this. It crops, and only crops -- generating the shots moved to its
    own stage and then out of the app entirely.
    """
    from services import dronepath

    lead_id = request.args.get("lead_id")
    lead = get_owned_lead(int(lead_id)) if (lead_id or "").isdigit() else None
    if lead is None:
        return redirect(url_for("studio.create", style="drone"))

    style = (request.args.get("style") or "drone").strip().lower()
    project_id = request.args.get("project")
    tail = "project=%s" % quote(project_id) if project_id else "lead=%s" % lead.id
    carried = "&project=%s" % quote(project_id) if project_id else ""
    onward = ("/studio/create/video/generate?lead_id=%s&style=drone%s"
              % (lead.id, carried)
              if style == "drone" else "/studio/create/render?" + tail)

    path = lead.drone_path or {}
    return render_template(
        "create_crop.html", lead=lead,
        captures=dronepath.images_of(path),
        originals=path.get("originals") or {},
        slots=dronepath.slots_of(path),
        shot_labels=dronepath.SHOT_LABELS,
        back_href="/studio/create/video/earth?lead_id=%s%s" % (lead.id, carried),
        next_href=onward,
        steps=_steps(style, "Crop"),
        crumbs=_create_crumbs("enhance", style=style))


@studio_bp.route("/create/video/generate")
@login_required
def create_generate():
    """Stage 4: the two shots a flight is built from.

    Front and back, side by side, because that is the shape of the job: a
    flyover starts on one and lands on the other. Everything placed on the
    board at stage 2 feeds one of these two columns, with the neighbours in
    both.
    """
    from services import atlas_image, dronepath, enhance

    lead_id = request.args.get("lead_id")
    lead = get_owned_lead(int(lead_id)) if (lead_id or "").isdigit() else None
    if lead is None:
        return redirect(url_for("studio.create", style="drone"))

    style = (request.args.get("style") or "drone").strip().lower()
    project_id = request.args.get("project")
    tail = "&project=%s" % quote(project_id) if project_id else ""
    path = lead.drone_path or {}

    notes = {"front": "Where the flight opens.",
             "back": "Where it lands."}
    sides = []
    for key in dronepath.SIDES:
        base, ranked = dronepath._ordered(lead, key)
        sides.append({"key": key, "label": key.title(), "note": notes[key],
                      "base": base,
                      # The whole board, in ranked order, NOT cut to the
                      # model's ten. The page cuts it, shows what fell off
                      # the end by name, and lets it be swapped back in --
                      # "three did not go" is not an answer to "where are my
                      # neighbours".
                      "references": ranked[:dronepath.MAX_REFERENCES],
                      "all": ranked, "limit": dronepath.MAX_REFERENCES})

    return render_template(
        "create_generate.html", lead=lead,
        sides=sides,
        generated=dronepath.generated_of(path),
        prompts=dict((key, enhance.prompt_for(key))
                     for key in dronepath.SIDES),
        models=atlas_image.MODELS,
        default_model=atlas_image.MODEL,
        slots=dronepath.slots_of(path),
        shot_labels=dronepath.SHOT_LABELS,
        slot_order=dronepath.CAPTURE_SLOTS,
        earth_href="/studio/create/video/earth?lead_id=%s%s" % (lead.id, tail),
        back_href="/studio/create/video/crop?lead_id=%s&style=drone%s" % (lead.id, tail),
        next_href="/studio/create/video/drone?lead_id=%s&style=drone%s" % (lead.id, tail),
        steps=_steps(style, "Generate"),
        crumbs=_create_crumbs("generate", style=style, project_id=project_id))


@studio_bp.route("/create/video/drone")
@login_required
def create_drone():
    """Stage 4 of a drone run, which is not stage 4 of a walkthrough.

    A walkthrough turns each photograph into its own clip with its own camera
    move. A drone shot is one flight across one property, between two frames
    of it -- there is no per-room grain to choose, and the room-by-room picker
    the other flow uses had nothing to say about it.

    What this page chooses instead: which captured view the flight starts on,
    which it ends on, how the camera moves between them and for how long.
    """
    from services import dronepath, video

    lead_id = request.args.get("lead_id")
    lead = get_owned_lead(int(lead_id)) if (lead_id or "").isdigit() else None
    if lead is None:
        return redirect(url_for("studio.create", style="drone"))

    path = lead.drone_path or {}
    project_id = request.args.get("project")
    cfg = video.load_config()

    # Placed first, in plan order, because those are the views someone has
    # already said something about. Everything else after, so a capture that
    # was never filed is still usable.
    # The two generated shots first: they are what the previous stage exists
    # to produce, and a flight between them is the default reading of this
    # page. Everything placed on the board after, then anything unfiled.
    made = dronepath.generated_of(path)
    shots = [made[key] for key in dronepath.SIDES if made.get(key)]
    placed = [u for u in dronepath.placed(lead) if u not in shots]
    rest = [u for u in dronepath.images_of(path) if u not in shots + placed]

    return render_template(
        "create_drone.html", lead=lead,
        frames=shots + placed + rest,
        labels=dict(
            {made[key]: key for key in dronepath.SIDES if made.get(key)},
            **{url: slots[0] for url, slots in
               ((u, dronepath.slots_for(path, u)) for u in placed + rest) if slots}),
        shot_labels=dict(dronepath.SHOT_LABELS,
                         front="Generated — front", back="Generated — back"),
        described=dronepath.describe(path),
        path_href="/studio/create/video/path?lead_id=%s&style=drone" % lead.id,
        moves=[{"key": key, "name": name, "note": note}
               for key, name, note, _ in video.EXTERIOR_MOVES],
        durations=video.model_info(cfg).get("durations") or [5, 8, 10],
        resolutions=video.model_info(cfg).get("resolutions") or ["1080p"],
        rates=video.model_info(cfg).get("rates") or {},
        configured=bool(cfg.get("api_key")),
        config_error=cfg.get("config_error"),
        back_href=("/studio/create/video/generate?lead_id=%s&style=drone" % lead.id
                   + ("&project=%s" % quote(project_id) if project_id else "")),
        steps=_steps("drone", "Drone shot"),
        crumbs=_create_crumbs("drone", style="drone", project_id=project_id))


@studio_bp.route("/create/video/path")
@login_required
def create_path():
    """Plan the flight before rendering it.

    Needs a lead, because the path is drawn on that property's overhead and
    saved against it. Without one there is nothing to fly over, so it sends
    you back to pick a listing first.
    """
    lead_id = request.args.get("lead_id")
    lead = get_owned_lead(int(lead_id)) if (lead_id or "").isdigit() else None
    if lead is None:
        return redirect(url_for("studio.create", style="drone"))

    project_id = request.args.get("project")
    back_href = ("/studio/create/render?project=%s" % quote(project_id)
                 if project_id else "/studio/create/render?lead=%s" % lead.id)

    return render_template("create_path.html", lead=lead, back_href=back_href,
                           crumbs=_create_crumbs("path", style="drone"))


@studio_bp.route("/create/video/listing")
@login_required
def create():
    project = None
    project_id = request.args.get("project")
    if project_id:
        project = next(
            (p for p in load_projects() if p["id"] == project_id and p.get("owner") == session["user_id"]),
            None,
        )

    prefill = None
    lead_id = request.args.get("lead_id")
    if not project and lead_id:
        try:
            prefill = _lead_prefill(int(lead_id))
        except (ValueError, TypeError):
            prefill = None

    from services import showcase

    # The style chosen on the way in, so the shots step starts there.
    style = (request.args.get("style") or "").strip().lower()
    if style not in ("basic", "walkthrough", "drone"):
        style = None

    # A drone flight is planned on the property's overhead and flown over its
    # exterior photographs, both of which come from a lead. Pasted links and
    # loose uploads have neither, so this style asks for a lead and nothing
    # else rather than offering two routes that cannot finish.
    lead_only = style == "drone"

    return render_template("create.html", project=project, prefill=prefill,
                           showcase=showcase.status(), chosen_style=style,
                           lead_only=lead_only,
                           steps=_steps(style, "Listing"),
                           crumbs=_create_crumbs("listing", style=style))


@studio_bp.route("/create/style")
@login_required
def create_style():
    """Merged into the render page.

    Choosing a style used to be a page of its own holding three cards and
    nothing else. Now that a style is a preset for the per-clip camera moves,
    it belongs beside them -- so this redirects rather than 404s, because
    saved links and browser history still point at it.
    """
    project_id = request.args.get("project")
    if project_id:
        return redirect(url_for("studio.create_render", project=project_id))
    return redirect(url_for("studio.create"))


@studio_bp.route("/create/render")
@login_required
def create_render():
    """The step after choosing a style: actually make the clips.

    Same owner-scoped project lookup as the style page. Everything about what
    to render comes from the project, so arriving here without one is a
    redirect rather than an empty form.
    """
    from extensions import db

    project_id = request.args.get("project")
    project = (
        next(
            (p for p in load_projects()
             if p["id"] == project_id and p.get("owner") == session["user_id"]),
            None,
        )
        if project_id
        else None
    )

    # ?job= opens straight on a finished render. It does not need a project --
    # the clips are on the job -- so arriving from the renders picker works
    # whether or not the project that made them is still to hand.
    job_id = request.args.get("job")
    # ?lead= opens every render made for one listing on a single results page,
    # which is what the renders picker offers for a home with more than one.
    lead_renders = request.args.get("lead")
    if lead_renders and not str(lead_renders).isdigit():
        lead_renders = None
    if not project and not job_id and not lead_renders:
        return redirect(url_for("studio.create"))

    project = dict(project or {})

    # Opening a saved render without a project: rebuild enough of one from the
    # job's lead. Without this, going back to the shots step from a saved
    # render lands on an empty picker -- the clips are on the job, but the
    # photos they were made from are on the listing.
    # Same rebuild as below, but the lead is named outright rather than being
    # reached through a job.
    if not project and lead_renders:
        lead = get_owned_lead(int(lead_renders))
        if lead is None:
            return redirect(url_for("studio.create"))
        project = {
            "id": None,
            "lead_id": lead.id,
            "address": lead.full_address,
            "name": lead.full_address,
            "photos": lead.photo_urls or [],
        }

    if not project and job_id:
        from models import VideoJob

        job = db.session.get(VideoJob, int(job_id)) if str(job_id).isdigit() else None
        if job is not None and job.owner_id == session["user_id"] and job.lead_id:
            lead = get_owned_lead(job.lead_id)
            if lead is not None:
                project = {
                    "id": None,
                    "lead_id": lead.id,
                    "address": lead.full_address,
                    "name": lead.full_address,
                    "photos": lead.photo_urls or [],
                }

    # Room labels, when this project came from a lead: they let the default
    # selection be one clip per room rather than six angles of one lounge.
    if project.get("lead_id"):
        lead = get_owned_lead(int(project["lead_id"]))
        if lead is not None:
            project["photo_rooms"] = lead.photo_rooms or {}
            # Projects saved before the address included the town still hold
            # the street on its own. The lead is the record; the project is a
            # copy of it, so the lead wins.
            project["address"] = lead.full_address or project.get("address")

    # The style decides the stage bar, and a page opened straight from a lead
    # has no project to carry it -- so the query string is allowed to say.
    style = project.get("style") or request.args.get("style")

    return render_template("render.html", project=project, job_id=job_id,
                           lead_renders=lead_renders,
                           steps=_steps(style, "Style & shots"),
                           # The same resolved style the bar uses. Passing
                           # the project's alone sent Back to the listing
                           # step whenever the page was opened straight from
                           # a lead, which is the jump-to-the-start this was.
                           crumbs=_create_crumbs("render", style=style,
                                                 project_id=project.get("id")))


@studio_bp.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html")


@studio_bp.route("/leads/<int:lead_id>")
@login_required
def lead_profile(lead_id):
    # The price list is handed to the page rather than fetched, so the panel
    # has it on first paint and there is no moment where a sold lead shows
    # nothing to click.
    from services.packages import PACKAGES

    return render_template("lead_profile.html", lead_id=lead_id,
                           packages=PACKAGES)


@studio_bp.route("/scenery")
@login_required
def scenery_legacy():
    """Where Scenery used to live. Kept so saved links and the lead profile's
    existing buttons keep working after the move under Create."""
    return redirect(url_for("studio.scenery", **request.args))


@studio_bp.route("/create/scenery")
@login_required
def scenery():
    """Virtual staging: the same captured photos, furnished differently.

    One of the two things Create makes, and it lives under /create for that
    reason. Still its own document rather than a panel on the video page:
    the two flows share the listing picker's element ids, so a single page
    would have each script wiring the other's markup.
    """
    prefill = None
    lead_id = request.args.get("lead_id")
    if lead_id:
        try:
            prefill = _lead_prefill(int(lead_id))
        except (ValueError, TypeError):
            prefill = None
    from services import showcase

    return render_template("scenery.html", prefill=prefill,
                           showcase=showcase.status(),
                           crumbs=_create_crumbs("scenery"))


@studio_bp.route("/outreach")
@login_required
def outreach_queue():
    """The send queue moved into Lead management, which is where the leads
    it acts on already were. Kept as a redirect so saved links, and the
    dashboard's focus links, still land in the right place."""
    args = dict(request.args)
    args["tab"] = "outreach"
    return redirect(url_for("studio.leads_manager", **args))


@studio_bp.route("/leads")
@login_required
def leads_manager():
    return render_template("leads_manager.html")


@studio_bp.route("/closed")
@login_required
def closed_clients():
    """Every listing a client paid for. What "deals closed" on the dashboard
    is actually made of."""
    return render_template("closed.html")


@studio_bp.route("/calendar")
@login_required
def calendar_page():
    """Bookings, month by month, read from Calendly."""
    return render_template("calendar.html")


@studio_bp.route("/projects")
@login_required
def active_projects():
    """The qualified leads being worked on, as their own page rather than a
    number on a tile."""
    return render_template("projects.html")


@studio_bp.route("/api/extract", methods=["POST"])
@login_required
def api_extract():
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No URL provided."}), 400
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return jsonify(extract_meta(url))


@studio_bp.route("/api/upload", methods=["POST"])
@login_required
def api_upload():
    files = request.files.getlist("photos")
    if not files:
        return jsonify({"error": "No files received."}), 400

    existing_photos = []
    raw_existing = request.form.get("existing_photos")
    if raw_existing:
        try:
            existing_photos = json.loads(raw_existing)
        except json.JSONDecodeError:
            existing_photos = []
    known_hashes = hash_existing_photos(existing_photos)

    saved = []
    duplicates = 0
    for f in files:
        if not (f and f.filename and allowed_file(f.filename)):
            continue
        ext = f.filename.rsplit(".", 1)[1].lower()

        if ext in ALLOWED_IMAGE_EXTENSIONS:
            content = f.read()
            img_hash = average_hash(content)
            if img_hash is not None and is_duplicate(img_hash, known_hashes):
                duplicates += 1
                continue
            if img_hash is not None:
                known_hashes.append(img_hash)
            unique_name = secure_filename(f"{uuid.uuid4().hex}.{ext}")
            (UPLOAD_DIR / unique_name).write_bytes(content)
        else:
            unique_name = secure_filename(f"{uuid.uuid4().hex}.{ext}")
            f.save(UPLOAD_DIR / unique_name)

        saved.append(f"/studio/static/uploads/{unique_name}")

    if not saved and not duplicates:
        return jsonify({"error": "No valid image or video files found (png/jpg/webp/heic, mp4/mov/webm/m4v)."}), 400

    return jsonify({"photos": saved, "duplicates": duplicates})


MAX_INLINE_PHOTOS = 40  # bounds the capture payload the extension sends

DATA_URL_RE = re.compile(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.+)$", re.S)


def save_data_url_images(data_urls, existing_photos=None):
    """Save images the Chrome extension captured in the page and sent inline
    as data: URLs.

    Some sites (homes.com, via Akamai) refuse this server outright -- 403 on
    the listing HTML *and* on their image CDN -- so there is no server-side
    fetch that can ever work for them. The extension is a real browser on the
    page the user is already looking at, so it reads the bytes there and
    hands them over. Same hashing and de-duplication as an upload.
    """
    known_hashes = hash_existing_photos(existing_photos or [])
    saved, failed, duplicates = [], 0, 0

    for entry in (data_urls or [])[:MAX_INLINE_PHOTOS]:
        match = DATA_URL_RE.match((entry or "").strip())
        if not match:
            failed += 1
            continue
        subtype, payload = match.groups()
        ext = CONTENT_TYPE_EXT.get(f"image/{subtype.lower()}") or (
            subtype.lower() if subtype.lower() in ALLOWED_IMAGE_EXTENSIONS else None
        )
        if not ext:
            failed += 1
            continue
        try:
            content = base64.b64decode(payload, validate=False)
        except (ValueError, binascii.Error):
            failed += 1
            continue
        if len(content) < 3000:  # icon or tracking pixel, not a listing photo
            failed += 1
            continue

        img_hash = average_hash(content)
        if img_hash is not None and is_duplicate(img_hash, known_hashes):
            duplicates += 1
            continue
        if img_hash is not None:
            known_hashes.append(img_hash)

        name = secure_filename(f"{uuid.uuid4().hex}.{ext}")
        (UPLOAD_DIR / name).write_bytes(content)
        saved.append(f"/studio/static/uploads/{name}")

    return {"photos": saved, "failed": failed, "duplicates": duplicates}


def save_capture_data_url(data_url):
    """Save one deliberately-taken screenshot, and apply no judgement to it.

    Deliberately not save_data_url_images(): that one is built for photos
    scraped off a listing, so it drops anything under 3KB as a tracking pixel
    and de-duplicates against what is already there. Neither rule fits a
    capture the user just took by hand -- a flat aerial can compress small,
    and re-capturing the same view on purpose is not a duplicate to discard.

    Returns the saved URL, or None when the payload is not a usable image.
    """
    match = DATA_URL_RE.match((data_url or "").strip())
    if not match:
        return None

    subtype, payload = match.groups()
    ext = CONTENT_TYPE_EXT.get("image/%s" % subtype.lower()) or (
        subtype.lower() if subtype.lower() in ALLOWED_IMAGE_EXTENSIONS else None
    )
    if not ext:
        return None

    try:
        content = base64.b64decode(payload, validate=False)
    except (ValueError, binascii.Error):
        return None
    if not content:
        return None

    name = secure_filename("%s.%s" % (uuid.uuid4().hex, ext))
    (UPLOAD_DIR / name).write_bytes(content)
    return "/studio/static/uploads/%s" % name


def download_image_urls(urls, existing_photos=None):
    """Download image URLs and save local copies, exactly like a manual
    upload. We fetch each URL with a plain GET the same way a browser
    loading that <img> tag would -- no bot-detection bypass, just retrieving
    images the page already serves publicly. Shared by /api/import-images
    (user-picked, from Create Video) and the lead profile's automatic pull."""
    known_hashes = hash_existing_photos(existing_photos or [])

    saved = []
    failed = []
    duplicates = 0
    for img_url in urls[:MAX_IMAGE_CANDIDATES]:
        try:
            resp = requests.get(img_url, headers=BROWSER_HEADERS, timeout=10, stream=True)
            content_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
            ext = CONTENT_TYPE_EXT.get(content_type)
            if not ext:
                path_ext = Path(urlparse(img_url).path).suffix.lstrip(".").lower()
                ext = path_ext if path_ext in ALLOWED_EXTENSIONS else None
            if resp.status_code != 200 or not ext:
                failed.append(img_url)
                continue
            content = resp.content
            if len(content) < 3000:  # almost certainly an icon/tracking pixel, not a photo
                failed.append(img_url)
                continue

            img_hash = average_hash(content)
            if img_hash is not None and is_duplicate(img_hash, known_hashes):
                duplicates += 1
                continue
            if img_hash is not None:
                known_hashes.append(img_hash)

            unique_name = secure_filename(f"{uuid.uuid4().hex}.{ext}")
            (UPLOAD_DIR / unique_name).write_bytes(content)
            saved.append(f"/studio/static/uploads/{unique_name}")
        except requests.RequestException:
            failed.append(img_url)

    return {"photos": saved, "failed": failed, "duplicates": duplicates}


@studio_bp.route("/api/import-images", methods=["POST"])
@login_required
def api_import_images():
    data = request.get_json(force=True, silent=True) or {}
    urls = data.get("images") or []
    if not isinstance(urls, list) or not urls:
        return jsonify({"error": "No image URLs provided."}), 400
    return jsonify(download_image_urls(urls, data.get("existing_photos") or []))


@studio_bp.route("/api/satellite", methods=["POST"])
@login_required
def api_satellite():
    """Manual-address path: when photos came from a plain upload (no listing
    link to auto-extract an address from), let the user supply the address
    directly so we can still fetch the overhead/drone-context image."""
    data = request.get_json(force=True, silent=True) or {}
    address = (data.get("address") or "").strip()
    if not address:
        return jsonify({"error": "Enter an address first."}), 400

    sat_url, lat, lon = save_satellite_image_for_address(address)
    if not sat_url:
        return jsonify({
            "error": "Couldn't find a satellite view for that address. Double-check it and try again."
        }), 404

    return jsonify({"satellite_image": sat_url, "lat": lat, "lon": lon})


@studio_bp.route("/api/streetview-check", methods=["POST"])
@login_required
def api_streetview_check():
    """Google's Street View metadata endpoint is free (no charge, doesn't
    count against usage) -- check coverage exists before the frontend loads
    the actual (billed) interactive panorama, so a location with no imagery
    fails fast with a clear message instead of an empty gray panorama."""
    if not STREETVIEW_ENABLED:
        return jsonify({"available": False, "error": "Street View isn't configured."}), 400

    data = request.get_json(force=True, silent=True) or {}
    lat, lon = data.get("lat"), data.get("lon")
    if lat is None or lon is None:
        return jsonify({"available": False, "error": "Missing coordinates."}), 400

    try:
        resp = requests.get(
            "https://maps.googleapis.com/maps/api/streetview/metadata",
            params={"location": f"{lat},{lon}", "key": GOOGLE_MAPS_API_KEY},
            timeout=10,
        )
        body = resp.json()
        status = body.get("status")
    except requests.RequestException:
        return jsonify({"available": False, "error": "Could not reach Google Street View."}), 502

    if status == "OK":
        return jsonify({"available": True})
    if status == "ZERO_RESULTS":
        return jsonify({"available": False, "error": "No Street View imagery at this location."})

    return jsonify({
        "available": False,
        "error": body.get("error_message") or f"Street View error: {status}",
    })


@studio_bp.route("/api/projects", methods=["GET"])
@login_required
def api_list_projects():
    owned = [p for p in load_projects() if p.get("owner") == session["user_id"]]
    return jsonify(owned)


@studio_bp.route("/api/projects", methods=["POST"])
@login_required
def api_create_project():
    data = request.get_json(force=True, silent=True) or {}
    projects = load_projects()
    now = time.time()
    project = {
        "id": uuid.uuid4().hex,
        "owner": session["user_id"],
        "name": data.get("name") or "Untitled draft",
        "url": data.get("url"),
        "source": data.get("source"),
        "address": data.get("address"),
        "title": data.get("title"),
        "description": data.get("description"),
        "photos": data.get("photos", []),
        # Which of those photos the video should actually use. Kept separate
        # from `photos` so deselecting one doesn't throw the file away -- the
        # user can change their mind without re-importing.
        "selected_photos": data.get("selected_photos"),
        "status": data.get("status", "draft"),
        "style": data.get("style"),
        "satellite_image": data.get("satellite_image"),
        "lat": data.get("lat"),
        "lon": data.get("lon"),
        "beds": data.get("beds"),
        "baths": data.get("baths"),
        "sqft": data.get("sqft"),
        "property_type": data.get("property_type"),
        "lead_id": data.get("lead_id"),
        "created_at": now,
        "updated_at": now,
    }
    projects.insert(0, project)
    save_projects(projects)
    return jsonify(project), 201


@studio_bp.route("/api/projects/<project_id>", methods=["PUT"])
@login_required
def api_update_project(project_id):
    data = request.get_json(force=True, silent=True) or {}
    projects = load_projects()
    project = next(
        (p for p in projects if p["id"] == project_id and p.get("owner") == session["user_id"]), None
    )
    if not project:
        return jsonify({"error": "Project not found."}), 404

    for field in (
        "name", "url", "source", "address", "title", "description", "photos", "selected_photos",
        "status", "style",
        "satellite_image", "lat", "lon", "beds", "baths", "sqft", "property_type", "lead_id",
    ):
        if field in data:
            project[field] = data[field]
    project["updated_at"] = time.time()

    save_projects(projects)
    return jsonify(project)


@studio_bp.route("/api/projects/<project_id>", methods=["DELETE"])
@login_required
def api_delete_project(project_id):
    projects = load_projects()
    projects = [
        p for p in projects if not (p["id"] == project_id and p.get("owner") == session["user_id"])
    ]
    save_projects(projects)
    return jsonify({"ok": True})


@studio_bp.route("/api/leads", methods=["GET"])
@login_required
def api_list_leads():
    """Surfaces the admin ingestion pipeline's leads inside Studio's own
    dashboard (same DB, no Basic Auth involved -- that only gates bare
    /api/*, not /studio/api/*). Returns [] if the models aren't importable
    (e.g. this blueprint ever runs standalone again)."""
    try:
        from models import Lead
    except ImportError:
        return jsonify([])

    query = owned_leads_query()
    qualified_param = request.args.get("qualified")
    if qualified_param is not None:
        query = query.filter(Lead.qualified == (qualified_param.lower() in ("1", "true", "yes")))

    # Filtering and sorting happen in the browser over whatever is fetched, so
    # a cap here silently hides leads rather than paginating them. Raised well
    # past the plausible working set; the client reports if it is ever hit.
    leads = query.order_by(Lead.created_at.desc()).limit(2000).all()
    return jsonify([lead.to_dict() for lead in leads])


@studio_bp.route("/api/leads/<int:lead_id>/prefill", methods=["GET"])
@login_required
def api_lead_prefill(lead_id):
    """A lead shaped the way Create Video wants it.

    Same data the ?lead_id= query param uses, over JSON, so picking a lead on
    the page loads it without a reload and without a second code path.
    """
    prefill = _lead_prefill(lead_id)
    if prefill is None:
        return jsonify({"error": "Lead not found."}), 404
    return jsonify(prefill)


@studio_bp.route("/api/leads/<int:lead_id>", methods=["PATCH"])
@login_required
def api_update_lead_status(lead_id):
    try:
        from extensions import db
        from models import VALID_STATUSES, Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    data = request.get_json(force=True, silent=True) or {}

    # Contact details are editable because a listing often doesn't publish the
    # agent's email -- Zillow never does -- so it gets looked up and typed in.
    EDITABLE_TEXT = ("thumbnail_url",
                     "notes", "agent_email", "agent_name", "agent_phone", "brokerage",
                     "video_url")
    if ("status" not in data and "sold_amount" not in data
            and "sold_package" not in data
            and not any(f in data for f in EDITABLE_TEXT)):
        return jsonify({"error": "Nothing to update."}), 400

    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            return jsonify({"error": f"status must be one of {VALID_STATUSES}"}), 400
        lead.status = data["status"]

    if "agent_email" in data:
        email = (data["agent_email"] or "").strip()
        if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            return jsonify({"error": "That doesn't look like an email address."}), 400
        lead.agent_email = email or None

    # Which photo represents this lead on a card. Only one of the lead's own
    # photos: this ends up rendered in the Lead Manager and the dashboard, so
    # it is not a place to accept an arbitrary URL.
    if "thumbnail_url" in data:
        chosen = (data["thumbnail_url"] or "").strip()
        if chosen and chosen not in (lead.photo_urls or []):
            return jsonify({"error": "That photo doesn't belong to this lead."}), 400
        lead.thumbnail_url = chosen or None

    # Which package was sold. The price comes from the server's own list and
    # never from the request: a figure the browser can name is a figure the
    # browser can get wrong, and this one is revenue.
    if "sold_package" in data:
        from services import packages

        key = (data["sold_package"] or "").strip()
        if not key:
            lead.sold_package = None
            lead.sold_amount = None
            lead.sold_at = None
        else:
            price = packages.price_of(key)
            if price is None:
                return jsonify({"error": "No such package."}), 400
            if lead.sold_at is None:
                lead.sold_at = datetime.now(timezone.utc)
            lead.sold_package = key
            # Copied, not looked up later -- see services/packages.py.
            lead.sold_amount = price

    # What the client paid for this listing's marketing. Empty clears it back
    # to unsold, which has to stay possible -- a figure typed into the wrong
    # lead is otherwise permanent.
    if "sold_amount" in data:
        raw = data["sold_amount"]
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            lead.sold_amount = None
            lead.sold_at = None
            lead.sold_package = None
        else:
            try:
                # Typed by hand, so tolerate what a person types: "$1,200".
                amount = float(str(raw).replace("$", "").replace(",", "").strip())
            except ValueError:
                return jsonify({"error": "That isn't an amount."}), 400
            if amount < 0:
                return jsonify({"error": "An amount can't be negative."}), 400
            # A cap, because this figure drives the revenue headline and a
            # slipped keystroke should not silently report a fortune.
            if amount > 10_000_000:
                return jsonify({"error": "That amount looks like a typo."}), 400
            # Stamped when the amount first lands, and left alone afterwards
            # so correcting a figure doesn't move the sale to today.
            if lead.sold_at is None:
                lead.sold_at = datetime.now(timezone.utc)
            lead.sold_amount = round(amount, 2)

    # The finished video for this listing. Nothing in this app renders one
    # yet, so it is pasted in from wherever it was produced -- and it is
    # what makes the lead eligible for outreach, since the pitch is the video.
    if "video_url" in data:
        video = (data["video_url"] or "").strip()
        if video and not video.lower().startswith(("http://", "https://")):
            return jsonify({"error": "The video link needs to start with http:// or https://"}), 400
        lead.video_url = video or None

    for field in ("notes", "agent_name", "agent_phone", "brokerage"):
        if field in data:
            # Empty string clears the field rather than storing a blank.
            setattr(lead, field, (data[field] or "").strip() or None)

    db.session.commit()
    return jsonify(lead.to_dict())


@studio_bp.route("/api/leads/<int:lead_id>", methods=["GET"])
@login_required
def api_get_lead(lead_id):
    try:
        from extensions import db
        from models import Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404
    return jsonify(lead.to_dict())


@studio_bp.route("/api/leads/<int:lead_id>/photos", methods=["POST"])
@login_required
def api_lead_photos(lead_id):
    """Pull the listing's photos into the lead the same way Create Video
    pulls them from a pasted URL, so a lead profile already has its images
    without the user going and fetching them.

    Cached: once a lead has photos we return them untouched, because this
    fires automatically on every profile open. Pass {"force": true} to
    re-pull (the profile's "Re-fetch photos" button), which starts from an
    empty set so removed listing photos actually disappear.
    """
    try:
        from extensions import db
        from models import Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    force = bool((request.get_json(force=True, silent=True) or {}).get("force"))

    existing = lead.photo_urls
    if existing and not force:
        return jsonify({"photos": existing, "cached": True})

    if not lead.listing_url:
        return jsonify({"photos": existing, "error": "This lead has no listing URL to pull photos from."})

    meta = extract_meta(lead.listing_url)
    candidates = list(meta.get("images") or [])
    hero = meta.get("image")
    if hero and hero not in candidates:
        candidates.insert(0, hero)

    if not candidates:
        return jsonify({
            "photos": existing,
            "blocked": bool(meta.get("blocked")),
            "error": meta.get("error") or "No photos found on that listing page.",
        })

    keep = [] if force else existing
    result = download_image_urls(candidates, keep)
    photos = keep + result["photos"]

    # Only fill facts the lead is actually missing -- whatever the extension
    # parsed off the real page beats anything scraped from preview metadata.
    for field in ("beds", "baths", "sqft", "property_type"):
        if getattr(lead, field, None) is None and meta.get(field) is not None:
            setattr(lead, field, meta[field])

    lead.photo_urls = photos
    db.session.commit()

    return jsonify({
        "photos": photos,
        "added": len(result["photos"]),
        "failed": len(result["failed"]),
        "duplicates": result["duplicates"],
        "blocked": bool(meta.get("blocked")),
        "error": meta.get("error") if not result["photos"] else None,
    })


@studio_bp.route("/api/extension/login", methods=["POST"])
def api_extension_login():
    """Sign the Chrome extension in with the same credentials as Studio
    itself, and hand back the account's key.

    The extension used to hold a shared Basic Auth username and password
    that opened the whole admin API and said nothing about who was
    capturing. Now it signs in as a person, exactly like the web app, and
    stores only that account's key -- which is revocable on its own and
    identifies the owner of every lead it captures.

    Deliberately not behind login_required: this is what establishes the
    session in the first place.
    """
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    user = find_user_by_email(email)
    if not user or not user.get("password_hash"):
        # Google-only accounts have no password to check. Same generic reply
        # either way, so this can't be used to find out which emails exist.
        return jsonify({"error": "Incorrect email or password."}), 401
    if not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Incorrect email or password."}), 401

    return jsonify({"token": user_api_key(user), "email": user["email"]})


@studio_bp.route("/api/extension/me", methods=["GET"])
def api_extension_me():
    """Who a stored extension token belongs to, so the panel can show the
    signed-in account and detect a token that's no longer valid."""
    user_id = user_id_for_api_key(request.headers.get("X-Estly-Key"))
    if not user_id:
        return jsonify({"error": "Not signed in."}), 401
    user = next((u for u in load_users() if u["id"] == user_id), None)
    return jsonify({"email": user["email"] if user else None})


@studio_bp.route("/api/my-key", methods=["GET"])
@login_required
def api_my_key():
    """The signed-in account's extension key, so it can be copied into the
    Chrome extension's settings."""
    user = current_user()
    if not user:
        return jsonify({"error": "Not signed in."}), 401
    return jsonify({"api_key": user_api_key(user), "email": user.get("email")})


@studio_bp.route("/api/leads/<int:lead_id>/find-email", methods=["POST"])
@login_required
def api_find_email(lead_id):
    """Research this agent's email on demand and return the options, ranked.

    Writes nothing: the caller picks. The automatic pass on capture uses the
    same code, so the ranking here is the ranking that decided whether to fill
    the address in.
    """
    from extensions import db
    from services.email_lookup import research_agent_email
    from services.enrichment import known_domains_for

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404
    if not lead.agent_name:
        return jsonify({"error": "This lead has no agent name to search for."}), 400

    found = research_agent_email(
        lead.agent_name,
        brokerage=lead.brokerage,
        city=lead.city,
        state=lead.state,
        phone=lead.agent_phone,
        known_domains=known_domains_for(lead.brokerage),
    )
    lead.email_candidates = found["candidates"]
    db.session.commit()
    return jsonify(found)


@studio_bp.route("/api/leads/<int:lead_id>/candidates", methods=["POST"])
@login_required
def api_email_candidates(lead_id):
    """Drop email candidates you have judged.

    Either one address ("not that person") or all of them, which is what
    picking an address means -- the question is answered and the reasoning
    behind it is just taking up the screen. Nothing is lost that cannot be
    recovered: Check email re-runs the research at any time.
    """
    from extensions import db

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    data = request.get_json(force=True, silent=True) or {}
    if data.get("clear"):
        lead.email_candidates = []
    elif data.get("remove"):
        target = (data["remove"] or "").strip().lower()
        lead.email_candidates = [
            c for c in lead.email_candidates if (c.get("email") or "").lower() != target
        ]
    else:
        return jsonify({"error": "Nothing to do."}), 400

    db.session.commit()
    return jsonify(lead.to_dict())


@studio_bp.route("/api/leads/bulk", methods=["POST"])
@login_required
def api_bulk_leads():
    """Apply one action to a set of leads in a single request, so selecting
    twenty leads and deleting them isn't twenty round trips.

    {"ids": [1,2,3], "action": "delete" | "status" | "qualify",
     "value": <status string> | <bool>}

    Unknown ids are ignored rather than failing the whole batch -- a stale
    tab can easily hold an id someone else already deleted. The response
    reports how many rows were actually touched.
    """
    try:
        from extensions import db
        from models import VALID_STATUSES, Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ids")
    action = data.get("action")

    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "No leads selected."}), 400
    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return jsonify({"error": "Lead ids must be numbers."}), 400

    leads = owned_leads_query().filter(Lead.id.in_(ids)).all()
    if not leads:
        return jsonify({"affected": 0, "missing": len(ids)})

    if action == "delete":
        # Bulk delete is the one action here that destroys data outright,
        # so take a snapshot we can fall back on first.
        from services.backup import snapshot
        from flask import current_app

        snapshot(current_app, "bulk-delete")
        for lead in leads:
            db.session.delete(lead)
    elif action == "status":
        value = data.get("value")
        if value not in VALID_STATUSES:
            return jsonify({"error": f"status must be one of {VALID_STATUSES}"}), 400
        for lead in leads:
            lead.status = value
    elif action == "qualify":
        value = bool(data.get("value"))
        for lead in leads:
            lead.qualified = value
    else:
        return jsonify({"error": "action must be delete, status or qualify."}), 400

    db.session.commit()
    return jsonify({"affected": len(leads), "missing": len(ids) - len(leads), "action": action})


@studio_bp.route("/api/leads/<int:lead_id>", methods=["DELETE"])
@login_required
def api_delete_lead(lead_id):
    try:
        from extensions import db
        from models import Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    db.session.delete(lead)
    db.session.commit()
    return jsonify({"ok": True})


OUTREACH_FIELDS = {
    "email": "outreach_email_sent_at",
    "phone": "outreach_phone_called_at",
    "video": "outreach_video_sent_at",
}


@studio_bp.route("/api/leads/<int:lead_id>/outreach", methods=["PATCH"])
@login_required
def api_toggle_outreach(lead_id):
    """Toggles one outreach checklist item (email/phone/video) on a lead --
    sets it to now if it was empty, clears it back to empty if it was
    already checked, so a mis-click can always be undone."""
    try:
        from extensions import db
        from models import Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    data = request.get_json(force=True, silent=True) or {}
    field = data.get("field")
    if field not in OUTREACH_FIELDS:
        return jsonify({"error": f"field must be one of {list(OUTREACH_FIELDS)}"}), 400

    column = OUTREACH_FIELDS[field]
    was_set = getattr(lead, column) is not None
    setattr(lead, column, None if was_set else datetime.now(timezone.utc))
    db.session.commit()
    return jsonify(lead.to_dict())


@studio_bp.route("/api/leads/<int:lead_id>/rooms", methods=["GET"])
@login_required
def api_lead_rooms(lead_id):
    """This lead's photos grouped by room, in walkthrough order."""
    from services.rooms import group_photos, is_configured

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    rooms = lead.photo_rooms
    return jsonify({
        "configured": is_configured(),
        "sorted_count": len(rooms),
        "photo_count": len(lead.photo_urls or []),
        "groups": group_photos(lead.photo_urls, rooms),
    })


@studio_bp.route("/api/leads/<int:lead_id>/rooms", methods=["POST"])
@login_required
def api_sort_rooms(lead_id):
    """Sort this lead's photos now, rather than waiting on capture.

    Runs in the background like the automatic pass; the caller polls the GET.
    """
    from flask import current_app
    from services.enrichment import sort_rooms_async
    from services.rooms import is_configured

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404
    if not is_configured():
        return jsonify({"error": "Room sorting isn't connected. Add an Anthropic "
                                 "API key to studio/anthropic.json."}), 400
    if not lead.photo_urls:
        return jsonify({"error": "This lead has no photos."}), 400

    sort_rooms_async(current_app._get_current_object(), lead_id)
    return jsonify({"started": True}), 202


@studio_bp.route("/api/leads/<int:lead_id>/rooms/sheets", methods=["POST"])
@login_required
def api_room_sheets(lead_id):
    """Build numbered contact sheets of this lead's photos.

    The free path for sorting: with no API key configured, the app can still do
    everything up to the point where something has to actually look at the
    photos. Twenty photos to a sheet, so Claude reads three images rather than
    fifty-seven, and the numbers are the photo's index in the lead's own list.
    """
    from contact_sheet import build_sheets

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    photos = lead.photo_urls or []
    if not photos:
        return jsonify({"error": "This lead has no photos."}), 400

    try:
        paths = build_sheets(lead_id, photos)
    except Exception as exc:  # noqa: BLE001 -- report rather than 500
        return jsonify({"error": f"Could not build the sheets: {exc}"}), 500

    sheet_urls = ["/studio/static/_sheets/" + os.path.basename(p) for p in paths]

    # Drop a request on disk. A Claude session watching this directory picks it
    # up and sorts the photos -- which is what makes the button feel automatic
    # without the app paying an API per photo. Nothing depends on anyone
    # watching: the sheets are built and usable either way.
    queued = False
    try:
        queue_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                 "_sort_queue")
        os.makedirs(queue_dir, exist_ok=True)
        with open(os.path.join(queue_dir, f"lead{lead_id}.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "lead_id": lead_id,
                "address": lead.address,
                "photo_count": len(photos),
                "unsorted": sum(1 for u in photos if u not in lead.photo_rooms),
                "sheets": [os.path.basename(p) for p in paths],
                "requested_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }, fh)
        queued = True
    except OSError:
        pass  # the sheets still exist; only the hand-off is missing

    return jsonify({
        "sheets": sheet_urls,
        "photo_count": len(photos),
        "queued": queued,
        "command": f"python contact_sheet.py --lead {lead_id}",
    })


def _prior_staging(owner_id, photo, style):
    """A staged image this user already paid for, for this photo and style.

    Matching on both is the point: the same room in a different style is a
    different image and has to be generated. Only completed runs count, and
    the file has to still be on disk -- a database row pointing at a deleted
    file would show a broken image instead of costing $0.08.
    """
    import os

    from models import StagingJob

    jobs = (
        StagingJob.query.filter_by(owner_id=owner_id, status="completed")
        .order_by(StagingJob.created_at.desc())
        .limit(50)
        .all()
    )
    for job in jobs:
        for room in job.rooms:
            if (
                room.get("photo") == photo
                and room.get("style") == style
                and room.get("staged_url")
            ):
                local = os.path.join(
                    "studio", "static", *room["staged_url"].split("/studio/static/")[-1].split("/")
                )
                if os.path.exists(local):
                    return room["staged_url"]
    return None


@studio_bp.route("/api/scenery/status", methods=["GET"])
@login_required
def api_scenery_status():
    """Whether staging is connected, and what one room costs."""
    from services.staging import STYLE_PROMPTS, estimate_cost, load_config
    from services.staging_jobs import is_busy

    from services.staging import is_configured, not_configured_message

    cfg = load_config()
    ok = is_configured(cfg)
    gemini = cfg["provider"] == "gemini"
    if gemini:
        from services import gemini_image

        model = gemini_image.load_config()["model"]
    else:
        model = cfg["model"]

    return jsonify({
        "configured": ok,
        "config_error": None if ok else not_configured_message(cfg),
        "provider": cfg["provider"],
        "free": gemini,
        "model": model,
        "cost_per_image": estimate_cost(1, cfg),
        "styles": sorted(STYLE_PROMPTS.keys()),
        "busy": is_busy(),
    })


@studio_bp.route("/api/scenery/jobs/<int:job_id>", methods=["GET"])
@login_required
def api_scenery_job(job_id):
    """One staging run, for polling. Scoped to its owner like everything else."""
    from extensions import db
    from models import StagingJob

    from services.staging_jobs import progress_for

    job = db.session.get(StagingJob, job_id)
    if job is None or job.owner_id != session["user_id"]:
        return jsonify({"error": "Job not found."}), 404

    payload = job.to_dict()
    # Which refinement pass each room is on, for the progress popup. Only
    # meaningful while the job is running; it is discarded when it ends.
    live = progress_for(job_id)
    for index, room in enumerate(payload["rooms"]):
        if index in live:
            room.update(live[index])
    return jsonify({"job": payload})


@studio_bp.route("/api/scenery/generate", methods=["POST"])
@login_required
def api_scenery_generate():
    """Stage the given rooms.

    Every room must arrive carrying its own style. There is deliberately no
    default applied here: the page starts this on its own once the styles are
    set, so a missing style would mean spending money on a guess.
    """
    from flask import current_app

    from services.staging import STYLE_PROMPTS, estimate_cost, load_config
    from services.staging_jobs import StagingJobBusy, start_job

    from services.staging import is_configured, not_configured_message

    cfg = load_config()
    if not is_configured(cfg):
        return jsonify({"error": not_configured_message(cfg)}), 400

    data = request.get_json(force=True, silent=True) or {}
    rooms = data.get("rooms") or []
    if not rooms:
        return jsonify({"error": "Pick at least one room to stage."}), 400

    clean = []
    for room in rooms:
        photo = (room.get("photo") or "").strip()
        style = (room.get("style") or "").strip()
        if not photo:
            return jsonify({"error": "A room arrived without a photo."}), 400
        if style not in STYLE_PROMPTS:
            return jsonify({"error": "Unknown style: %s" % (style or "(none)")}), 400
        clean.append({"photo": photo, "label": room.get("label"), "style": style})

    lead_id = data.get("lead_id")
    if lead_id:
        # Only to confirm it belongs to this user; the photos came with the
        # request either way.
        if get_owned_lead(int(lead_id)) is None:
            return jsonify({"error": "Lead not found."}), 404

    # Anything already generated for this exact photo and style is handed back
    # rather than bought twice. Coming back to a listing tomorrow, or after a
    # browser reload, otherwise re-pays for images that are sitting on disk.
    # "Try again" on a flagged room has to be able to get past reuse, or the
    # button would hand back the same doubtful image it is trying to replace.
    force = bool(data.get("force"))

    reused = []
    for room in list(clean):
        prior = None if force else _prior_staging(
            session["user_id"], room["photo"], room["style"])
        if prior:
            reused.append({**room, "status": "completed", "staged_url": prior})
            clean.remove(room)

    if not clean:
        return jsonify({
            "job": None,
            "reused": reused,
            "estimated_cost": 0,
        }), 200

    try:
        job = start_job(
            current_app._get_current_object(),
            session["user_id"],
            clean,
            lead_id=int(lead_id) if lead_id else None,
            address=data.get("address"),
        )
    except StagingJobBusy as exc:
        return jsonify({"error": str(exc)}), 409

    return jsonify({
        "job": job.to_dict(),
        "reused": reused,
        "estimated_cost": estimate_cost(len(clean), cfg),
    }), 201


@studio_bp.route("/api/video/status", methods=["GET"])
@login_required
def api_video_status():
    """Whether the generator is connected, and what a clip would cost."""
    from services.video import (
        DEFAULT_DURATION,
        DEFAULT_RESOLUTION,
        DURATION_CHOICES,
        MAX_DURATION,
        MIN_DURATION,
        EXTERIOR_MOVES,
        EXTERIOR_ROOMS,
        MOVES,
        NEEDS_ANCHOR,
        REAL_ESTATE_PROMPT,
        RESOLUTION_CHOICES,
        STYLE_DEFAULT_MOVE,
        estimate_cost,
        load_config,
    )
    from services.video_jobs import is_busy

    from services.video import model_info, resolved_rates

    cfg = load_config()
    info = model_info(cfg)
    return jsonify({
        "configured": bool(cfg["api_key"]),
        "config_error": cfg.get("config_error"),
        "model": cfg["model"],
        "rate_per_second": cfg["rate_per_second"],
        "cost_per_second": estimate_cost(1, cfg, info["resolutions"][-1]),
        # From the MODEL, not the config file. Reading it from the config was
        # why the page kept quoting Seedance's $0.597 after the switch to
        # Kling: the config no longer carries a rate table, so it fell back to
        # a stale default.
        "rates": resolved_rates(cfg),
        "min_duration": MIN_DURATION,
        "max_duration": MAX_DURATION,
        "default_prompt": REAL_ESTATE_PROMPT,
        # The camera moves, served from the one definition so the buttons and
        # the prompts can never drift apart.
        "moves": [{"key": k, "name": n, "desc": d} for k, n, d, _ in MOVES],
        # Kept separate rather than merged: the two sets are not
        # interchangeable, and offering "pan left" for a drone shot or a
        # flyover for a bathroom is how a wrong clip gets rendered.
        "exterior_moves": [{"key": k, "name": n, "desc": d,
                            "needs_anchor": k in NEEDS_ANCHOR}
                           for k, n, d, _ in EXTERIOR_MOVES],
        "exterior_rooms": list(EXTERIOR_ROOMS),
        "style_default_move": STYLE_DEFAULT_MOVE,
        # What the per-clip dropdowns offer, and what they start on.
        # From the model, not a global list: Kling 3.0 Pro is native 1080p
        # only, and offering 480p would be a dropdown that silently does
        # nothing or errors.
        "durations": info["durations"],
        "resolutions": info["resolutions"],
        "default_duration": DEFAULT_DURATION,
        "default_resolution": info["resolutions"][-1],
        "model_label": info["label"],
        "busy": is_busy(),
    })


@studio_bp.route("/api/leads/<int:lead_id>/video/job", methods=["GET"])
@login_required
def api_video_job(lead_id):
    """The most recent generation for this lead, for polling."""
    from services.video_jobs import latest_job_for

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    job = latest_job_for(lead_id)
    return jsonify({"job": job.to_dict() if job else None})


@studio_bp.route("/api/video/jobs/<int:job_id>", methods=["GET"])
@login_required
def api_video_job_by_id(job_id):
    """One render, for polling. Scoped to its owner like everything else."""
    from extensions import db
    from models import VideoJob

    job = db.session.get(VideoJob, job_id)
    if job is None or job.owner_id != session["user_id"]:
        return jsonify({"error": "Job not found."}), 404
    return jsonify({"job": job.to_dict()})


@studio_bp.route("/api/video/site", methods=["POST"])
@login_required
def api_video_site():
    """The outside of a property, and what can be flown over it.

    Run before an exterior render rather than after: whether the back of the
    house was ever photographed decides whether a front-to-back flyover is a
    real shot or an invented one, and that is worth knowing while it is still
    free to change.
    """
    from services import dronepath, site

    data = request.get_json(force=True, silent=True) or {}
    lead_id = data.get("lead_id")
    if not lead_id:
        return jsonify({"error": "Exterior shots need a lead, so the property "
                                 "can be looked at from the outside."}), 400

    lead = get_owned_lead(int(lead_id))
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    try:
        analysis = site.analyse(lead.id, lead.full_address, lead.photo_urls or [],
                                lead.photo_rooms or {},
                                force=bool(data.get("force")))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "site": {
            "front": analysis.get("front"),
            "rear": analysis.get("rear"),
            "aerials": analysis.get("aerials") or [],
            # The one that can carry the middle of a flight, which is a
            # different thing from "is an aerial".
            "aerial_close": analysis.get("aerial_close"),
            "aerial_why": analysis.get("aerial_why"),
            "front_faces": analysis.get("front_faces"),
            "depth": analysis.get("depth"),
            "notes": analysis.get("notes"),
            "satellite": analysis.get("satellite"),
            # A path drawn by hand, so the shots step can say the flight is
            # planned rather than leaving it to be discovered at render time.
            "flight_path": dronepath.describe(lead.drone_path) or None,
        },
        "clips": site.verdicts(analysis, data.get("clips") or []),
        "recommended": site.recommend(analysis),
    })


@studio_bp.route("/api/video/layout", methods=["POST"])
@login_required
def api_video_layout():
    """How the house fits together, and what each clip's move would reveal.

    Run before rendering rather than after: a move that would invent a room is
    worth knowing about while it is still free to change.
    """
    from services import layout

    data = request.get_json(force=True, silent=True) or {}
    lead_id = data.get("lead_id")
    if not lead_id:
        return jsonify({"error": "This listing has no lead, so its layout "
                                 "can't be analysed."}), 400

    lead = get_owned_lead(int(lead_id))
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    photos = lead.photo_urls or []
    if not photos:
        return jsonify({"error": "This lead has no photos."}), 400

    try:
        analysis = layout.analyse(lead.id, photos, force=bool(data.get("force")))
    except Exception as exc:  # noqa: BLE001 -- surfaced, not swallowed
        return jsonify({"error": str(exc)}), 502

    index_of = {url: i for i, url in enumerate(photos)}
    out = []
    for clip in (data.get("clips") or []):
        url = clip.get("photo")
        index = index_of.get(url)
        if index is None:
            out.append({"photo": url, "level": "unknown",
                        "reason": "This photo isn't part of the lead's listing."})
            continue
        check = layout.check_move(analysis, index, (clip.get("move") or "").lower())
        rec = layout.recommend(analysis, index)
        out.append({
            "photo": url,
            "level": check["level"],
            "reason": check["reason"],
            # The neighbour comes back as a URL, because that is what a render
            # needs -- the index is an implementation detail of the analysis.
            "anchor": photos[check["neighbour"]] if check["neighbour"] is not None else None,
            # Every move judged, so the dropdown can mark them, plus the one
            # worth using. A recommendation is never a risky move.
            "recommended": rec,
            "moves": {v["move"]: {"level": v["level"], "reason": v["reason"]}
                      for v in layout.verdicts(analysis, index)},
        })

    return jsonify({"clips": out})


@studio_bp.route("/capcut-asset/<name>")
@login_required
def capcut_asset(name):
    """CapCut's own mark and brand font, served from the local installation.

    Served rather than vendored: both are ByteDance's and this repo is public.
    See services.capcut.BRAND. A missing asset is a 404 the CSS shrugs off.
    """
    from services import capcut

    path = capcut.brand_asset(name)
    if not path:
        return jsonify({"error": "CapCut isn't installed."}), 404
    return send_file(path, max_age=86400)


@studio_bp.route("/api/video/capcut", methods=["POST"])
@login_required
def api_video_capcut():
    """Write the chosen clips into CapCut as an editable project.

    There is no CapCut API; this writes a draft into the folder CapCut reads
    its projects from. Nothing is uploaded and nothing is rendered here -- the
    assembly is ours, the editing and the export are CapCut's.
    """
    from services import capcut

    data = request.get_json(force=True, silent=True) or {}
    wanted = data.get("clips") or []
    if not wanted:
        return jsonify({"error": "Pick at least one clip."}), 400

    if not capcut.is_available():
        return jsonify({"error": "CapCut's drafts folder wasn't found at %s. If "
                                 "CapCut is installed elsewhere, set drafts_dir "
                                 "in studio/capcut.json."
                                 % capcut.drafts_dir()}), 400

    # Only this user's own rendered clips, resolved to real files. A draft
    # points at absolute paths on disk, so this is not a place to take a path
    # from the browser.
    from models import VideoJob

    owned = {}
    for job in VideoJob.query.filter_by(owner_id=session["user_id"]).all():
        for clip in job.clips:
            if clip.get("video_url"):
                owned[clip["video_url"]] = clip.get("duration") or job.duration or 5

    clips = []
    for item in wanted:
        url = (item.get("video_url") or "").strip()
        if url not in owned:
            return jsonify({"error": "That clip isn't one of yours."}), 400
        name = os.path.basename(url.split("?")[0])
        clips.append({
            "path": os.path.join(BASE_DIR, "static", "uploads", "clips", name),
            "duration": owned[url],
        })

    try:
        result = capcut.create_draft(data.get("name") or "estly listing", clips)
    except capcut.CapCutError as exc:
        return jsonify({"error": str(exc)}), 400

    # Opening CapCut is only possible because Studio runs on the same machine.
    # If this is ever hosted it stops working and should stop being offered --
    # a server cannot open an application on somebody else's desktop.
    if data.get("open", True):
        result["opened"] = capcut.launch()
    return jsonify(result), 201


@studio_bp.route("/api/calendly/upcoming", methods=["GET"])
@login_required
def api_calendly_upcoming():
    """The next few booked calls.

    Not configured is a normal state, not an error: the dashboard shows how
    to connect instead of an error box, and 200 keeps that out of the
    console.
    """
    from services import calendly

    if not calendly.is_configured():
        return jsonify({"configured": False, "events": []})

    try:
        return jsonify({"configured": True,
                        "events": calendly.upcoming(limit=5)})
    except calendly.CalendlyError as exc:
        return jsonify({"configured": True, "events": [], "error": str(exc)})


@studio_bp.route("/api/calendly/events", methods=["GET"])
@login_required
def api_calendly_events():
    """Bookings between two instants, for the calendar page.

    The window comes from the page as ISO timestamps, because the month it
    is showing is a LOCAL month and only the browser knows where its
    boundaries fall.
    """
    from services import calendly

    if not calendly.is_configured():
        return jsonify({"configured": False, "events": []})

    def parse(value, fallback):
        if not value:
            return fallback
        try:
            when = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return fallback
        # A naive value would be compared against aware ones downstream and
        # raise; assume UTC rather than fail the request.
        return when if when.tzinfo else when.replace(tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    start = parse(request.args.get("from"), now - timedelta(days=31))
    end = parse(request.args.get("to"), now + timedelta(days=62))
    if end < start:
        start, end = end, start

    try:
        return jsonify({"configured": True,
                        "events": calendly.events_between(start, end)})
    except calendly.CalendlyError as exc:
        return jsonify({"configured": True, "events": [], "error": str(exc)})


@studio_bp.route("/api/calendly/links", methods=["GET"])
@login_required
def api_calendly_links():
    """The bookable links to share with people."""
    from services import calendly

    if not calendly.is_configured():
        return jsonify({"configured": False, "links": []})
    try:
        return jsonify({"configured": True, "links": calendly.event_types()})
    except calendly.CalendlyError as exc:
        return jsonify({"configured": True, "links": [], "error": str(exc)})


@studio_bp.route("/api/calendly/status", methods=["GET"])
@login_required
def api_calendly_status():
    """Whether the token works and whose account it is."""
    from services import calendly

    if not calendly.is_configured():
        return jsonify({"configured": False})
    result = calendly.verify_connection()
    result["configured"] = True
    return jsonify(result)


@studio_bp.route("/api/stats", methods=["GET"])
@login_required
def api_stats():
    """The dashboard's numbers, for one period.

    Everything is computed here rather than in the browser so that spend is
    priced the same way it is on a lead profile. Two implementations of that
    would drift, and the pair that disagreed would both be showing dollars.
    """
    from models import Lead, StagingJob, VideoJob
    from services import stats

    owner = session["user_id"]
    # An unrecognised window falls back to all time rather than erroring: a
    # bad period should show more than the truth, never less.
    window = (request.args.get("range") or "day").lower()
    if window not in stats.RANGES:
        window = "all"

    return jsonify(stats.collect(
        owner_id=owner,
        window=window,
        leads=Lead.query.filter_by(owner_id=owner).all(),
        video_jobs=VideoJob.query.filter_by(owner_id=owner).all(),
        staging_jobs=StagingJob.query.filter_by(owner_id=owner).all(),
    ))


# Spend arithmetic lives in services.video, where Scenery-style callers can
# reach it too. Re-exported under the name the routes below already use.
from services.video import clip_cost  # noqa: E402


def exterior_site_facts(lead, site_data):
    """What the generator is told about the property, beyond its photographs.

    Geometry from the overhead view, and the house number from the address.
    The number is here because a general "do not change any number" did not
    hold -- the first flyover turned 8732 into 8753 within two and a half
    seconds -- and naming the value gives the model something to check
    against.

    Deliberately not included: anything the satellite can see BEHIND the
    house. Describing it is an instruction to draw it, and the only honest
    source for the far side is the rear photograph, which is the last frame.
    """
    number = ""
    for token in (lead.address or "").split():
        if token.isdigit():
            number = token
            break

    # A flight the user drew themselves outranks anything read off a
    # satellite: it is a stated intention, not an inference. It is carried as
    # the finished sentence rather than the points, because points cannot be
    # sent to the model -- there is no camera-path parameter.
    from services import dronepath

    return {
        "front_faces": site_data.get("front_faces"),
        "depth": site_data.get("depth"),
        "house_number": number or None,
        "flight_path": dronepath.describe(lead.drone_path) or None,
    }


def _clip_owner_job(job_id):
    """A video job this user owns, or None. Trash routes all need this."""
    from extensions import db
    from models import VideoJob

    job = db.session.get(VideoJob, job_id)
    if job is None or job.owner_id != session["user_id"]:
        return None
    return job


@studio_bp.route("/api/leads/<int:lead_id>/drone-path", methods=["GET", "POST"])
@login_required
def api_lead_drone_path(lead_id):
    """The planned flight path for this property.

    Stored on the lead: a path is a fact about the house, and every flight
    over it reuses the same one.
    """
    from extensions import db
    from services import dronepath

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    if request.method == "GET":
        path = lead.drone_path or {}
        return jsonify({"path": path, "described": dronepath.describe(path),
                        "images": dronepath.images_of(path),
                        "slots": dronepath.slots_of(path),
                        "earth_url": dronepath.earth_url(
                            dronepath.full_address(lead))})

    data = request.get_json(force=True, silent=True) or {}
    points = data.get("points") or []

    # The Earth stage manages the captures themselves before any line is
    # drawn on them: adding one, choosing which to draw on, removing one. The
    # path is left alone by an add -- taking a second angle is not abandoning
    # the flight -- and dropped by the other two, because a line drawn in one
    # picture's coordinates means nothing over a different picture.
    action = (data.get("action") or "").strip()
    image = (data.get("image") or "").strip()
    if not points and image and action in ("", "add", "primary", "remove",
                                          "slot", "unslot"):
        try:
            if action == "primary":
                path = dronepath.set_primary(lead, image)
            elif action == "remove":
                path = dronepath.remove_image(lead, image)
            elif action == "slot":
                path = dronepath.set_slot(lead, image, (data.get("slot") or "").strip())
            elif action == "unslot":
                path = dronepath.unset_slot(lead, image, (data.get("slot") or "").strip())
            else:
                path = dronepath.add_image(lead, image)
        except dronepath.PathError as exc:
            return jsonify({"error": str(exc)}), 400
        db.session.commit()
        return jsonify({"path": path, "images": dronepath.images_of(path),
                        "slots": dronepath.slots_of(path),
                        "described": dronepath.describe(path)})

    if not isinstance(points, list) or len(points) < 2:
        return jsonify({"error": "A path needs at least two points."}), 400

    clean = []
    for point in points[:200]:
        try:
            clean.append([float(point[0]), float(point[1])])
        except (TypeError, ValueError, IndexError):
            return jsonify({"error": "That path has a point in it that "
                                     "isn't a coordinate."}), 400

    existing = lead.drone_path or {}
    path = {
        "points": clean,
        "width": float(data.get("width") or 0) or None,
        "height": float(data.get("height") or 0) or None,
        "image": (data.get("image") or "").strip() or None,
        # Saving a path is not a statement about the other captures, so the
        # gallery survives it.
        "images": dronepath.images_of(existing),
        "references": [r for r in (data.get("references") or []) if isinstance(r, str)][:8],
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    lead.drone_path = path
    db.session.commit()
    return jsonify({"path": path, "described": dronepath.describe(path)})


def _capture_edit(lead_id, make_new):
    """Shared body of the capture edits.

    Cropping and reverting do the same three things -- make a new file, swap
    it into the flight plan, answer with the gallery -- and differ only in how
    the file is made. Writing that once is what keeps them from drifting into
    disagreeing about what a capture is.
    """
    from extensions import db
    from services import dronepath, enhance

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    data = request.get_json(silent=True) or {}
    image = (data.get("image") or "").strip()
    if image not in dronepath.images_of(lead.drone_path or {}):
        return jsonify({"error": "That view is not one of this listing's captures."}), 400

    try:
        replacement = make_new(lead, image, data)
    except (enhance.EnhanceError, dronepath.PathError) as exc:
        return jsonify({"error": str(exc)}), 400

    path = dronepath.replace_image(lead, image, replacement)
    db.session.commit()
    return jsonify({"image": replacement, "was": image,
                    "images": dronepath.images_of(path),
                    "originals": path.get("originals") or {},
                    "primary": path.get("image")})


@studio_bp.route("/api/leads/<int:lead_id>/captures/crop", methods=["POST"])
@login_required
def api_capture_crop(lead_id):
    """Crop one Earth capture to a box drawn in its own pixels."""
    from services import enhance

    return _capture_edit(
        lead_id,
        lambda lead, image, data: enhance.crop_capture(lead, image, data.get("box") or []))


@studio_bp.route("/api/leads/<int:lead_id>/generate-side", methods=["POST", "DELETE"])
@login_required
def api_generate_side(lead_id):
    """Make -- or discard -- the shot for one side of the property.

    Two ways in. Normally this generates: Nano Banana Pro is handed that
    side's placed views and photographs and asked for one photograph back.
    Passing an already-uploaded `image` files that instead, which is how a
    shot made somewhere else gets in.

    One image per side, replaced rather than accumulated. There is one front
    of a house, and a gallery of attempts at it is a decision deferred rather
    than a decision made. The previous file stays on disk, so discarding is a
    swap and not a deletion.
    """
    from extensions import db
    from services import dronepath, enhance

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    data = request.get_json(silent=True) or {}
    side = (data.get("side") or "").strip().lower()
    if side not in dronepath.SIDES:
        return jsonify({"error": "There is no such side."}), 400

    # Which references, when the page has been rearranged. Checked inside
    # enhance_capture against what this lead actually owns, so an edited
    # request cannot reach for another listing's photographs.
    chosen = data.get("references")
    chosen = [u for u in chosen if isinstance(u, str)]         if isinstance(chosen, list) else None

    if request.method == "DELETE":
        path = dronepath.set_generated(lead, side, None)
        db.session.commit()
        return jsonify({"generated": dronepath.generated_of(path)})

    image = (data.get("image") or "").strip()
    if image:
        # A finished shot arriving from somewhere else. Checked rather than
        # trusted: it has to be something the upload endpoint wrote and it
        # has to still be there, because this becomes a video's first frame.
        if not image.startswith("/studio/static/uploads/"):
            return jsonify({"error": "That image was not uploaded here."}), 400
        if not local_path_from_url(image) or not local_path_from_url(image).exists():
            return jsonify({"error": "That image is not on disk."}), 400
    else:
        base, references = dronepath.base_for(lead, side)
        if chosen is not None:
            references = chosen[:dronepath.MAX_REFERENCES]
        if not base:
            return jsonify({"error": "Nothing is placed for the %s of this "
                                     "property yet." % side}), 400
        try:
            # The page shows this text before it asks for a confirmation, so
            # what arrives here is what was on screen -- edited or not. Sent
            # every time rather than only when changed: "what I saw" and
            # "what ran" are the same string or the confirmation was theatre.
            image = enhance.enhance_capture(
                lead, base, references=references,
                model=(data.get("model") or "").strip() or None,
                prompt=data.get("prompt"), side=side)
        except enhance.EnhanceError as exc:
            return jsonify({"error": str(exc)}), 400

    # Reloaded before the write, because generating took a minute and the
    # other side may have finished during it. Both sides live in one JSON
    # column: this request read it before its own call started, and writing
    # that stale copy back is how a finished back shot vanished while the
    # front was recorded -- the picture was on disk, nothing pointed at it.
    db.session.refresh(lead)

    path = dronepath.set_generated(lead, side, image)
    db.session.commit()
    return jsonify({"side": side, "image": image,
                    "generated": dronepath.generated_of(path)})


@studio_bp.route("/api/leads/<int:lead_id>/captures/revert", methods=["POST"])
@login_required
def api_capture_revert(lead_id):
    """Put the capture back the way it came out of Google Earth.

    The edited file stays on disk. Reverting is a swap in the flight plan,
    which means re-editing does not have to start from a re-capture.
    """
    from extensions import db
    from services import dronepath

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    image = ((request.get_json(silent=True) or {}).get("image") or "").strip()
    original = dronepath.original_of(lead.drone_path or {}, image)
    if not original:
        return jsonify({"error": "That view is the original."}), 400

    try:
        path = dronepath.replace_image(lead, image, original)
    except dronepath.PathError as exc:
        return jsonify({"error": str(exc)}), 400
    db.session.commit()
    return jsonify({"image": original, "was": image,
                    "images": dronepath.images_of(path),
                    "originals": path.get("originals") or {},
                    "primary": path.get("image")})


@studio_bp.route("/api/showcase/rebuild", methods=["POST"])
@login_required
def api_showcase_rebuild():
    """Rebuild the two loops on the Create page from current work.

    On request rather than on every visit: a Create page that waits for two
    encodes before showing you a menu is worse than one showing last week's
    loop. Encoding is local, so this costs nothing but seconds.
    """
    from services import showcase

    made = showcase.build_all()
    return jsonify({
        "built": {k: bool(v["path"]) for k, v in made.items()},
        "errors": {k: v["error"] for k, v in made.items() if v["error"]},
        "status": showcase.status(),
    })


@studio_bp.route("/api/folders", methods=["GET", "POST"])
@login_required
def api_folders():
    """The Projects page's folders, and making a new one."""
    from extensions import db
    from models import Lead, ProjectFolder

    owner = session["user_id"]

    if request.method == "POST":
        name = ((request.get_json(force=True, silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "A folder needs a name."}), 400
        if len(name) > 120:
            return jsonify({"error": "That name is too long."}), 400
        folder = ProjectFolder(owner_id=owner, name=name)
        db.session.add(folder)
        db.session.commit()
        return jsonify(folder.to_dict()), 201

    folders = (ProjectFolder.query.filter_by(owner_id=owner)
               .order_by(ProjectFolder.name.asc()).all())
    # One count query rather than one per folder. Dead leads are left out
    # because the Projects page does not show them -- counting them would
    # have a folder claim two projects and display one.
    counts = {}
    for lead in Lead.query.filter_by(owner_id=owner).all():
        if lead.folder_id and lead.status != "dead":
            counts[lead.folder_id] = counts.get(lead.folder_id, 0) + 1

    return jsonify({"folders": [
        dict(f.to_dict(), count=counts.get(f.id, 0)) for f in folders
    ]})


@studio_bp.route("/api/folders/<int:folder_id>", methods=["PATCH", "DELETE"])
@login_required
def api_folder(folder_id):
    """Rename a folder, or remove it.

    Deleting a folder never deletes what is in it: the projects inside are
    put back at the top level. A folder is a way of arranging listings, and
    tidying the arrangement away should not take the work with it.
    """
    from extensions import db
    from models import Lead, ProjectFolder

    folder = db.session.get(ProjectFolder, folder_id)
    if folder is None or folder.owner_id != session["user_id"]:
        return jsonify({"error": "Folder not found."}), 404

    if request.method == "DELETE":
        moved = Lead.query.filter_by(owner_id=session["user_id"],
                                     folder_id=folder.id).all()
        for lead in moved:
            lead.folder_id = None
        db.session.delete(folder)
        db.session.commit()
        return jsonify({"deleted": True, "released": len(moved)})

    name = ((request.get_json(force=True, silent=True) or {}).get("name") or "").strip()
    if not name:
        return jsonify({"error": "A folder needs a name."}), 400
    folder.name = name[:120]
    db.session.commit()
    return jsonify(folder.to_dict())


@studio_bp.route("/api/folders/move", methods=["POST"])
@login_required
def api_folder_move():
    """Put projects into a folder, or back at the top level with folder null."""
    from extensions import db
    from models import Lead, ProjectFolder

    data = request.get_json(force=True, silent=True) or {}
    lead_ids = [int(i) for i in (data.get("lead_ids") or []) if str(i).isdigit()]
    if not lead_ids:
        return jsonify({"error": "Nothing to move."}), 400

    target = data.get("folder_id")
    if target is not None:
        folder = db.session.get(ProjectFolder, int(target))
        if folder is None or folder.owner_id != session["user_id"]:
            return jsonify({"error": "Folder not found."}), 404
        target = folder.id

    moved = 0
    for lead in Lead.query.filter(Lead.id.in_(lead_ids),
                                  Lead.owner_id == session["user_id"]).all():
        lead.folder_id = target
        moved += 1
    db.session.commit()
    return jsonify({"moved": moved, "folder_id": target})


@studio_bp.route("/api/video/clip/trash", methods=["POST"])
@login_required
def api_clip_trash():
    """Move a clip to the trash.

    Marks the clip and nothing else. The mp4 stays exactly where it is on
    disk -- this is reversible by design, and a delete that removes the file
    is not something a single stray click should be able to do to work that
    cost real money.
    """
    from extensions import db

    data = request.get_json(force=True, silent=True) or {}
    job = _clip_owner_job(int(data.get("job_id") or 0))
    if job is None:
        return jsonify({"error": "Render not found."}), 404

    clips = job.clips or []
    index = int(data.get("index", -1))
    if not 0 <= index < len(clips):
        return jsonify({"error": "No such clip."}), 404

    clips[index]["deleted_at"] = datetime.now(timezone.utc).isoformat()
    # Reassigned rather than mutated in place: clips is a JSON column behind a
    # property, and SQLAlchemy does not see a list edited through it.
    job.clips = clips
    db.session.commit()
    return jsonify({"trashed": True})


@studio_bp.route("/api/video/clip/restore", methods=["POST"])
@login_required
def api_clip_restore():
    """Take a clip back out of the trash."""
    from extensions import db

    data = request.get_json(force=True, silent=True) or {}
    job = _clip_owner_job(int(data.get("job_id") or 0))
    if job is None:
        return jsonify({"error": "Render not found."}), 404

    clips = job.clips or []
    index = int(data.get("index", -1))
    if not 0 <= index < len(clips):
        return jsonify({"error": "No such clip."}), 404

    clips[index].pop("deleted_at", None)
    job.clips = clips
    db.session.commit()
    return jsonify({"restored": True})


@studio_bp.route("/api/video/trash", methods=["GET"])
@login_required
def api_video_trash():
    """Every clip in the trash, newest deletion first."""
    from models import Lead, VideoJob

    jobs = VideoJob.query.filter_by(owner_id=session["user_id"]).all()
    addresses = {}
    lead_ids = {j.lead_id for j in jobs if j.lead_id}
    if lead_ids:
        for lead in Lead.query.filter(Lead.id.in_(lead_ids)).all():
            addresses[lead.id] = lead.address or lead.agent_name

    out = []
    for job in jobs:
        for index, clip in enumerate(job.clips or []):
            if not clip.get("deleted_at") or not clip.get("video_url"):
                continue
            out.append({
                "job_id": job.id,
                # So a page about one listing can show only its own trash.
                "lead_id": job.lead_id,
                "index": index,
                "address": addresses.get(job.lead_id) or "Untitled render",
                "video_url": clip.get("video_url"),
                "move": clip.get("move"),
                "duration": clip.get("duration") or job.duration,
                "resolution": clip.get("resolution") or job.resolution,
                "deleted_at": clip["deleted_at"],
            })

    out.sort(key=lambda c: c["deleted_at"], reverse=True)
    return jsonify({"clips": out})


@studio_bp.route("/api/video/jobs", methods=["GET"])
@login_required
def api_video_jobs():
    """Every render this user has finished, newest first.

    Video has no equivalent of Scenery's saved projects -- a render lives on
    the job row and nowhere else -- so this is the only way back to a clip
    once the page that made it has been left.

    Only jobs with at least one finished clip: a failed run is not something
    to browse back to.
    """
    from models import Lead, VideoJob
    from services.video import MODELS

    jobs = (
        VideoJob.query.filter_by(owner_id=session["user_id"])
        .order_by(VideoJob.created_at.desc())
        .limit(100)
        .all()
    )

    # Addresses in one query rather than one per job.
    lead_ids = {j.lead_id for j in jobs if j.lead_id}
    addresses = {}
    if lead_ids:
        for lead in Lead.query.filter(Lead.id.in_(lead_ids)).all():
            addresses[lead.id] = lead.address or lead.agent_name

    out = []
    for job in jobs:
        # Everything that landed, and separately what is still on show. The
        # two differ once something is trashed, and they are used for
        # different things: money spent is not undone by a deletion.
        delivered = [(i, c) for i, c in enumerate(job.clips or []) if c.get("video_url")]
        clips = [(i, c) for i, c in delivered if not c.get("deleted_at")]
        running = job.status in ("queued", "running")
        # A render that produced something, or one still going. Only a failed
        # run with nothing to show is left out -- and a render in progress is
        # exactly what somebody who navigated away is looking for.
        #
        # Kept on `delivered`, not on what is visible: a render whose clips
        # are all trashed still costs what it cost, and dropping it here made
        # the lead profile's spend fall by the price of the clip you just
        # tidied away while the dashboard, which counts differently, did not
        # move. Callers skip the ones with nothing to show.
        if not delivered and not running:
            continue
        out.append({
            "id": job.id,
            "lead_id": job.lead_id,
            "status": job.status,
            "running": running,
            "clips_total": max(len(job.specs), len(job.photos), len(job.clips)),
            "clips_done": len(delivered),
            "trashed": len(delivered) - len(clips),
            "address": addresses.get(job.lead_id) or "Untitled render",
            # created_at is naive UTC. .timestamp() would read it as local
            # time and put the render hours in the future -- which showed up
            # as "-1 days ago".
            "created_at": (
                job.created_at.replace(tzinfo=timezone.utc).timestamp()
                if job.created_at else None
            ),
            "model": job.model,
            # The friendly name, so a clip can say what made it without the
            # page carrying its own copy of the registry.
            "model_label": (MODELS.get(job.model) or {}).get("label") or job.model,
            "estimated_cost": job.estimated_cost,
            # What the delivered clips cost, priced at today's rates.
            #
            # Deliberately not job.estimated_cost, which is frozen at whatever
            # the rate table said when the job was submitted -- the first
            # Seedance run here still carries $0.67 from before 1080p was
            # corrected to $0.597/s, against $2.98 actually billed. A total
            # built from those would understate spending by 4x.
            #
            # Priced per DELIVERED clip too, so a run that failed before
            # producing a file is not counted as money spent. Trashed clips
            # still count: deleting one does not get the money back, and a
            # total that fell when you tidied up would be a lie.
            "cost": round(sum(clip_cost(job, c) for _, c in delivered), 2),
            "clips": [
                {
                    "index": i,
                    "video_url": c.get("video_url"),
                    # The photo this clip was made from, so the page can name
                    # the room without a second lookup -- the room labels are
                    # already on the lead, keyed by photo url.
                    "photo": c.get("photo"),
                    "move": c.get("move"),
                    "duration": c.get("duration") or job.duration,
                    "resolution": c.get("resolution") or job.resolution,
                    "cost": clip_cost(job, c),
                }
                for i, c in clips
            ],
        })
    return jsonify({"renders": out})


@studio_bp.route("/api/video/generate", methods=["POST"])
@login_required
def api_video_generate():
    """Start generating clips for the chosen photos.

    This spends money -- unlike Scenery, there is no free provider for video --
    so it only ever runs from an explicit click, and the photos have to be
    named. There is deliberately no "generate from all photos" default that
    could turn one stray click into thirty-nine clips.

    `lead_id` is optional: photos can arrive from a pasted link or an upload
    with no lead behind them, and those are just as renderable.
    """
    from flask import current_app

    from services.video import (
        DEFAULT_DURATION,
        DEFAULT_RESOLUTION,
        MAX_DURATION,
        MIN_DURATION,
        MOVE_PROMPTS,
        estimate_cost,
        is_exterior_move,
        load_config,
    )
    from services.video_jobs import VideoJobBusy, start_job

    cfg = load_config()
    if not cfg["api_key"]:
        return jsonify({"error": cfg.get("config_error") or
                        "The video generator isn't connected. Add an Atlas "
                        "Cloud key to studio/atlascloud.json."}), 400

    data = request.get_json(force=True, silent=True) or {}

    # Either a bare list of photos, or clips carrying a camera move each. The
    # render page sends the second; the first stays valid so a caller that does
    # not care about moves still works.
    # A clip carries its own move, length and resolution -- different rooms
    # want different lengths, and one setting for the whole render was the
    # wrong grain for the same reason one camera move was.
    from services.video import model_info

    info = model_info(cfg)
    allowed_res = info["resolutions"]

    lead_id_raw = data.get("lead_id")
    fallback_duration = data.get("duration") or DEFAULT_DURATION
    fallback_resolution = data.get("resolution") or DEFAULT_RESOLUTION

    incoming = data.get("clips")
    specs = []
    if incoming:
        photos = [(c.get("photo") or "").strip() for c in incoming]
        if any(not photo for photo in photos):
            return jsonify({"error": "A clip arrived without a photo."}), 400

        for clip in incoming:
            move = (clip.get("move") or "").strip().lower() or None
            if move and move not in MOVE_PROMPTS:
                return jsonify({"error": "Unknown camera move: %s" % move}), 400

            try:
                seconds = int(clip.get("duration") or fallback_duration)
            except (TypeError, ValueError):
                return jsonify({"error": "A clip's length must be a number."}), 400
            if not MIN_DURATION <= seconds <= MAX_DURATION:
                return jsonify({"error": "Clip length must be between %s and %s seconds."
                                % (MIN_DURATION, MAX_DURATION)}), 400

            res = (clip.get("resolution") or fallback_resolution).strip()
            if res not in allowed_res:
                return jsonify({"error": "%s doesn't offer %s. It does: %s."
                                % (info["label"], res, ", ".join(allowed_res))}), 400

            spec = {"move": move, "duration": seconds, "resolution": res}
            # An ending chosen by hand in the viewer. Validated below against
            # this lead's own photos -- an anchor is uploaded and used as a
            # real frame, so it is not a field to take on trust.
            chosen = (clip.get("anchor") or "").strip()
            if chosen:
                spec["chosen_anchor"] = chosen
            specs.append(spec)

    # Exterior moves are anchored from the SITE analysis, and a flyover that
    # cannot be anchored is refused outright rather than downgraded. Indoors
    # an unanchored move risks an invented door; outdoors it invents the back
    # of the house, which is a picture of a property that does not exist.
    if specs and lead_id_raw and any(is_exterior_move(s["move"]) for s in specs):
        from services import site as site_svc

        ext_lead = get_owned_lead(int(lead_id_raw))
        if ext_lead is None:
            return jsonify({"error": "Lead not found."}), 404
        try:
            site_data = site_svc.analyse(ext_lead.id, ext_lead.full_address,
                                         ext_lead.photo_urls or [],
                                         ext_lead.photo_rooms or {})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"error": "The outside of this property couldn't be "
                                     "analysed, so an exterior clip can't be "
                                     "rendered safely: %s" % exc}), 400

        allowed = set(ext_lead.photo_urls or [])
        for spec, photo in zip(specs, photos):
            if not is_exterior_move(spec["move"]):
                continue

            # A hand-picked ending replaces the analysis's guess, but only if
            # it is one of this listing's own photographs and not the frame
            # the clip starts from -- a clip that ends where it began is not a
            # flight, and an arbitrary URL here would be an upload of anything.
            chosen = spec.pop("chosen_anchor", None)
            if chosen:
                if chosen not in allowed:
                    return jsonify({"error": "That ending photo doesn't belong "
                                             "to this listing."}), 400
                if chosen == photo:
                    return jsonify({"error": "A clip can't end on the photo it "
                                             "starts from."}), 400
                spec["anchor"] = chosen
                spec["site"] = exterior_site_facts(ext_lead, site_data)
                continue

            check = site_svc.check_move(spec["move"], photo, site_data)
            if check["level"] == "blocked":
                return jsonify({"error": check["reason"]}), 400
            if check.get("anchor"):
                spec["anchor"] = check["anchor"]
            # The overhead view's findings travel with the spec. Only the
            # geometry -- which way the building faces and how much land there
            # is. What the satellite can see BEHIND the house is deliberately
            # not carried: describing it is an instruction to draw it, and the
            # only honest source for the far side is the rear photograph, which
            # is already the clip's last frame.
            spec["site"] = exterior_site_facts(ext_lead, site_data)

    # Interior clips are anchored by the layout pass, not by hand, so any
    # anchor the browser sent for one is dropped rather than trusted.
    for spec in specs:
        spec.pop("chosen_anchor", None)

    # Anchor every clip we can. The browser shows this before you press the
    # button, but attaching it here means a render is never sent unanchored
    # just because something skipped the check.
    if specs and lead_id_raw:
        try:
            from services import layout

            anchor_lead = get_owned_lead(int(lead_id_raw))
            if anchor_lead is not None:
                lead_photos = anchor_lead.photo_urls or []
                analysis = layout.analyse(anchor_lead.id, lead_photos)
                index_of = {url: i for i, url in enumerate(lead_photos)}
                for spec, photo in zip(specs, photos):
                    if is_exterior_move(spec["move"]):
                        continue   # already anchored from the site analysis
                    index = index_of.get(photo)
                    if index is None:
                        continue
                    check = layout.check_move(analysis, index, spec["move"])
                    if check["neighbour"] is not None:
                        spec["anchor"] = lead_photos[check["neighbour"]]
        except Exception:  # noqa: BLE001
            # An anchor is an improvement, not a requirement: a failed
            # analysis must not stop a render the user asked for.
            pass
    else:
        photos = [p for p in (data.get("photos") or []) if p]

    if not photos:
        return jsonify({"error": "Pick at least one photo."}), 400

    try:
        duration = int(fallback_duration)
    except (TypeError, ValueError):
        return jsonify({"error": "Duration must be a number."}), 400
    if not MIN_DURATION <= duration <= MAX_DURATION:
        return jsonify({"error": "Duration must be between %s and %s seconds."
                        % (MIN_DURATION, MAX_DURATION)}), 400

    resolution = str(fallback_resolution).strip()
    if resolution not in allowed_res:
        resolution = allowed_res[-1]

    lead_id = data.get("lead_id")
    if lead_id:
        lead = get_owned_lead(int(lead_id))
        if lead is None:
            return jsonify({"error": "Lead not found."}), 404
        lead_id = lead.id

    try:
        job = start_job(
            current_app._get_current_object(),
            session["user_id"],
            photos,
            lead_id=lead_id,
            # Left empty unless typed by hand: the worker builds each clip's
            # prompt from its own move. There is deliberately no way to end up
            # with no prompt at all -- an unguided clip is where the room starts
            # rearranging itself.
            prompt=(data.get("prompt") or "").strip() or None,
            specs=specs,
            duration=duration,
            resolution=resolution,
        )
    except VideoJobBusy as exc:
        return jsonify({"error": str(exc)}), 409

    return jsonify({
        "job": job.to_dict(),
        "estimated_cost": round(
            sum(estimate_cost(s["duration"], cfg, s["resolution"]) for s in specs)
            if specs else estimate_cost(duration, cfg, resolution) * len(photos),
            2,
        ),
    }), 201


@studio_bp.route("/api/video/drone", methods=["POST"])
@login_required
def api_video_drone():
    """Generate one drone shot from this property's captured views.

    Separate from /api/video/generate on purpose. That one renders a clip per
    listing photograph and validates every frame against lead.photo_urls --
    which is right for a walkthrough and wrong here, because these frames are
    Earth captures and are not listing photographs at all.

    The prompt comes from the same exterior stack the flyover clips use, so
    the rules a year of failed renders bought still apply, with the drawn
    flight path carried in as site context.
    """
    from flask import current_app

    from services import dronepath, video
    from services.video_jobs import VideoJobBusy, start_job

    cfg = video.load_config()
    if not cfg["api_key"]:
        return jsonify({"error": cfg.get("config_error") or
                        "The video generator isn't connected."}), 400

    data = request.get_json(silent=True) or {}
    lead = get_owned_lead(int(data.get("lead_id") or 0)) if str(
        data.get("lead_id") or "").isdigit() else None
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    path = lead.drone_path or {}
    captures = set(dronepath.images_of(path))

    start = (data.get("start") or "").strip()
    end = (data.get("end") or "").strip()
    if start not in captures:
        return jsonify({"error": "That starting frame is not one of this "
                                 "property's captures."}), 400
    if end and end not in captures:
        return jsonify({"error": "That ending frame is not one of this "
                                 "property's captures."}), 400
    if end and end == start:
        return jsonify({"error": "A shot can't end on the frame it starts "
                                 "from."}), 400

    move = (data.get("move") or "").strip().lower()
    if move not in dict((k, n) for k, n, _, _ in video.EXTERIOR_MOVES):
        return jsonify({"error": "Unknown drone move."}), 400

    info = video.model_info(cfg)
    try:
        seconds = int(data.get("duration") or 10)
    except (TypeError, ValueError):
        return jsonify({"error": "Length must be a number."}), 400
    if not video.MIN_DURATION <= seconds <= video.MAX_DURATION:
        return jsonify({"error": "Length must be between %s and %s seconds."
                        % (video.MIN_DURATION, video.MAX_DURATION)}), 400

    resolution = (data.get("resolution") or "1080p").strip()
    if resolution not in info["resolutions"]:
        return jsonify({"error": "%s doesn't offer %s." % (info["label"], resolution)}), 400

    # House number, plot geometry and the drawn flight, the same facts the
    # exterior clips carry.
    site = exterior_site_facts(lead, {})
    spec = {"move": move, "duration": seconds, "resolution": resolution,
            "site": site}
    if end:
        spec["anchor"] = end

    try:
        job = start_job(current_app._get_current_object(), session["user_id"],
                        [start], lead_id=lead.id, duration=seconds,
                        resolution=resolution, specs=[spec])
    except VideoJobBusy as exc:
        return jsonify({"error": str(exc)}), 409

    return jsonify({"job_id": job.id, "estimated_cost": job.estimated_cost})


@studio_bp.route("/api/video/jobs/<int:job_id>/cancel", methods=["POST"])
@login_required
def api_video_cancel(job_id):
    """Stop a run. Clips already generated are kept -- they were paid for."""
    from extensions import db
    from models import VideoJob

    job = VideoJob.query.filter_by(id=job_id, owner_id=session.get("user_id")).first()
    if job is None:
        return jsonify({"error": "Job not found."}), 404
    if job.status in ("completed", "failed"):
        return jsonify({"error": "That job has already finished."}), 400

    job.status = "cancelled"
    db.session.commit()
    return jsonify({"job": job.to_dict()})


@studio_bp.route("/api/outreach/stats", methods=["GET"])
@login_required
def api_outreach_stats():
    """What GoHighLevel knows about the outreach, alongside what this app does."""
    from models import Lead
    from services.gohighlevel import (
        GoHighLevelError,
        GoHighLevelNotConfigured,
        fetch_stats,
    )

    leads = owned_leads_query().all()
    app_side = {
        "leads": len(leads),
        "sent": sum(1 for l in leads if l.outreach_email_sent_at),
        "with_video": sum(1 for l in leads if l.video_url),
        "with_email": sum(1 for l in leads if l.agent_email),
    }

    try:
        ghl = fetch_stats()
    except GoHighLevelNotConfigured as exc:
        return jsonify({"app": app_side, "ghl": None, "error": str(exc)})
    except GoHighLevelError as exc:
        return jsonify({"app": app_side, "ghl": None, "error": str(exc)}), 200

    return jsonify({"app": app_side, "ghl": ghl})


@studio_bp.route("/api/outreach/queue", methods=["GET"])
@login_required
def api_outreach_queue():
    """Everything waiting on a send decision, and why.

    Split three ways rather than filtered down to the sendable ones: seeing
    that eleven leads are stuck on "no finished video" is the useful signal,
    and it would be invisible if the queue only listed what was ready.
    """
    from models import Lead
    from services import outreach
    from services.gohighlevel import is_configured

    leads = owned_leads_query().order_by(Lead.updated_at.desc()).all()

    ready, waiting, sent = [], [], []
    for lead in leads:
        item = outreach.review_item(lead)
        if lead.outreach_email_sent_at:
            sent.append(item)
        elif lead.outreach_skipped:
            continue
        elif item["ready"]:
            ready.append(item)
        else:
            waiting.append(item)

    # The sent list is trimmed for the ordinary queue view, where it is
    # history. The follow-up views are working lists, not history, so they
    # ask for all of it -- a lead falling off the end at twenty would be a
    # lead silently dropped from the chase.
    full = request.args.get("sent") == "all"

    return jsonify({
        "connected": is_configured(),
        "ready": ready,
        "waiting": waiting,
        "sent": sent if full else sent[:20],
        "skipped_count": sum(1 for l in leads if l.outreach_skipped and not l.outreach_email_sent_at),
    })


@studio_bp.route("/api/outreach/status", methods=["GET"])
@login_required
def api_outreach_status():
    """Whether GoHighLevel is reachable, and whether the merge fields exist.

    A missing custom field doesn't error on send -- GHL just ignores the key
    -- so the failure mode is an email that goes out with a blank where the
    address or video link should be. Better to surface it here.
    """
    from services.gohighlevel import (
        CUSTOM_FIELDS,
        GoHighLevelError,
        GoHighLevelNotConfigured,
        verify_connection,
    )

    try:
        return jsonify(verify_connection())
    except GoHighLevelNotConfigured as exc:
        return jsonify({"ok": False, "configured": False, "error": str(exc),
                        "expected_fields": sorted(CUSTOM_FIELDS)}), 200
    except GoHighLevelError as exc:
        return jsonify({"ok": False, "configured": True, "error": str(exc)}), 200


@studio_bp.route("/api/leads/<int:lead_id>/outreach/preview", methods=["POST"])
@login_required
def api_outreach_preview(lead_id):
    """Exactly what would be sent to GoHighLevel, without sending it."""
    from extensions import db
    from services import outreach

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404
    try:
        result = outreach.send(lead, db.session, dry_run=True)
    except outreach.OutreachNotReady as exc:
        return jsonify({"error": f"Not ready to send: {exc}"}), 400
    except outreach.GoHighLevelNotConfigured as exc:
        return jsonify({"error": str(exc)}), 400
    except outreach.GoHighLevelError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify(result)


@studio_bp.route("/api/leads/<int:lead_id>/outreach/send", methods=["POST"])
@login_required
def api_outreach_send(lead_id):
    """Push this lead to GoHighLevel and tag it, which starts the email.

    This is the one place anything reaches a real agent, and it only ever runs
    from an explicit click in the review queue.
    """
    from extensions import db
    from services import outreach

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    try:
        result = outreach.send(lead, db.session)
    except outreach.OutreachNotReady as exc:
        return jsonify({"error": f"Not ready to send: {exc}"}), 400
    except outreach.GoHighLevelNotConfigured as exc:
        return jsonify({"error": str(exc)}), 400
    except outreach.GoHighLevelError as exc:
        return jsonify({"error": str(exc)}), 502

    return jsonify({"sent": True, "contact_id": result.get("contact_id"),
                    "new_contact": result.get("new"), "lead": lead.to_dict()})


@studio_bp.route("/api/leads/<int:lead_id>/outreach/skip", methods=["POST"])
@login_required
def api_outreach_skip(lead_id):
    """Take this lead out of the queue, or put it back."""
    from extensions import db
    from services import outreach

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404
    undo = bool((request.get_json(silent=True) or {}).get("undo"))
    outreach.skip(lead, db.session, undo=undo)
    return jsonify(lead.to_dict())


@studio_bp.route("/api/leads/<int:lead_id>/qualify", methods=["PATCH"])
@login_required
def api_toggle_qualify(lead_id):
    """Promotes/demotes a lead between the Lead Manager triage list (all
    leads) and the Dashboard's polished view (qualified leads only)."""
    try:
        from extensions import db
        from models import Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = get_owned_lead(lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    lead.qualified = not lead.qualified
    db.session.commit()
    return jsonify(lead.to_dict())


@studio_bp.route("/api/daily-goals", methods=["GET"])
@login_required
def api_get_daily_goals():
    """Today's outreach targets plus how many leads actually got each
    outreach action (email/phone/video) checked off today, for the
    dashboard's daily-checklist sidebar."""
    try:
        from extensions import db
        from models import DailyGoal, Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    user_id = session.get("user_id")
    goal = DailyGoal.query.filter_by(user_id=user_id).first()
    if goal is None:
        goal = DailyGoal(user_id=user_id, calls_target=0, emails_target=0, videos_target=0)
        db.session.add(goal)
        db.session.commit()

    today = datetime.now(timezone.utc).date()

    def count_done_today(column_name):
        column = getattr(Lead, column_name)
        rows = owned_leads_query().filter(column.isnot(None)).all()
        return sum(1 for lead in rows if getattr(lead, column_name).date() == today)

    result = goal.to_dict()
    result.update({
        "calls_done": count_done_today("outreach_phone_called_at"),
        "emails_done": count_done_today("outreach_email_sent_at"),
        "videos_done": count_done_today("outreach_video_sent_at"),
    })
    return jsonify(result)


@studio_bp.route("/api/daily-goals", methods=["PUT"])
@login_required
def api_set_daily_goals():
    try:
        from extensions import db
        from models import DailyGoal
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    goal = DailyGoal.query.filter_by(user_id=session.get("user_id")).first()
    if goal is None:
        goal = DailyGoal(user_id=session.get("user_id"))
        db.session.add(goal)

    data = request.get_json(force=True, silent=True) or {}
    for field in ("calls_target", "emails_target", "videos_target"):
        if field not in data:
            continue
        try:
            setattr(goal, field, max(0, int(data[field])))
        except (TypeError, ValueError):
            return jsonify({"error": f"{field} must be a number"}), 400

    db.session.commit()
    return jsonify(goal.to_dict())
