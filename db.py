"""
SQLite persistence for the Inworld TTS POC (via aiosqlite).

Stores three things so sessions survive reloads and restarts:
  - renders:       every generated clip (text, voice, model, billed chars) keyed
                   by a client-provided sessionId. Audio is saved as a file on
                   disk (data/audio/<id>.mp3); the row keeps its path.
  - custom_voices: voices cloned through Inworld, so they can be listed in the
                   picker alongside the catalog immediately (Inworld's own
                   catalog is cached in-process and won't show a new clone
                   until the next cache refresh/restart).
  - enhance_calls: one row per OpenAI Enhance call, so the Costs view's
                   "enhance calls" stat survives reloads too.
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

CREATE TABLE IF NOT EXISTS enhance_calls (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    created_at    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enhance_session ON enhance_calls(session_id);

CREATE TABLE IF NOT EXISTS likes (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    item_type     TEXT NOT NULL,
    item_id       TEXT NOT NULL,
    created_at    REAL NOT NULL,
    UNIQUE(session_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_session ON likes(session_id, item_type);
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
            "description": None,
            "tags": [],
            "isCustom": True,
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


# ---- enhance calls -------------------------------------------------------

async def add_enhance_call(session_id: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO enhance_calls (id, session_id, created_at) VALUES (?,?,?)",
            (uuid.uuid4().hex, session_id, time.time()),
        )
        await db.commit()


async def count_enhance_calls(session_id: str) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT COUNT(*) FROM enhance_calls WHERE session_id = ?", (session_id,)
        )
        row = await cur.fetchone()
    return row[0] if row else 0


# ---- likes / favourites ---------------------------------------------------

async def toggle_like(session_id: str, item_type: str, item_id: str) -> bool:
    """Insert if not liked, delete if already liked. Returns new liked state."""
    async with aiosqlite.connect(DB_PATH) as conn:
        cur = await conn.execute(
            "SELECT id FROM likes WHERE session_id = ? AND item_type = ? AND item_id = ?",
            (session_id, item_type, item_id),
        )
        row = await cur.fetchone()
        if row:
            await conn.execute("DELETE FROM likes WHERE id = ?", (row[0],))
            await conn.commit()
            return False
        else:
            await conn.execute(
                "INSERT INTO likes (id, session_id, item_type, item_id, created_at) VALUES (?,?,?,?,?)",
                (uuid.uuid4().hex, session_id, item_type, item_id, time.time()),
            )
            await conn.commit()
            return True


async def list_likes(session_id: str, item_type: str) -> list[str]:
    """Return all liked item_ids for the given session and type."""
    async with aiosqlite.connect(DB_PATH) as conn:
        cur = await conn.execute(
            "SELECT item_id FROM likes WHERE session_id = ? AND item_type = ? ORDER BY created_at DESC",
            (session_id, item_type),
        )
        rows = await cur.fetchall()
    return [r[0] for r in rows]
