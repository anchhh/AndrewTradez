"""
The handover between Studio and the extension's Flow tab.

Studio is a web page and Flow is somebody else's web app; a page cannot
reach into another origin, which is why the app can only ever open Flow and
hand you files. The extension can, because a browser extension is the one
thing on the machine allowed to touch both.

So the app writes down what it wants generated, and the extension reads it.
A brief rather than a queue: there is one thing being worked on at a time,
and a list of stale intentions is worse than none. Writing a new one
replaces the old.

Kept in a file rather than in memory because the app restarts on every save
during development, and a brief that evaporates when a template changes is a
brief nobody trusts.
"""
import json
import os
import time

PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "studio",
    "flow_brief.json")

# How long a brief is worth acting on. Long enough to walk to Flow and sign
# in; short enough that yesterday's intention does not load itself into
# today's project.
TTL_SECONDS = 60 * 60


def _read():
    if not os.path.exists(PATH):
        return {}
    try:
        with open(PATH, encoding="utf-8") as fh:
            return json.load(fh) or {}
    except (ValueError, OSError):
        return {}


def save(owner_id, brief):
    """Record what this account wants generated next."""
    everyone = _read()
    everyone[str(owner_id)] = dict(brief, at=time.time())
    try:
        with open(PATH, "w", encoding="utf-8") as fh:
            json.dump(everyone, fh, indent=2)
    except OSError:
        return None
    return everyone[str(owner_id)]


def load(owner_id):
    """The brief this account last asked for, if it is still fresh."""
    brief = _read().get(str(owner_id))
    if not brief:
        return None
    if time.time() - float(brief.get("at") or 0) > TTL_SECONDS:
        return None
    return brief


def clear(owner_id):
    everyone = _read()
    if everyone.pop(str(owner_id), None) is None:
        return
    try:
        with open(PATH, "w", encoding="utf-8") as fh:
            json.dump(everyone, fh, indent=2)
    except OSError:
        pass
