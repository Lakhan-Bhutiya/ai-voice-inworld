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
ADMIN_USERNAME=admin                  # the only credentials in a file
ADMIN_PASSWORD=change-me
```

### Accounts and roles
Only the admin's credentials live in `.env`. The admin then creates everyone
else in the app — **Users** view (rail icon 4, or press `4`): type a username,
optionally a display name, leave the password blank to have a strong one
generated, and hand over the username/password the slip shows. That's the only
time the password is readable: it's stored as a salted PBKDF2 hash, so a reset
issues a new one rather than revealing the old.

| | admin | user |
|---|---|---|
| Studio, voices, cloning, history | ✅ | ✅ |
| Own generations · characters · enhance calls | ✅ | ✅ |
| Estimated cost, published rates, calculator | ✅ | — |
| Everyone's totals, per-account breakdown | ✅ | — |
| Creating, suspending, deleting accounts | ✅ | — |

**Every account is separate.** History, cloned voices, likes and usage are owned
by the signed-in account and scoped to it in every query — including
`/api/audio/{id}`, so one account can't fetch another's audio by guessing an id.
The admin sees usage *totals* per person, never their scripts or clips.

Money is withheld server-side, not just hidden in the UI: `/api/usage` and the
totals returned by synthesize/enhance omit every cost field for a regular user,
so spend isn't readable from the API either.

Sessions are a signed, HttpOnly cookie good for a week; its signing secret comes
from `SESSION_SECRET`, or is generated once and stored in the DB, so logins
survive a restart. Suspending or deleting an account kills its cookie on the
next request. With `ADMIN_USERNAME`/`ADMIN_PASSWORD` blank, login is disabled
entirely and everyone is treated as the admin (the server warns at startup);
`APP_USERNAME`/`APP_PASSWORD` still work as an alias for the admin pair.

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
| `/api/usage` | GET | Your persisted usage totals, per-model, plus everyone's for an admin (costs admin-only) |
| `/api/login` · `/api/logout` | POST | Sign in / clear the session cookie |
| `/api/me` | GET | Current username and role |
| `/api/admin/users` | GET · POST | List accounts with their usage · create one |
| `/api/admin/users/{id}/password` | POST | Reset a password (returns the new one, once) |
| `/api/admin/users/{id}/disabled` | POST | Suspend or restore |
| `/api/admin/users/{id}` | DELETE | Delete the account and everything it owns |

Inworld endpoints: `POST /tts/v1/voice`, `GET /tts/v1/voices`, auth `Authorization: Basic <API_KEY>`.

## Persistence
Everything lives in `data/` (gitignored): SQLite at `data/app.db` plus the
rendered audio in `data/audio/`. It stores accounts (with hashed passwords),
per-account generation history, cloned voices, likes, and a `usage_events` row
for every billable TTS/enhance call — so the totals are real after a reload, a
new tab, or a restart. Delete `data/` to start clean.

Rows written before accounts existed have no owner and are simply invisible in
the app; clear them out with `rm -rf data/` if you don't want them lying around.

## Costs
See **[COSTING.md](COSTING.md)** for Inworld + OpenAI pricing and example monthly estimates.
