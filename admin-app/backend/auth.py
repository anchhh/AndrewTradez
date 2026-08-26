"""
HTTP Basic Auth gate for deployed environments.

Opt-in only: if BASIC_AUTH_USER/BASIC_AUTH_PASS aren't set (the local dev
default), nothing is gated and the dashboard skips the login screen
entirely. Set both env vars in production (e.g. on Render) to require a
login before any lead data is reachable.

Only /api/* routes are gated -- the built frontend bundle (HTML/JS/CSS)
is not sensitive on its own and is left reachable so the dashboard can
load and show its own login screen (see frontend/src/auth.ts) instead of
the browser's native Basic Auth popup. Every /api/* call the dashboard
makes still requires real credentials either way.
"""
import base64
import os

from flask import Response, jsonify, request

BASIC_AUTH_USER = os.environ.get("BASIC_AUTH_USER")
BASIC_AUTH_PASS = os.environ.get("BASIC_AUTH_PASS")
AUTH_ENABLED = bool(BASIC_AUTH_USER and BASIC_AUTH_PASS)

# Reachable without credentials even when auth is enabled, so the
# dashboard can ask "do I need to show a login screen?" and verify a
# typed-in password against /api/health -- nothing sensitive either way.
_EXEMPT_API_PATHS = {"/api/auth/status"}

# The Chrome extension authenticates with a per-account key (X-Estly-Key)
# rather than the single shared Basic Auth password: the key says *which*
# user captured a lead, is revocable one account at a time, and means the
# extension never has to hold a password that opens the whole admin API.
#
# Only the endpoints it actually uses accept it. Notably GET /api/leads is
# not among them -- that returns every lead regardless of owner, so it stays
# behind Basic Auth rather than being readable by any key holder.
_API_KEY_ROUTES = {
    ("POST", "/api/leads"),
    ("POST", "/api/leads/import/csv"),
    ("GET", "/api/health"),
}


def _has_valid_api_key():
    try:
        from studio import user_id_for_api_key
    except ImportError:
        return False
    return bool(user_id_for_api_key(request.headers.get("X-Estly-Key")))


def _check_credentials(header):
    if not header or not header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8")
        user, _, password = decoded.partition(":")
    except Exception:
        return False
    return user == BASIC_AUTH_USER and password == BASIC_AUTH_PASS


def register_basic_auth(app):
    @app.get("/api/auth/status")
    def auth_status():
        return jsonify({"auth_required": AUTH_ENABLED})

    if not AUTH_ENABLED:
        return  # not configured (local dev) -- nothing else to gate

    @app.before_request
    def _require_auth():
        if request.method == "OPTIONS":
            return  # let CORS preflight through unauthenticated
        if request.path in _EXEMPT_API_PATHS:
            return
        if not request.path.startswith("/api/"):
            return  # static frontend bundle -- see module docstring
        if (request.method, request.path) in _API_KEY_ROUTES and _has_valid_api_key():
            return  # authenticated as a specific account by its extension key
        if not _check_credentials(request.headers.get("Authorization")):
            return Response(
                "Authentication required",
                401,
                {"WWW-Authenticate": 'Basic realm="Estly Admin"'},
            )
