"""
Login for the POC UI, with two roles.

Credentials live in .env and are only ever compared server-side:
  - ADMIN_USERNAME / ADMIN_PASSWORD  -> role "admin": sees everything, money
                                        figures included.
  - USER_USERNAME  / USER_PASSWORD   -> role "user":  sees usage (generations,
                                        characters, enhance calls) but never
                                        costs or rates.
(APP_USERNAME / APP_PASSWORD still work as an alias for the admin pair.)

A successful login gets a signed, expiring cookie carrying the username and the
role — no server-side session table, so logins survive a restart as long as the
signing secret does. The secret comes from SESSION_SECRET if set, otherwise one
is generated once and kept in the app_state table.

If no accounts are configured at all, auth is disabled, the app is open, and
everyone is treated as an admin — the startup log says so loudly.
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

ADMIN = "admin"
USER = "user"

# role -> (username, password), skipping any pair that isn't fully configured.
ACCOUNTS = {
    role: (username, password)
    for role, username, password in (
        (
            ADMIN,
            os.getenv("ADMIN_USERNAME") or os.getenv("APP_USERNAME", ""),
            os.getenv("ADMIN_PASSWORD") or os.getenv("APP_PASSWORD", ""),
        ),
        (USER, os.getenv("USER_USERNAME", ""), os.getenv("USER_PASSWORD", "")),
    )
    if username and password
}

_secret: bytes = b""


def enabled() -> bool:
    return bool(ACCOUNTS)


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


def authenticate(username: str, password: str) -> str | None:
    """The role these credentials grant, or None. Comparison is constant-time."""
    matched = None
    for role, (expected_user, expected_pass) in ACCOUNTS.items():
        # No early exit: every account is checked so timing can't reveal which
        # username exists.
        if hmac.compare_digest(username, expected_user) and hmac.compare_digest(
            password, expected_pass
        ):
            matched = role
    return matched


def _sign(payload: str) -> str:
    digest = hmac.new(_secret, payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def make_token(username: str, role: str) -> str:
    payload = f"{username}:{role}:{int(time.time()) + SESSION_TTL}"
    return f"{base64.urlsafe_b64encode(payload.encode()).decode().rstrip('=')}.{_sign(payload)}"


def read_token(token: str | None) -> tuple[str, str] | None:
    """(username, role) for a valid, unexpired cookie, else None."""
    if not token or "." not in token:
        return None
    encoded, sig = token.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
        username, role, expires = payload.rsplit(":", 2)
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    if int(expires) <= time.time():
        return None
    # The account must still exist with that username — so revoking or renaming
    # an account in .env invalidates its outstanding cookies.
    account = ACCOUNTS.get(role)
    if not account or account[0] != username:
        return None
    return username, role


def valid_token(token: str | None) -> bool:
    return read_token(token) is not None


def role_for(token: str | None) -> str:
    """The signed-in role. With auth disabled everyone is an admin."""
    if not enabled():
        return ADMIN
    session = read_token(token)
    return session[1] if session else ""


def is_admin(token: str | None) -> bool:
    return role_for(token) == ADMIN
