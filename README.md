# AI Voice — Inworld TTS POC

Human-like text-to-speech using the **Inworld TTS API**, with a **FastAPI**
backend and a small web UI. Supports **emotion / non-verbal tags** (`[happy]`,
`[sad]`, `[laugh]`, `[whispering]`, …) and natural-language steering. OpenAI
`gpt-4o-mini` can auto-insert those tags for you.

> This is the **cloud (Inworld)** variant. A separate **local, free** variant
> using the on-device Kokoro model lives in `../ai-voice-tts-poc`.

## Stack
- Python 3.12 + FastAPI + httpx
- Inworld TTS (cloud) · OpenAI gpt-4o-mini (optional, for tag insertion)
- Vanilla HTML/JS frontend (no build step)

## Setup

```bash
uv venv --python 3.12
uv pip install -r requirements.txt
```

Add your keys to `.env` (see `.env.example`):

```
API_KEY=your_inworld_base64_key      # from the Inworld Portal → "Copy Base64"
OPENAI_API_KEY=sk-...                 # optional, for the Enhance button
APP_USERNAME=admin                    # web UI login — leave blank to disable
APP_PASSWORD=change-me
```

### Login
If `APP_USERNAME` and `APP_PASSWORD` are set, opening the app shows a sign-in
screen; the credentials are only compared server-side and a signed, HttpOnly
cookie keeps you signed in for a week. The cookie's signing secret comes from
`SESSION_SECRET`, or is generated once and stored in the local SQLite DB — so
sessions survive a restart either way. With both variables blank, the UI is
open to anyone who can reach the port (the server logs a warning at startup).

## Run

```bash
uv run uvicorn main:app --reload --port 8000
```

Open http://127.0.0.1:8000 · Interactive API docs at `/docs`.

## Emotion control
Inworld reads inline markup placed **before** the phrase it should affect:
- Emotion: `[happy] [sad] [angry] [surprised] [whispering]`
- Non-verbal: `[laugh] [sigh] [breathe] [clear_throat] [cough]`
- Example: `[happy] Oh wow! [laugh] [whispering] but keep it a secret.`

The **✨ Enhance** button asks gpt-4o-mini to insert these tags for you.

## API
Same-origin by default. To call it from a separately-hosted frontend, list the
origins in `ALLOWED_ORIGINS` (comma-separated). See **[FRONTEND.md](FRONTEND.md)**.

| Endpoint | Method | Body / Purpose |
|---|---|---|
| `/api/health` | GET | Status + whether keys are configured |
| `/api/voices` | GET | Proxy Inworld voice catalog |
| `/api/synthesize` | POST | `{ text, voiceId, modelId, description?, audioEncoding? }` → base64 audio + dataUrl |
| `/api/enhance` | POST | `{ text }` → `{ enhanced }` (emotion tags via OpenAI) |
| `/api/usage` | GET | `?sessionId=…` → persisted spend: session totals, all-time totals, per-model |
| `/api/login` · `/api/logout` | POST | Sign in with the `.env` credentials / clear the session cookie |

Inworld endpoints: `POST /tts/v1/voice`, `GET /tts/v1/voices`, auth `Authorization: Basic <API_KEY>`.

## Persistence
Everything lives in `data/` (gitignored): SQLite at `data/app.db` plus the
rendered audio in `data/audio/`. It stores generation history, cloned voices,
and a `usage_events` row for every billable TTS/enhance call — so the Costs view
shows real running totals after a reload, a new tab, or a restart. Delete
`data/` to start clean.

## Costs
See **[COSTING.md](COSTING.md)** for Inworld + OpenAI pricing and example monthly estimates.
