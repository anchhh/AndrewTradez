"""
Pushing a lead into GoHighLevel so GHL can do the actual emailing.

The app could send mail itself, but it runs on localhost: it only sends while
the laptop is on and the server is up, and a cold-outreach domain needs
unsubscribe handling, bounce processing and reputation warmup that would mean
rebuilding a CRM the user already pays for. So the split is:

    this app    -- decides who is worth mailing, and when
    GoHighLevel -- owns the sending, the opt-outs and the follow-ups

We upsert the agent as a contact carrying the listing details and the video
link, then add a tag. A GHL workflow triggered on that tag sends the email and
handles everything after it. Nothing here sends anything: the tag is the
handoff, and it is only ever applied by an explicit click in the review queue.
"""
import json
import os

import requests

BASE_URL = "https://services.leadconnectorhq.com"

# GHL's own docs give both "2021-07-28" (the long-standing v2 value, used by
# most integrations) and "v3" for these endpoints. Rather than bet on one, we
# try the configured value and fall back to the other on a version complaint.
DEFAULT_VERSION = "2021-07-28"
FALLBACK_VERSION = "v3"

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "gohighlevel.json"
)

# Applied to every contact we push, so everything Estly created stays findable
# in GHL and can be excluded from other campaigns.
TAG_LEAD = "estly-lead"
# The handoff. The GHL workflow triggers on this tag being added.
TAG_VIDEO_READY = "estly-video-ready"


def _beds_baths(lead):
    bits = []
    if lead.beds:
        bits.append(f"{lead.beds:g} bd")
    if lead.baths:
        bits.append(f"{lead.baths:g} ba")
    if lead.sqft:
        bits.append(f"{lead.sqft:,} sqft")
    return " / ".join(bits)


# Custom fields to create once in GHL (Settings -> Custom Fields), so the email
# template can merge them. Keys must match exactly; unknown keys are ignored by
# GHL rather than erroring, which is a quiet way to send a blank email, so
# verify_connection() reports which of these actually exist.
CUSTOM_FIELDS = {
    "estly_property_address": lambda lead: lead.address or "",
    "estly_listing_url": lambda lead: lead.listing_url or "",
    "estly_video_url": lambda lead: lead.video_url or "",
    "estly_price": lambda lead: f"${lead.price:,}" if lead.price else "",
    "estly_beds_baths": _beds_baths,
    "estly_brokerage": lambda lead: lead.brokerage or "",
}


class GoHighLevelNotConfigured(Exception):
    """No API key or location id available."""


class GoHighLevelError(Exception):
    """GHL rejected the request. The message carries their reason."""


def load_config():
    """Credentials from the gitignored config file, or the environment.

    The file matches how the rest of this app holds secrets (google_oauth.json
    and friends) and is gitignored for the same reason: the repo is public.
    """
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except (OSError, ValueError):
            cfg = {}
    return {
        "api_key": os.environ.get("GHL_API_KEY") or cfg.get("api_key") or "",
        "location_id": os.environ.get("GHL_LOCATION_ID") or cfg.get("location_id") or "",
        "version": os.environ.get("GHL_VERSION") or cfg.get("version") or DEFAULT_VERSION,
    }


def is_configured():
    cfg = load_config()
    return bool(cfg["api_key"] and cfg["location_id"])


def _headers(cfg, version=None):
    return {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Version": version or cfg["version"],
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _request(method, path, cfg, **kwargs):
    """One call, retrying once with the other Version value.

    A wrong Version header comes back as a 4xx about the version rather than
    anything obviously version-shaped, so we retry on any 400/401/422 instead
    of trying to pattern-match their wording.
    """
    url = BASE_URL + path
    other = FALLBACK_VERSION if cfg["version"] != FALLBACK_VERSION else DEFAULT_VERSION
    versions = [cfg["version"], other]

    last = None
    for version in versions:
        try:
            resp = requests.request(
                method, url, headers=_headers(cfg, version), timeout=20, **kwargs
            )
        except requests.RequestException as exc:
            raise GoHighLevelError(f"could not reach GoHighLevel: {exc}") from exc
        if resp.status_code < 400:
            return resp
        last = resp
        if resp.status_code not in (400, 401, 422):
            break
    return last


def _explain(resp):
    if resp is None:
        return "no response from GoHighLevel"
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}: {(resp.text or '')[:200]}"
    message = body.get("message") or body.get("error") or body
    if isinstance(message, list):
        message = "; ".join(str(m) for m in message)
    return f"HTTP {resp.status_code}: {message}"


def _existing_custom_field_keys(cfg):
    """Custom field keys defined on the location, so we can warn about gaps.

    GHL prefixes contact field keys with "contact." in some responses; both
    forms are kept so callers can match either.
    """
    resp = _request("GET", f"/locations/{cfg['location_id']}/customFields", cfg)
    if resp is None or resp.status_code >= 400:
        return set()
    try:
        fields = resp.json().get("customFields") or []
    except ValueError:
        return set()
    keys = set()
    for field in fields:
        key = (field.get("fieldKey") or field.get("key") or "").strip()
        if key:
            keys.add(key)
            keys.add(key.split(".", 1)[-1])
    return keys


def verify_connection():
    """Check the credentials work, and report which custom fields exist.

    Called by the outreach page so a misconfiguration shows up before anyone
    tries to mail an agent, rather than as a blank merge field in a sent email.
    """
    cfg = load_config()
    if not cfg["api_key"] or not cfg["location_id"]:
        raise GoHighLevelNotConfigured(
            "Add an API key and location id to studio/gohighlevel.json "
            "(or set GHL_API_KEY and GHL_LOCATION_ID)."
        )

    resp = _request(
        "GET", "/contacts/", cfg, params={"locationId": cfg["location_id"], "limit": 1}
    )
    if resp is None or resp.status_code >= 400:
        raise GoHighLevelError(_explain(resp))

    found = _existing_custom_field_keys(cfg)
    wanted = set(CUSTOM_FIELDS)
    return {
        "ok": True,
        "location_id": cfg["location_id"],
        "version_used": resp.request.headers.get("Version"),
        "custom_fields_present": sorted(wanted & found),
        "custom_fields_missing": sorted(wanted - found),
    }


def _split_name(full_name):
    parts = [p for p in (full_name or "").split() if p]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def build_payload(lead, cfg, extra_tags=()):
    first, last = _split_name(lead.agent_name)
    tags = [TAG_LEAD] + [t for t in extra_tags if t]

    payload = {
        "locationId": cfg["location_id"],
        "email": lead.agent_email,
        "firstName": first,
        "lastName": last,
        "name": lead.agent_name or lead.agent_email,
        "companyName": lead.brokerage or "",
        "source": "Estly Studio",
        "tags": tags,
        "customFields": [
            {"key": key, "fieldValue": fn(lead)} for key, fn in CUSTOM_FIELDS.items()
        ],
    }
    if lead.agent_phone:
        payload["phone"] = lead.agent_phone
    # The listing's address, not the agent's own -- but it is what makes the
    # contact recognisable in GHL's list view.
    if lead.address:
        payload["address1"] = lead.address
    for key, value in (("city", lead.city), ("state", lead.state), ("postalCode", lead.zip_code)):
        if value:
            payload[key] = value
    return {k: v for k, v in payload.items() if v not in ("", None)}


def push_contact(lead, extra_tags=(), dry_run=False):
    """Create or update this lead's agent as a GHL contact.

    Returns {contact_id, new, payload}. With dry_run the payload is built and
    returned but nothing leaves the machine -- that is how the review queue
    previews a send, and how this gets tested without mailing a real agent.
    """
    cfg = load_config()
    if not cfg["api_key"] or not cfg["location_id"]:
        raise GoHighLevelNotConfigured(
            "GoHighLevel isn't connected. Add an API key and location id to "
            "studio/gohighlevel.json (or set GHL_API_KEY and GHL_LOCATION_ID)."
        )
    if not lead.agent_email:
        raise GoHighLevelError("this lead has no agent email to send to")

    payload = build_payload(lead, cfg, extra_tags=extra_tags)

    # Upsert overwrites tags wholesale, which would drop anything added inside
    # GHL. Merge in what the contact already has before overwriting.
    if lead.ghl_contact_id and not dry_run:
        existing = _request("GET", f"/contacts/{lead.ghl_contact_id}", cfg)
        if existing is not None and existing.status_code < 400:
            try:
                current = (existing.json().get("contact") or {}).get("tags") or []
            except ValueError:
                current = []
            payload["tags"] = sorted({*payload.get("tags", []), *current})

    if dry_run:
        return {
            "contact_id": lead.ghl_contact_id,
            "new": None,
            "payload": payload,
            "dry_run": True,
        }

    resp = _request("POST", "/contacts/upsert", cfg, json=payload)
    if resp is None or resp.status_code >= 400:
        raise GoHighLevelError(_explain(resp))

    try:
        body = resp.json()
    except ValueError as exc:
        raise GoHighLevelError("GoHighLevel returned a response we could not read") from exc

    contact = body.get("contact") or {}
    return {
        "contact_id": contact.get("id"),
        "new": body.get("new"),
        "payload": payload,
        "dry_run": False,
    }
