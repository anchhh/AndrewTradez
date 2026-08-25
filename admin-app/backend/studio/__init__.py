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
import io
import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from authlib.integrations.flask_client import OAuth
from bs4 import BeautifulSoup
from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for
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


def normalize_photo_key(url: str) -> str:
    """Collapse different size/format variants of the same photo to one key."""
    path = url.split("?")[0].split("#")[0]
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
    return (max_size, -FORMAT_RANK.get(ext.lower(), 5))


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
    return dedupe_photo_variants(found)[:MAX_IMAGE_CANDIDATES]


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
        result["error"] = (
            f"{source.capitalize()} returned status {resp.status_code} "
            "(likely bot-detection). Enter the details manually and upload photos below."
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

    lead = Lead.query.get(lead_id)
    if not lead:
        return None

    return {
        "lead_id": lead.id,
        "name": lead.address,
        "address": lead.address,
        "photos": lead.photo_urls,
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


@studio_bp.route("/create")
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

    return render_template("create.html", project=project, prefill=prefill)


@studio_bp.route("/create/style")
@login_required
def create_style():
    project_id = request.args.get("project")
    project = (
        next(
            (p for p in load_projects() if p["id"] == project_id and p.get("owner") == session["user_id"]),
            None,
        )
        if project_id
        else None
    )
    if not project:
        return redirect(url_for("studio.create"))
    return render_template("style.html", project=project)


@studio_bp.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html")


@studio_bp.route("/leads/<int:lead_id>")
@login_required
def lead_profile(lead_id):
    return render_template("lead_profile.html", lead_id=lead_id)


@studio_bp.route("/leads")
@login_required
def leads_manager():
    return render_template("leads_manager.html")


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
        "name", "url", "source", "address", "title", "description", "photos", "status", "style",
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

    query = Lead.query
    qualified_param = request.args.get("qualified")
    if qualified_param is not None:
        query = query.filter(Lead.qualified == (qualified_param.lower() in ("1", "true", "yes")))

    leads = query.order_by(Lead.created_at.desc()).limit(200).all()
    return jsonify([lead.to_dict() for lead in leads])


@studio_bp.route("/api/leads/<int:lead_id>", methods=["PATCH"])
@login_required
def api_update_lead_status(lead_id):
    try:
        from extensions import db
        from models import VALID_STATUSES, Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = db.session.get(Lead, lead_id)
    if lead is None:
        return jsonify({"error": "Lead not found."}), 404

    data = request.get_json(force=True, silent=True) or {}
    if "status" not in data and "notes" not in data:
        return jsonify({"error": "Nothing to update: send status and/or notes."}), 400

    if "status" in data:
        if data["status"] not in VALID_STATUSES:
            return jsonify({"error": f"status must be one of {VALID_STATUSES}"}), 400
        lead.status = data["status"]

    if "notes" in data:
        notes = data["notes"]
        # Empty string clears the note rather than storing a blank line.
        lead.notes = (notes or "").strip() or None

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

    lead = db.session.get(Lead, lead_id)
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

    lead = db.session.get(Lead, lead_id)
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


@studio_bp.route("/api/leads/<int:lead_id>", methods=["DELETE"])
@login_required
def api_delete_lead(lead_id):
    try:
        from extensions import db
        from models import Lead
    except ImportError:
        return jsonify({"error": "Lead pipeline isn't available."}), 501

    lead = db.session.get(Lead, lead_id)
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

    lead = db.session.get(Lead, lead_id)
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

    lead = db.session.get(Lead, lead_id)
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

    goal = db.session.get(DailyGoal, 1)
    if goal is None:
        goal = DailyGoal(id=1, calls_target=0, emails_target=0, videos_target=0)
        db.session.add(goal)
        db.session.commit()

    today = datetime.now(timezone.utc).date()

    def count_done_today(column_name):
        column = getattr(Lead, column_name)
        rows = Lead.query.filter(column.isnot(None)).all()
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

    goal = db.session.get(DailyGoal, 1)
    if goal is None:
        goal = DailyGoal(id=1)
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
