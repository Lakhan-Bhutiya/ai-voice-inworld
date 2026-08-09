"""
Human-like Text-to-Speech POC — FastAPI backend over the Inworld TTS API.

The Inworld API key (Base64 "Copy Base64" value from the Inworld Portal) is read
from .env and used server-side only, so it never reaches the browser. OpenAI
gpt-4o-mini optionally inserts emotion/non-verbal tags into the text.
"""

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

API_KEY = os.getenv("API_KEY")  # Inworld Base64 key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
INWORLD_BASE = "https://api.inworld.ai"
OPENAI_BASE = "https://api.openai.com/v1"
BASE_DIR = Path(__file__).parent

# Inworld-supported markup the enhancer is allowed to insert.
ENHANCE_SYSTEM_PROMPT = (
    "You rewrite text for a human-like text-to-speech engine by inserting inline "
    "emotion and non-verbal markup so the spoken result sounds natural and expressive.\n"
    "Rules:\n"
    "- Keep ALL original words and their order. Do not add, remove, or reword content.\n"
    "- Only ADD bracketed tags between words/sentences.\n"
    "- Allowed emotion tags: [happy] [sad] [angry] [surprised] [whispering].\n"
    "- Allowed non-verbal tags: [laugh] [sigh] [breathe] [clear_throat] [cough].\n"
    "- Place a tag immediately BEFORE the phrase it should affect.\n"
    "- Be tasteful: only tag where it genuinely fits the meaning. Don't over-tag.\n"
    "- Return ONLY the tagged text, nothing else."
)

app = FastAPI(title="AI Voice POC (Inworld)", version="1.0.0")

# Allow a separately-hosted frontend to call this API from any origin (POC).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voiceId: str = "Ashley"
    modelId: str = "inworld-tts-1.5-max"
    # Natural-language steering / emotion, prepended to the text as an instruction.
    description: str | None = None
    audioEncoding: str = "MP3"
    sampleRateHertz: int = 24000


class EnhanceRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


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
    }


@app.get("/api/voices")
async def list_voices():
    """Proxy Inworld's voice catalog so the UI can populate a voice picker."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{INWORLD_BASE}/tts/v1/voices", headers=_auth_headers()
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


@app.post("/api/synthesize")
async def synthesize(req: SynthesizeRequest):
    """Call Inworld TTS and return base64 audio plus a data URL for the player."""
    text = req.text
    if req.description:
        # Inworld supports natural-language steering; prepend it as guidance.
        text = f"[{req.description}] {text}"

    payload = {
        "text": text,
        "voiceId": req.voiceId,
        "modelId": req.modelId,
        "audioConfig": {
            "audioEncoding": req.audioEncoding,
            "sampleRateHertz": req.sampleRateHertz,
        },
    }

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

    return {"audioContent": audio_b64, "dataUrl": f"data:{mime};base64,{audio_b64}"}


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
        "temperature": 0.7,
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
    return {"enhanced": enhanced}


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
