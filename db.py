"""
SQLite persistence for the Inworld TTS POC (via aiosqlite).

Stores everything that should survive reloads and restarts:
  - renders:       every generated clip (text, voice, model, billed chars) keyed
                   by a client-provided sessionId. Audio is saved as a file on
                   disk (data/audio/<id>.mp3); the row keeps its path.
  - custom_voices: voices cloned through Inworld, so they can be listed in the
                   picker alongside the catalog.
  - usage_events:  one row per billable call (TTS render or OpenAI enhance) with
                   characters and estimated cost, so the Costs view shows real
                   running totals instead of an in-memory counter.
  - app_state:     small key/value store (currently the login-cookie signing
                   secret, so logins survive a restart).
"""

import time
import uuid
from pathlib import Path

import aiosqlite

DATA_DIR = Path(__file__).parent / "data"
AUDIO_DIR = DATA_DIR / "audio"
DB_PATH = DATA_DIR / "app.db"

_SCHEMA = """
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
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


async def init() -> None:
    """Create data dirs and tables. Call once on startup."""
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_SCHEMA)
        await db.commit()


# ---- renders / history -------------------------------------------------------

async def add_render(
    *, session_id, text, audio_bytes, voice_id, voice_name,
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
               (id, session_id, text, voice_id, voice_name, model_id,
                description, chars_billed, audio_path, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (render_id, session_id, text, voice_id, voice_name, model_id,
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


async def list_renders(session_id: str, limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT id, text, voice_id, voice_name, model_id, description,
                      chars_billed, created_at
               FROM renders WHERE session_id = ?
               ORDER BY created_at DESC LIMIT ?""",
            (session_id, limit),
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


async def get_audio_path(render_id: str) -> str | None:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT audio_path FROM renders WHERE id = ?", (render_id,)
        )
        row = await cur.fetchone()
    return row[0] if row else None


async def delete_render(render_id: str) -> bool:
    path = await get_audio_path(render_id)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("DELETE FROM renders WHERE id = ?", (render_id,))
        await db.commit()
        deleted = cur.rowcount > 0
    if deleted and path:
        Path(path).unlink(missing_ok=True)
    return deleted


# ---- custom (cloned) voices --------------------------------------------------

async def add_custom_voice(*, voice_id, display_name, language_code, session_id) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO custom_voices
               (voice_id, display_name, language_code, session_id, created_at)
               VALUES (?,?,?,?,?)""",
            (voice_id, display_name, language_code, session_id, time.time()),
        )
        await db.commit()


async def list_custom_voices() -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT voice_id, display_name, language_code FROM custom_voices "
            "ORDER BY created_at DESC"
        )
        rows = await cur.fetchall()
    return [
        {
            "voiceId": r["voice_id"],
            "displayName": r["display_name"],
            "languages": [r["language_code"]] if r["language_code"] else [],
            "custom": True,
        }
        for r in rows
    ]


async def delete_custom_voice(voice_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM custom_voices WHERE voice_id = ?", (voice_id,)
        )
        await db.commit()
        return cur.rowcount > 0


# ---- usage / costs -----------------------------------------------------------

async def log_usage(
    *, session_id, kind, model_id=None, chars=0, cost_usd=0.0, render_id=None
) -> None:
    """Record one billable call so the Costs view survives reloads/restarts."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO usage_events
               (id, session_id, kind, model_id, chars, cost_usd, render_id, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (uuid.uuid4().hex, session_id, kind, model_id, chars or 0,
             cost_usd or 0.0, render_id, time.time()),
        )
        await db.commit()


_TOTALS_SQL = """
SELECT
    COALESCE(SUM(kind = 'tts'), 0)                       AS generations,
    COALESCE(SUM(CASE WHEN kind = 'tts' THEN chars END), 0)  AS chars,
    COALESCE(SUM(cost_usd), 0.0)                         AS cost_usd,
    COALESCE(SUM(kind = 'enhance'), 0)                   AS enhances
FROM usage_events
"""


async def usage_summary(session_id: str | None = None) -> dict:
    """Totals for one session plus all-time totals across every session."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        cur = await db.execute(_TOTALS_SQL + " WHERE session_id = ?", (session_id,))
        session_row = await cur.fetchone()

        cur = await db.execute(_TOTALS_SQL)
        all_row = await cur.fetchone()

        cur = await db.execute(
            """SELECT model_id,
                      COUNT(*) AS generations,
                      COALESCE(SUM(chars), 0) AS chars,
                      COALESCE(SUM(cost_usd), 0.0) AS cost_usd
               FROM usage_events WHERE kind = 'tts' AND model_id IS NOT NULL
               GROUP BY model_id ORDER BY cost_usd DESC""",
        )
        by_model = await cur.fetchall()

    def totals(row) -> dict:
        return {
            "generations": row["generations"],
            "chars": row["chars"],
            "costUsd": round(row["cost_usd"], 6),
            "enhances": row["enhances"],
        }

    return {
        "session": totals(session_row),
        "allTime": totals(all_row),
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
