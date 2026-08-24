"""
HTTP Basic Auth gate for deployed environments.

Opt-in only: if BASIC_AUTH_USER/BASIC_AUTH_PASS aren't set (the local dev
default), this does nothing and every route behaves exactly as before.
Set both env vars in production (e.g. on Render) to require a login
before anything -- API or the served dashboard -- responds. This is
what keeps a publicly-reachable deployment from actually being public:
the URL is reachable, but nothing behind it is without the password.
"""
import base64
import os

from flask import Response, request

BASIC_AUTH_USER = os.environ.get("BASIC_AUTH_USER")
BASIC_AUTH_PASS = os.environ.get("BASIC_AUTH_PASS")


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
    if not BASIC_AUTH_USER or not BASIC_AUTH_PASS:
        return  # not configured (local dev) -- auth disabled entirely

    @app.before_request
    def _require_auth():
        if request.method == "OPTIONS":
            return  # let CORS preflight through unauthenticated
        if not _check_credentials(request.headers.get("Authorization")):
            return Response(
                "Authentication required",
                401,
                {"WWW-Authenticate": 'Basic realm="Estly Admin"'},
            )
