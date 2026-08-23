"""
Human-like Text-to-Speech POC — FastAPI backend over the Inworld TTS API.

The Inworld API key (Base64 "Copy Base64" value from the Inworld Portal) is read
from .env and used server-side only, so it never reaches the browser. OpenAI
gpt-4o-mini optionally inserts emotion/non-verbal tags into the text.
"""

import base64
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()  # before importing auth, which reads the credentials at import time

import auth  # noqa: E402
import db  # noqa: E402

API_KEY = os.getenv("API_KEY")  # Inworld Base64 key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
INWORLD_BASE = "https://api.inworld.ai"
OPENAI_BASE = "https://api.openai.com/v1"
BASE_DIR = Path(__file__).parent

# Inworld-supported markup the enhancer is allowed to insert. The guidance is
# deliberately RESTRAINED: earlier versions over-tagged, making every line sound
# theatrical. A tag should be the rare exception, not the default.
ENHANCE_SYSTEM_PROMPT = (
    "You add sparse inline emotion/non-verbal markup to text for a TTS engine. "
    "The goal is natural, understated speech — like a normal person talking, not "
    "a dramatic performance.\n"
    "Rules:\n"
    "- Keep ALL original words and their order. Do not add, remove, or reword content.\n"
    "- Only ADD bracketed tags; place a tag immediately BEFORE the phrase it affects.\n"
    "- Allowed emotion tags: [happy] [sad] [angry] [surprised] [whispering].\n"
    "- Allowed non-verbal tags: [laugh] [sigh] [breathe] [clear_throat] [cough].\n"
    "- BE VERY SPARING. Most sentences should get NO tag. Only tag a spot where the "
    "emotion is strong and unmistakable from the words themselves.\n"
    "- Never tag neutral, factual, or informational sentences — leave them untouched.\n"
    "- Use at most ONE tag per 1-2 sentences, and it's completely fine (often best) "
    "to return the text with NO tags at all.\n"
    "- Do not stack tags or add non-verbal sounds unless the text explicitly implies "
    "one (e.g. an actual laugh or sigh).\n"
    "- Return ONLY the resulting text, nothing else."
)

app = FastAPI(title="AI Voice POC (Inworld)", version="1.0.0")

# The UI is served from this same origin; the login cookie means a wildcard
# origin would be both unsafe and (with credentials) rejected by browsers.
# Set ALLOWED_ORIGINS="https://a.example,https://b.example" to host it elsewhere.
_allowed_origins = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
]
if _allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# Published Inworld rates per 1M characters, used to price each render as it
# happens (the frontend shows the same numbers on the Costs view).
RATE_PER_MILLION = {
    "inworld-tts-1.5-max": 10.0,
    "inworld-tts-1.5-mini": 15.0,
    "inworld-tts-2": 5.0,
}
DEFAULT_RATE = RATE_PER_MILLION["inworld-tts-1.5-max"]

# gpt-4o-mini enhance calls are tiny; price them off characters in + out at the
# published $0.15/$0.60 per 1M tokens, assuming ~4 characters per token.
ENHANCE_RATE_PER_CHAR = (0.15 + 0.60) / 1_000_000 / 4


def _tts_cost(model_id: str | None, chars: int | None) -> float:
    rate = RATE_PER_MILLION.get(model_id or "", DEFAULT_RATE)
    return (chars or 0) / 1_000_000 * rate


@app.on_event("startup")
async def _startup():
    await db.init()
    await auth.init()
    if not auth.enabled():
        print(
            "WARNING: APP_USERNAME/APP_PASSWORD are not set in .env — "
            "the UI is open to anyone who can reach it."
        )


# ---- Login gate --------------------------------------------------------------

# Everything except these needs a valid session cookie. /api/health stays open so
# the login page can show connection status before you're in.
PUBLIC_PATHS = {"/login", "/api/login", "/api/health", "/favicon.ico"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if (
        not auth.enabled()
        or path in PUBLIC_PATHS
        or path.startswith("/static/")
        or request.method == "OPTIONS"
    ):
        return await call_next(request)

    if auth.valid_token(request.cookies.get(auth.COOKIE_NAME)):
        return await call_next(request)

    if path.startswith("/api/"):
        return JSONResponse({"detail": "Not signed in."}, status_code=401)
    return RedirectResponse("/login", status_code=303)


class LoginRequest(BaseModel):
    username: str = Field(..., max_length=200)
    password: str = Field(..., max_length=200)


@app.get("/login")
async def login_page(request: Request):
    """The sign-in screen — skipped entirely if you already have a session."""
    if not auth.enabled() or auth.valid_token(request.cookies.get(auth.COOKIE_NAME)):
        return RedirectResponse("/", status_code=303)
    return FileResponse(BASE_DIR / "static" / "login.html")


@app.post("/api/login")
async def login(req: LoginRequest, response: Response):
    if not auth.enabled():
        raise HTTPException(
            status_code=500,
            detail="Login is not configured. Add APP_USERNAME and APP_PASSWORD to .env",
        )
    if not auth.check_credentials(req.username, req.password):
        raise HTTPException(status_code=401, detail="Wrong username or password.")
    response.set_cookie(
        auth.COOKIE_NAME,
        auth.make_token(req.username),
        max_age=auth.SESSION_TTL,
        httponly=True,
        samesite="lax",
    )
    return {"ok": True, "username": req.username}


@app.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME)
    return {"ok": True}


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voiceId: str = "Ashley"
    voiceName: str | None = None  # display name, for nicer history labels
    modelId: str = "inworld-tts-1.5-max"
    # Natural-language steering / emotion, prepended to the text as an instruction.
    description: str | None = None
    audioEncoding: str = "MP3"
    sampleRateHertz: int = 24000
    # Delivery controls (all optional).
    speakingRate: float = Field(1.0, ge=0.5, le=1.5)   # 1.0 = normal speed
    temperature: float | None = Field(None, ge=0.0, le=2.0)  # variation; ignored on tts-2
    deliveryMode: str | None = None  # STABLE | BALANCED | CREATIVE (tts-2 only)
    # If provided, the render is persisted to this browser session's history.
    sessionId: str | None = None


class EnhanceRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    # If provided, the enhance call is counted against this session's usage.
    sessionId: str | None = None


def _auth_headers() -> dict:
    if not API_KEY:
        raise HTTPException(
            status_code=500,
            detail="API_KEY missing. Add your Inworld Base64 key to .env",
        )
    return {
        "Authorization": f"Basic {API_KEY}",
        "Content-Type": "application/json",
    }


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "engine": "inworld",
        "ttsConfigured": bool(API_KEY),
        "enhanceAvailable": bool(OPENAI_API_KEY),
        "authRequired": auth.enabled(),
    }


_catalog_cache: list | None = None


async def _fetch_catalog() -> list:
    """Inworld's built-in voice catalog. Cached — it doesn't change at runtime."""
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{INWORLD_BASE}/tts/v1/voices", headers=_auth_headers()
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    _catalog_cache = resp.json().get("voices", [])
    return _catalog_cache


@app.get("/api/voices")
async def list_voices():
    """Custom (cloned) voices first, then Inworld's built-in catalog."""
    catalog = await _fetch_catalog()
    custom = await db.list_custom_voices()
    return {"voices": custom + catalog}


@app.post("/api/synthesize")
async def synthesize(req: SynthesizeRequest):
    """Call Inworld TTS and return base64 audio plus a data URL for the player."""
    text = req.text
    if req.description:
        # Inworld supports natural-language steering; prepend it as guidance.
        text = f"[{req.description}] {text}"

    audio_config = {
        "audioEncoding": req.audioEncoding,
        "sampleRateHertz": req.sampleRateHertz,
    }
    if req.speakingRate and req.speakingRate != 1.0:
        audio_config["speakingRate"] = req.speakingRate

    payload = {
        "text": text,  # may contain SSML <break time="0.5s"/> for pauses
        "voiceId": req.voiceId,
        "modelId": req.modelId,
        "audioConfig": audio_config,
    }
    if req.temperature is not None:
        payload["temperature"] = req.temperature
    if req.deliveryMode:
        payload["deliveryMode"] = req.deliveryMode

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{INWORLD_BASE}/tts/v1/voice",
            headers=_auth_headers(),
            json=payload,
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data = resp.json()
    audio_b64 = data.get("audioContent")
    if not audio_b64:
        raise HTTPException(status_code=502, detail="No audioContent in response")

    mime = {
        "MP3": "audio/mpeg",
        "LINEAR16": "audio/wav",
        "WAV": "audio/wav",
        "OGG_OPUS": "audio/ogg",
        "FLAC": "audio/flac",
    }.get(req.audioEncoding, "audio/mpeg")

    result = {
        "audioContent": audio_b64,
        "dataUrl": f"data:{mime};base64,{audio_b64}",
        "usage": data.get("usage"),
    }

    usage = data.get("usage") or {}
    chars_billed = usage.get("processedCharactersCount")
    render_id = None

    # Persist to this session's history so it survives reloads/restarts.
    if req.sessionId:
        ext = {"MP3": "mp3", "OGG_OPUS": "ogg", "FLAC": "flac"}.get(
            req.audioEncoding, "wav"
        )
        record = await db.add_render(
            session_id=req.sessionId,
            text=req.text,
            audio_bytes=base64.b64decode(audio_b64),
            voice_id=req.voiceId,
            voice_name=req.voiceName,
            model_id=req.modelId,
            description=req.description,
            chars_billed=chars_billed,
            ext=ext,
        )
        render_id = record["renderId"]
        result["renderId"] = render_id
        result["audioUrl"] = record["audioUrl"]

    # Bill it. Logged for every render, session or not, so all-time totals are real.
    await db.log_usage(
        session_id=req.sessionId,
        kind="tts",
        model_id=req.modelId,
        chars=chars_billed or 0,
        cost_usd=_tts_cost(req.modelId, chars_billed),
        render_id=render_id,
    )
    result["usageTotals"] = await db.usage_summary(req.sessionId)

    return result


@app.post("/api/enhance")
async def enhance(req: EnhanceRequest):
    """Use OpenAI gpt-4o-mini to insert emotion/non-verbal tags into the text."""
    if not OPENAI_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY missing. Add it to .env to use AI enhancement.",
        )
    payload = {
        "model": "gpt-4o-mini",
        "temperature": 0.3,  # low → conservative, consistent tagging
        "messages": [
            {"role": "system", "content": ENHANCE_SYSTEM_PROMPT},
            {"role": "user", "content": req.text},
        ],
    }
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{OPENAI_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    enhanced = resp.json()["choices"][0]["message"]["content"].strip()

    await db.log_usage(
        session_id=req.sessionId,
        kind="enhance",
        model_id="gpt-4o-mini",
        chars=len(req.text) + len(enhanced),
        cost_usd=(len(req.text) + len(enhanced)) * ENHANCE_RATE_PER_CHAR,
    )
    return {
        "enhanced": enhanced,
        "usageTotals": await db.usage_summary(req.sessionId),
    }


# ---- Session history ---------------------------------------------------------


@app.get("/api/history")
async def get_history(sessionId: str, limit: int = 50):
    """Past renders for a browser session (newest first), for restore on reload."""
    return {"history": await db.list_renders(sessionId, limit)}


@app.get("/api/usage")
async def get_usage(sessionId: str | None = None):
    """Persisted spend: this session's totals, all-time totals, and per-model."""
    return await db.usage_summary(sessionId)


@app.get("/api/audio/{render_id}")
async def get_audio(render_id: str):
    """Serve a stored render's audio so history entries can replay without re-billing."""
    path = await db.get_audio_path(render_id)
    if not path or not Path(path).exists():
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(path)


@app.delete("/api/history/{render_id}")
async def delete_history(render_id: str):
    if not await db.delete_render(render_id):
        raise HTTPException(status_code=404, detail="Render not found")
    return {"deleted": render_id}


# ---- Custom voice cloning ----------------------------------------------------


@app.post("/api/voices/clone")
async def clone_voice(
    file: UploadFile = File(...),
    displayName: str = Form(...),
    languageCode: str = Form("en-US"),
    transcription: str = Form(""),
    sessionId: str = Form(""),
):
    """Clone a voice from a 5-15s audio sample (wav/mp3, <=4MB) via Inworld."""
    raw = await file.read()
    if len(raw) > 4 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Sample must be under 4MB.")

    sample = {"audioData": base64.b64encode(raw).decode("ascii")}
    if transcription.strip():
        sample["transcription"] = transcription.strip()

    payload = {
        "displayName": displayName,
        "languageCode": languageCode,
        "voiceSamples": [sample],
        "audioProcessingConfig": {"removeBackgroundNoise": True},
    }

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{INWORLD_BASE}/voices/v1/voices:clone",
            headers=_auth_headers(),
            json=payload,
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    voice = resp.json().get("voice", {})
    voice_id = voice.get("voiceId")
    if not voice_id:
        raise HTTPException(status_code=502, detail="Clone response had no voiceId")

    await db.add_custom_voice(
        voice_id=voice_id,
        display_name=voice.get("displayName") or displayName,
        language_code=voice.get("languageCode") or languageCode,
        session_id=sessionId or None,
    )
    return {
        "voiceId": voice_id,
        "displayName": voice.get("displayName") or displayName,
        "languages": [voice.get("languageCode") or languageCode],
        "custom": True,
    }


@app.get("/api/voices/custom")
async def list_custom():
    return {"voices": await db.list_custom_voices()}


@app.delete("/api/voices/custom/{voice_id}")
async def delete_custom(voice_id: str):
    if not await db.delete_custom_voice(voice_id):
        raise HTTPException(status_code=404, detail="Custom voice not found")
    return {"deleted": voice_id}


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
