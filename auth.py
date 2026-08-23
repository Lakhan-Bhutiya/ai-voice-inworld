"""
Single-user login for the POC UI.

The username/password live in .env (APP_USERNAME / APP_PASSWORD) and are only
ever compared server-side. A successful login gets a signed, expiring cookie —
no server-side session table, so logins survive a restart as long as the signing
secret does. The secret comes from SESSION_SECRET if set, otherwise one is
generated once and kept in the app_state table.

If APP_USERNAME/APP_PASSWORD are unset, auth is disabled and the app is open —
the startup log says so loudly.
"""

import base64
import hashlib
import hmac
import os
import secrets
import time

import db

COOKIE_NAME = "av_session"
SESSION_TTL = 7 * 24 * 3600  # a week; long enough that a POC isn't annoying

APP_USERNAME = os.getenv("APP_USERNAME", "")
APP_PASSWORD = os.getenv("APP_PASSWORD", "")

_secret: bytes = b""


def enabled() -> bool:
    return bool(APP_USERNAME and APP_PASSWORD)


async def init() -> None:
    """Resolve the cookie-signing secret. Call once on startup, after db.init()."""
    global _secret
    from_env = os.getenv("SESSION_SECRET", "")
    if from_env:
        _secret = from_env.encode()
        return
    stored = await db.get_state("session_secret")
    if not stored:
        stored = secrets.token_urlsafe(32)
        await db.set_state("session_secret", stored)
    _secret = stored.encode()


def check_credentials(username: str, password: str) -> bool:
    """Constant-time credential comparison against the .env values."""
    return (
        enabled()
        and hmac.compare_digest(username, APP_USERNAME)
        and hmac.compare_digest(password, APP_PASSWORD)
    )


def _sign(payload: str) -> str:
    digest = hmac.new(_secret, payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def make_token(username: str) -> str:
    payload = f"{username}:{int(time.time()) + SESSION_TTL}"
    return f"{base64.urlsafe_b64encode(payload.encode()).decode().rstrip('=')}.{_sign(payload)}"


def valid_token(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    encoded, sig = token.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
        username, expires = payload.rsplit(":", 1)
    except (ValueError, UnicodeDecodeError):
        return False
    if not hmac.compare_digest(sig, _sign(payload)):
        return False
    return username == APP_USERNAME and int(expires) > time.time()
