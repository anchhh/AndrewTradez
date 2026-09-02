"""Upcoming calls, read from Calendly.

Read-only and deliberately so. This shows what is already booked; it never
creates, moves or cancels anything. Scheduling is Calendly's job and it is
the thing the invitee also has a stake in -- a bug here must not be able to
move somebody else's meeting.

Auth is a Calendly personal access token, held in the same gitignored config
file pattern as the other integrations because this repo is public.

    studio/calendly.json   {"token": "eyJ..."}

API notes that cost time to discover:
  * Every scheduled_events query REQUIRES a user or organization URI. There
    is no "my events" shortcut, so /users/me is called first for the URI.
  * The invitee's name is NOT on the event. It is a second call per event to
    /scheduled_events/{uuid}/invitees, which is why the number of events is
    kept small -- a dashboard panel is not worth twenty round trips.
  * status=active excludes cancelled meetings, which otherwise still come
    back and would show as upcoming calls that are not happening.
"""
import json
import os
from datetime import datetime, timedelta, timezone

import requests

BASE_URL = "https://api.calendly.com"
TIMEOUT = 12

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio", "calendly.json"
)


class CalendlyError(Exception):
    """Calendly could not be reached, or refused the request."""


def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                cfg = json.load(fh) or {}
        except (OSError, ValueError):
            cfg = {}
    return {"token": os.environ.get("CALENDLY_TOKEN") or cfg.get("token") or ""}


def is_configured():
    return bool(load_config()["token"])


def _get(path, token, **params):
    try:
        res = requests.get(
            path if path.startswith("http") else BASE_URL + path,
            headers={"Authorization": "Bearer " + token,
                     "Content-Type": "application/json"},
            params=params or None,
            timeout=TIMEOUT,
        )
    except requests.RequestException as exc:
        raise CalendlyError("Couldn't reach Calendly: %s" % exc) from exc

    if res.status_code == 401:
        raise CalendlyError("Calendly rejected the token. It may have expired.")
    if res.status_code == 403:
        raise CalendlyError("That token isn't allowed to read scheduled events.")
    if not res.ok:
        raise CalendlyError("Calendly returned %s." % res.status_code)
    try:
        return res.json()
    except ValueError as exc:
        raise CalendlyError("Calendly sent a response that wasn't JSON.") from exc


def me(token=None):
    """The signed-in user's resource, whose URI every event query needs."""
    token = token or load_config()["token"]
    if not token:
        raise CalendlyError("No Calendly token is configured.")
    return (_get("/users/me", token) or {}).get("resource") or {}


def verify_connection():
    """{ok, name, email} or {ok: False, error}. Used by the settings pip."""
    try:
        who = me()
    except CalendlyError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "name": who.get("name"), "email": who.get("email"),
            "scheduling_url": who.get("scheduling_url")}


def events_between(start, end, limit=100, with_invitees=True):
    """Active meetings whose start falls between two aware datetimes.

    Invitee lookups are one HTTP call per event and a month of bookings would
    make that a visibly slow page, so they run on a small thread pool. Six
    workers rather than one per event: Calendly rate-limits, and a burst of
    forty parallel requests is how an integration gets throttled.
    """
    from concurrent.futures import ThreadPoolExecutor

    cfg = load_config()
    if not cfg["token"]:
        raise CalendlyError("No Calendly token is configured.")

    uri = me(cfg["token"]).get("uri")
    if not uri:
        raise CalendlyError("Calendly didn't say who the token belongs to.")

    payload = _get(
        "/scheduled_events", cfg["token"],
        user=uri,
        status="active",
        min_start_time=_z(start),
        max_start_time=_z(end),
        sort="start_time:asc",
        count=max(1, min(int(limit), 100)),
    )

    events = [_event(raw) for raw in (payload.get("collection") or [])]

    if with_invitees and events:
        def fill(event):
            # Best effort per event: a missing name is worth far less than a
            # calendar that fails because one lookup did.
            try:
                event["invitee"] = _first_invitee(event["uri"], cfg["token"])
            except CalendlyError:
                pass

        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(fill, events))

    return events


def _z(when):
    """Calendly wants RFC3339 with a Z, not +00:00."""
    return when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _event(raw):
    return {
        "name": raw.get("name") or "Meeting",
        "start": raw.get("start_time"),
        "end": raw.get("end_time"),
        "status": raw.get("status"),
        "uri": raw.get("uri") or "",
        "location": _location_of(raw),
        "invitee": None,
    }


def upcoming(limit=5, days=30, with_invitees=True):
    """The next `limit` active meetings inside the next `days` days.

    Bounded at both ends on purpose: a panel showing "upcoming calls" means
    the next few, and an unbounded query on a busy calendar is a slow page
    and a large response for something nobody scrolls.
    """
    now = datetime.now(timezone.utc)
    return events_between(now, now + timedelta(days=days),
                          limit=limit, with_invitees=with_invitees)


def event_types(active_only=True):
    """The bookable links on this account.

    Each is a separate meeting type with its own URL -- a 30-minute intro and
    a 15-minute follow-up are two links, not one -- so the page offers them
    all rather than guessing which to share. Read from the API instead of
    being hard-coded, so renaming or adding one in Calendly shows up here.
    """
    cfg = load_config()
    if not cfg["token"]:
        raise CalendlyError("No Calendly token is configured.")

    uri = me(cfg["token"]).get("uri")
    if not uri:
        raise CalendlyError("Calendly didn't say who the token belongs to.")

    payload = _get("/event_types", cfg["token"], user=uri, count=50)
    out = []
    for raw in payload.get("collection") or []:
        if active_only and not raw.get("active"):
            continue
        # A "secret" event type is deliberately unlisted; sharing it from a
        # list of links is not what the person who hid it meant.
        if raw.get("secret"):
            continue
        out.append({
            "name": raw.get("name") or "Meeting",
            "url": raw.get("scheduling_url"),
            "duration": raw.get("duration"),
            "kind": raw.get("kind"),
            "description": (raw.get("description_plain") or "").strip() or None,
        })
    return [e for e in out if e["url"]]


def _location_of(raw):
    """A human phrase for where the call happens, across Calendly's shapes."""
    loc = raw.get("location") or {}
    kind = loc.get("type") or ""
    if kind in ("zoom", "google_conference", "microsoft_teams_conference",
                "gotomeeting", "webex"):
        return loc.get("join_url") or kind.replace("_", " ").title()
    if kind in ("physical", "custom", "outbound_call", "inbound_call"):
        return loc.get("location") or kind.replace("_", " ").title()
    return loc.get("location") or None


def _first_invitee(event_uri, token):
    if not event_uri:
        return None
    data = _get(event_uri.rstrip("/") + "/invitees", token, count=1)
    people = data.get("collection") or []
    if not people:
        return None
    person = people[0]
    return {"name": person.get("name"), "email": person.get("email")}
