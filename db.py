"""
SQLite persistence for the Inworld TTS POC (via aiosqlite).

Everything is owned by a user — the admin from .env, or an account the admin
created — and nothing is shared between them: your history, your cloned voices,
your likes, your usage. The owner is always the signed-in user, taken from the
session cookie server-side, never from anything the browser sends.

Tables:
  - users:         accounts the admin creates. Passwords are stored as salted
                   PBKDF2 hashes, never in the clear. The admin account itself
                   lives in .env and has no row here.
  - renders:       every generated clip (text, voice, model, billed chars).
                   Audio is saved to disk (data/audio/<id>.mp3); the row keeps
                   its path.
  - custom_voices: voices cloned through Inworld, listed in the owner's picker
                   alongside the catalog immediately (Inworld's own catalog is
                   cached in-process and won't show a new clone until the next
                   cache refresh/restart).
  - usage_events:  one row per billable call (TTS render or OpenAI enhance) with
                   characters and estimated cost — the single source of truth
                   for the Usage view, so totals survive reloads and restarts
                   and aren't lost when a render is deleted from history.
  - likes:         favourited voices and renders.
  - app_state:     small key/value store (currently the login-cookie signing
                   secret, so logins survive a restart).
"""

import hashlib
import secrets
import time
import uuid
from pathlib import Path

import aiosqlite

DATA_DIR = Path(__file__).parent / "data"
AUDIO_DIR = DATA_DIR / "audio"
DB_PATH = DATA_DIR / "app.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    last_login_at REAL
);

CREATE TABLE IF NOT EXISTS renders (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    text          TEXT NOT NULL,
    voice_id      TEXT NOT NULL,
    voice_name    TEXT,
    model_id      TEXT,
    description   TEXT,
    chars_billed  INTEGER,
    audio_path    TEXT NOT NULL,
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_renders_session ON renders(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS custom_voices (
    voice_id      TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    language_code TEXT,
    session_id    TEXT,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
    id            TEXT PRIMARY KEY,
    session_id    TEXT,
    kind          TEXT NOT NULL,          -- 'tts' | 'enhance'
    model_id      TEXT,
    chars         INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    render_id     TEXT,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS likes (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    item_type     TEXT NOT NULL,
    item_id       TEXT NOT NULL,
    created_at    REAL NOT NULL,
    UNIQUE(session_id, item_type, item_id)
);
"""

# Ownership moved from a browser-generated session id to the signed-in user, so
# every owned table gained a user_id. Rows written before accounts existed keep
# a NULL user_id and simply belong to nobody.
_OWNED_TABLES = ("renders", "custom_voices", "usage_events", "likes")

_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_renders_user ON renders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id, item_type);
CREATE INDEX IF NOT EXISTS idx_voices_user ON custom_voices(user_id);
"""


async def init() -> None:
    """Create data dirs, tables, and any missing columns. Call once on startup."""
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_SCHEMA)
        for table in _OWNED_TABLES:
            cur = await db.execute(f"PRAGMA table_info({table})")
            columns = {row[1] for row in await cur.fetchall()}
            if "user_id" not in columns:
                await db.execute(f"ALTER TABLE {table} ADD COLUMN user_id TEXT")
        await db.executescript(_INDEXES)
        await db.commit()


# ---- accounts ----------------------------------------------------------------

_PBKDF2_ROUNDS = 200_000


def hash_password(password: str) -> str:
    """salt$hash — PBKDF2-HMAC-SHA256, so a leaked DB doesn't leak passwords."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), _PBKDF2_ROUNDS
    )
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, expected = stored.split("$", 1)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), _PBKDF2_ROUNDS
        )
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(digest.hex(), expected)


def _user_row(r) -> dict:
    return {
        "id": r["id"],
        "username": r["username"],
        "displayName": r["display_name"],
        "disabled": bool(r["disabled"]),
        "createdAt": r["created_at"],
        "lastLoginAt": r["last_login_at"],
    }


async def create_user(*, username: str, password: str, display_name=None) -> dict:
    """Add an account. Raises ValueError if the username is taken."""
    user_id = uuid.uuid4().hex
    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute(
                """INSERT INTO users
                   (id, username, password_hash, display_name, disabled, created_at)
                   VALUES (?,?,?,?,0,?)""",
                (user_id, username, hash_password(password), display_name, time.time()),
            )
        except aiosqlite.IntegrityError:
            raise ValueError(f'The username "{username}" is already taken.')
        await db.commit()
    return await get_user(user_id)


async def get_user(user_id: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cur.fetchone()
    return _user_row(row) if row else None


async def find_user(username: str) -> dict | None:
    """The account plus its password hash — for the login check only."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
        )
        row = await cur.fetchone()
    if not row:
        return None
    return {**_user_row(row), "passwordHash": row["password_hash"]}


async def list_users() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM users ORDER BY created_at DESC")
        rows = await cur.fetchall()
    return [_user_row(r) for r in rows]


async def set_password(user_id: str, password: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(password), user_id),
        )
        await db.commit()
        return cur.rowcount > 0


async def set_disabled(user_id: str, disabled: bool) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE users SET disabled = ? WHERE id = ?", (1 if disabled else 0, user_id)
        )
        await db.commit()
        return cur.rowcount > 0


async def touch_login(user_id: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?", (time.time(), user_id)
        )
        await db.commit()


async def delete_user(user_id: str) -> bool:
    """Remove the account and everything it owns, audio files included."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT audio_path FROM renders WHERE user_id = ?", (user_id,)
        )
        paths = [r[0] for r in await cur.fetchall()]

        cur = await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
        deleted = cur.rowcount > 0
        if deleted:
            for table in _OWNED_TABLES:
                await db.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        await db.commit()

    if deleted:
        for path in paths:
            Path(path).unlink(missing_ok=True)
    return deleted


# ---- renders / history -------------------------------------------------------

async def add_render(
    *, user_id, text, audio_bytes, voice_id, voice_name,
    model_id, description, chars_billed, ext="mp3",
) -> dict:
    """Persist one render (audio to disk, metadata to DB). Returns the row."""
    render_id = uuid.uuid4().hex
    created_at = time.time()
    audio_path = AUDIO_DIR / f"{render_id}.{ext}"
    audio_path.write_bytes(audio_bytes)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO renders
               (id, session_id, user_id, text, voice_id, voice_name, model_id,
                description, chars_billed, audio_path, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (render_id, user_id, user_id, text, voice_id, voice_name, model_id,
             description, chars_billed, str(audio_path), created_at),
        )
        await db.commit()

    return {
        "renderId": render_id,
        "text": text,
        "voiceId": voice_id,
        "voiceName": voice_name,
        "modelId": model_id,
        "description": description,
        "charsBilled": chars_billed,
        "audioUrl": f"/api/audio/{render_id}",
        "createdAt": created_at,
    }


async def list_renders(user_id: str, limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT id, text, voice_id, voice_name, model_id, description,
                      chars_billed, created_at
               FROM renders WHERE user_id = ?
               ORDER BY created_at DESC LIMIT ?""",
            (user_id, limit),
        )
        rows = await cur.fetchall()
    return [
        {
            "renderId": r["id"],
            "text": r["text"],
            "voiceId": r["voice_id"],
            "voiceName": r["voice_name"],
            "modelId": r["model_id"],
            "description": r["description"],
            "charsBilled": r["chars_billed"],
            "audioUrl": f"/api/audio/{r['id']}",
            "createdAt": r["created_at"],
        }
        for r in rows
    ]


async def get_audio_path(render_id: str, user_id: str) -> str | None:
    """The stored file, but only if this user owns the render."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT audio_path FROM renders WHERE id = ? AND user_id = ?",
            (render_id, user_id),
        )
        row = await cur.fetchone()
    return row[0] if row else None


async def delete_render(render_id: str, user_id: str) -> bool:
    path = await get_audio_path(render_id, user_id)
    if not path:
        return False
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM renders WHERE id = ? AND user_id = ?", (render_id, user_id)
        )
        await db.commit()
    Path(path).unlink(missing_ok=True)
    return True


# ---- custom (cloned) voices --------------------------------------------------

async def add_custom_voice(*, voice_id, display_name, language_code, user_id) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO custom_voices
               (voice_id, display_name, language_code, session_id, user_id, created_at)
               VALUES (?,?,?,?,?,?)""",
            (voice_id, display_name, language_code, user_id, user_id, time.time()),
        )
        await db.commit()


async def list_custom_voices(user_id: str) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT voice_id, display_name, language_code FROM custom_voices "
            "WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )
        rows = await cur.fetchall()
    return [
        {
            "voiceId": r["voice_id"],
            "displayName": r["display_name"],
            "languages": [r["language_code"]] if r["language_code"] else [],
            "description": None,
            "tags": [],
            "isCustom": True,
        }
        for r in rows
    ]


async def delete_custom_voice(voice_id: str, user_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM custom_voices WHERE voice_id = ? AND user_id = ?",
            (voice_id, user_id),
        )
        await db.commit()
        return cur.rowcount > 0


# ---- usage / costs -----------------------------------------------------------

async def log_usage(
    *, user_id, kind, model_id=None, chars=0, cost_usd=0.0, render_id=None
) -> None:
    """Record one billable call so the Usage view survives reloads/restarts."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO usage_events
               (id, session_id, user_id, kind, model_id, chars, cost_usd,
                render_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (uuid.uuid4().hex, user_id, user_id, kind, model_id, chars or 0,
             cost_usd or 0.0, render_id, time.time()),
        )
        await db.commit()


_TOTALS_SQL = """
SELECT
    COALESCE(SUM(kind = 'tts'), 0)                           AS generations,
    COALESCE(SUM(CASE WHEN kind = 'tts' THEN chars END), 0)  AS chars,
    COALESCE(SUM(cost_usd), 0.0)                             AS cost_usd,
    COALESCE(SUM(kind = 'enhance'), 0)                       AS enhances
FROM usage_events
"""


def _totals(row) -> dict:
    return {
        "generations": row["generations"],
        "chars": row["chars"],
        "costUsd": round(row["cost_usd"], 6),
        "enhances": row["enhances"],
    }


async def usage_summary(user_id: str) -> dict:
    """One user's totals, plus everyone's — the latter is admin-only in the API."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        cur = await db.execute(_TOTALS_SQL + " WHERE user_id = ?", (user_id,))
        mine = await cur.fetchone()

        cur = await db.execute(_TOTALS_SQL)
        everyone = await cur.fetchone()

        cur = await db.execute(
            """SELECT model_id,
                      COUNT(*) AS generations,
                      COALESCE(SUM(chars), 0) AS chars,
                      COALESCE(SUM(cost_usd), 0.0) AS cost_usd
               FROM usage_events WHERE kind = 'tts' AND model_id IS NOT NULL
                 AND user_id = ?
               GROUP BY model_id ORDER BY cost_usd DESC""",
            (user_id,),
        )
        by_model = await cur.fetchall()

    return {
        "you": _totals(mine),
        "allUsers": _totals(everyone),
        "byModel": [
            {
                "modelId": r["model_id"],
                "generations": r["generations"],
                "chars": r["chars"],
                "costUsd": round(r["cost_usd"], 6),
            }
            for r in by_model
        ],
    }


async def usage_by_user() -> list[dict]:
    """Per-account totals for the admin's Users table, busiest spender first."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT user_id,
                      COALESCE(SUM(kind = 'tts'), 0)                          AS generations,
                      COALESCE(SUM(CASE WHEN kind = 'tts' THEN chars END), 0) AS chars,
                      COALESCE(SUM(cost_usd), 0.0)                            AS cost_usd,
                      COALESCE(SUM(kind = 'enhance'), 0)                      AS enhances,
                      MAX(created_at)                                         AS last_used_at
               FROM usage_events WHERE user_id IS NOT NULL
               GROUP BY user_id ORDER BY cost_usd DESC"""
        )
        rows = await cur.fetchall()
    return [{**_totals(r), "userId": r["user_id"], "lastUsedAt": r["last_used_at"]} for r in rows]


async def count_enhance_calls(user_id: str) -> int:
    """Enhance calls for one user, read off the same ledger as the totals."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT COUNT(*) FROM usage_events WHERE kind = 'enhance' AND user_id = ?",
            (user_id,),
        )
        row = await cur.fetchone()
    return row[0] if row else 0


# ---- app state (key/value) ---------------------------------------------------

async def get_state(key: str) -> str | None:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT value FROM app_state WHERE key = ?", (key,))
        row = await cur.fetchone()
    return row[0] if row else None


async def set_state(key: str, value: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", (key, value)
        )
        await db.commit()


# ---- likes / favourites ---------------------------------------------------

async def toggle_like(user_id: str, item_type: str, item_id: str) -> bool:
    """Insert if not liked, delete if already liked. Returns new liked state."""
    async with aiosqlite.connect(DB_PATH) as conn:
        cur = await conn.execute(
            "SELECT id FROM likes WHERE user_id = ? AND item_type = ? AND item_id = ?",
            (user_id, item_type, item_id),
        )
        row = await cur.fetchone()
        if row:
            await conn.execute("DELETE FROM likes WHERE id = ?", (row[0],))
            await conn.commit()
            return False
        await conn.execute(
            """INSERT INTO likes (id, session_id, user_id, item_type, item_id, created_at)
               VALUES (?,?,?,?,?,?)""",
            (uuid.uuid4().hex, user_id, user_id, item_type, item_id, time.time()),
        )
        await conn.commit()
        return True


async def list_likes(user_id: str, item_type: str) -> list[str]:
    """Liked item_ids for this user and type."""
    async with aiosqlite.connect(DB_PATH) as conn:
        cur = await conn.execute(
            "SELECT item_id FROM likes WHERE user_id = ? AND item_type = ? "
            "ORDER BY created_at DESC",
            (user_id, item_type),
        )
        rows = await cur.fetchall()
    return [r[0] for r in rows]
