"""
Login and roles.

There are two kinds of account:
  - the admin, whose credentials live in .env (ADMIN_USERNAME / ADMIN_PASSWORD).
    There's exactly one, it can never be deleted from the UI, and it's the only
    role that sees money and manages accounts.
  - users, which the admin creates in the app. They live in the `users` table
    with salted PBKDF2 password hashes, own their own history/voices/likes/usage,
    and see their own volume numbers but never costs.

A successful login gets a signed, expiring cookie carrying the username, role,
and owner id — no server-side session table, so logins survive a restart as long
as the signing secret does. The secret comes from SESSION_SECRET if set,
otherwise one is generated once and kept in the app_state table.

If ADMIN_USERNAME/ADMIN_PASSWORD are unset, auth is disabled: the app is open and
everyone is treated as the admin. The startup log says so loudly.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

import db

COOKIE_NAME = "av_session"
SESSION_TTL = 7 * 24 * 3600  # a week; long enough that a POC isn't annoying

ADMIN = "admin"
USER = "user"

# The admin's owner id. Real users get a uuid from the users table; the admin
# has no row, so it owns its data under this fixed id.
ADMIN_ID = "admin"

ADMIN_USERNAME = os.getenv("ADMIN_USERNAME") or os.getenv("APP_USERNAME", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or os.getenv("APP_PASSWORD", "")

# Keeps usernames unambiguous in the admin table and in the login form.
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")

_secret: bytes = b""


def enabled() -> bool:
    return bool(ADMIN_USERNAME and ADMIN_PASSWORD)


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


def is_admin_credentials(username: str, password: str) -> bool:
    """Constant-time comparison against the .env admin pair."""
    return (
        enabled()
        and hmac.compare_digest(username, ADMIN_USERNAME)
        and hmac.compare_digest(password, ADMIN_PASSWORD)
    )


async def authenticate(username: str, password: str) -> dict | None:
    """The session this login earns, or None. Admin first, then the users table."""
    if is_admin_credentials(username, password):
        return {"username": ADMIN_USERNAME, "role": ADMIN, "ownerId": ADMIN_ID}

    user = await db.find_user(username)
    if not user or user["disabled"]:
        # Still spend the hashing time on a miss so a bad username and a bad
        # password take about as long as each other.
        db.verify_password(password, db.hash_password("no-such-user"))
        return None
    if not db.verify_password(password, user["passwordHash"]):
        return None
    await db.touch_login(user["id"])
    return {"username": user["username"], "role": USER, "ownerId": user["id"]}


def _sign(payload: str) -> str:
    digest = hmac.new(_secret, payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def make_token(session: dict) -> str:
    payload = json.dumps(
        {
            "u": session["username"],
            "r": session["role"],
            "o": session["ownerId"],
            "e": int(time.time()) + SESSION_TTL,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return f"{encoded}.{_sign(payload)}"


def read_token(token: str | None) -> dict | None:
    """The signed session, if the cookie is intact and unexpired. No DB access."""
    if not token or "." not in token:
        return None
    encoded, sig = token.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
    except (ValueError, UnicodeDecodeError):
        return None
    # Verify before parsing, so only text we signed is ever handed to the parser.
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    try:
        claims = json.loads(payload)
        username, role, owner_id, expires = (
            claims["u"], claims["r"], claims["o"], int(claims["e"])
        )
    except (ValueError, TypeError, KeyError):
        return None
    if expires <= time.time():
        return None
    if role == ADMIN and username != ADMIN_USERNAME:
        # The admin was renamed in .env — old cookies stop working.
        return None
    if role not in (ADMIN, USER):
        return None
    return {"username": username, "role": role, "ownerId": owner_id}


async def session_for(token: str | None) -> dict | None:
    """The live session behind a cookie, re-checked against the account itself.

    A deleted or disabled account is refused here, so revoking access takes
    effect on the next request rather than whenever the cookie expires.
    """
    if not enabled():
        # No admin configured: the app is open, and everyone is the admin.
        return {"username": ADMIN_USERNAME or ADMIN, "role": ADMIN, "ownerId": ADMIN_ID}

    session = read_token(token)
    if not session:
        return None
    if session["role"] == ADMIN:
        return session

    user = await db.get_user(session["ownerId"])
    if not user or user["disabled"] or user["username"] != session["username"]:
        return None
    return session


def is_admin(session: dict | None) -> bool:
    return bool(session and session["role"] == ADMIN)
