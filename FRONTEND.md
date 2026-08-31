# Frontend Integration Guide — Inworld AI Voice API

Everything needed to consume the Inworld TTS backend. No keys or Python needed on
the frontend — just call the HTTP API.

- **Base URL (local):** `http://localhost:8000`
- **CORS:** same-origin by default. To call from another host (e.g. React on
  `localhost:3000`), set `ALLOWED_ORIGINS=http://localhost:3000` in `.env` and
  send requests with `credentials: "include"`.
- **Auth:** if any account is configured in `.env`, every endpoint except
  `/api/health` and `/api/login` needs the session cookie from
  `POST /api/login` — otherwise you get `401 {"detail": "Not signed in."}`.
- **Roles:** `admin` sees cost figures and everyone's totals; `user` gets the
  same responses with every `costUsd` field (and `allUsers`) omitted. Call
  `GET /api/me` for the current role.
- **Ownership:** nothing takes a `sessionId` any more. History, cloned voices,
  likes and usage all belong to the signed-in account, resolved server-side from
  the cookie, and are scoped to it in every query.
- **Interactive docs:** `http://localhost:8000/docs`

Audio returns as **base64** + a ready **`dataUrl`** (default MP3). Set it as an
`<audio>` src and play.

---

## Endpoints

### `GET /api/health`
```json
{ "status": "ok", "engine": "inworld", "ttsConfigured": true, "enhanceAvailable": true }
```

### `POST /api/login` · `POST /api/logout`
```json
// request
{ "username": "admin", "password": "…" }
// response — also sets the HttpOnly `av_session` cookie
{ "ok": true, "username": "admin", "role": "admin" }
```
Wrong credentials → `401 { "detail": "Wrong username or password." }`.

### `GET /api/me`
```json
{ "username": "admin", "role": "admin", "isAdmin": true }
```

### Admin: accounts (admin only — `403` for a user)
| Endpoint | Method | Purpose |
|---|---|---|
| `/api/admin/users` | GET | Every account with its usage totals, plus the admin's own |
| `/api/admin/users` | POST | `{ username, password?, displayName? }` — blank password generates one |
| `/api/admin/users/{id}/password` | POST | `{ password? }` → `{ password }` (the only time it's readable) |
| `/api/admin/users/{id}/disabled` | POST | `{ disabled: true \| false }` |
| `/api/admin/users/{id}` | DELETE | Deletes the account, its renders, audio, voices and usage |

Create returns the account plus its cleartext password exactly once:
```json
{ "id": "…", "username": "riya", "displayName": "Riya S", "disabled": false,
  "createdAt": 1788173933.3, "lastLoginAt": null, "password": "5F2d6fEmZQ8m4p" }
```

### `GET /api/voices`
Proxies Inworld's catalog. Shape (fields may vary):
```json
{ "voices": [ { "voiceId": "Ashley", "displayName": "Ashley", "languages": ["en"] }, ... ] }
```

### `POST /api/synthesize`  ← main
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | 1–2000 chars; may include emotion tags like `[happy]` |
| `voiceId` | string | no | default `Ashley` |
| `modelId` | string | no | `inworld-tts-1.5-max` (default), `inworld-tts-1.5-mini`, `inworld-tts-2` |
| `description` | string | no | natural-language steering, e.g. `"speak sadly"` (best on tts-2) |
| `audioEncoding` | string | no | `MP3` (default), `LINEAR16`, `WAV`, `OGG_OPUS`, `FLAC` |
| `speakingRate` | number | no | speed, `0.5`–`1.5` (1.0 = normal) |
| `temperature` | number | no | variation `0`–`2`; ignored on tts-2 |
| `deliveryMode` | string | no | `STABLE` \| `BALANCED` \| `CREATIVE` (tts-2 only) |

**Pauses:** put SSML `<break time="0.5s"/>` inside `text` for silences (≤10s each, ≤20 per request).

Request:
```json
{ "text": "Let me think. <break time=\"1s\"/> Okay!", "voiceId": "Ashley",
  "modelId": "inworld-tts-1.5-max", "speakingRate": 0.9 }
```
Response:
```json
{
  "audioContent": "<base64>",
  "dataUrl": "data:audio/mpeg;base64,...",
  "usage": { "processedCharactersCount": 27, "modelId": "inworld-tts-1.5-max" },
  "renderId": "…", "audioUrl": "/api/audio/…"
}
```
`usage` is passed through verbatim from Inworld — the authoritative billed-character count.
`renderId`/`audioUrl` point at the stored render, saved to the signed-in account's history.
`usageTotals` (same shape as `GET /api/usage`) carries the refreshed running totals.

### History & custom voices (scoped to the signed-in account)
- `GET /api/history` → `{ history: [{ renderId, text, voiceId, voiceName, modelId, audioUrl, charsBilled, createdAt }], enhanceCount, likedRenderIds }`. `enhanceCount` is your total billed Enhance calls.
- `GET /api/audio/{renderId}` → the stored audio file (replay without re-billing). `404` if the render belongs to someone else.
- `DELETE /api/history/{renderId}`
- `POST /api/voices/clone` (multipart: `file`, `displayName`, `languageCode`, `transcription?`) → clone a voice from a 5–15s sample (wav/mp3/webm, ≤4MB). Cloned voices appear first in `GET /api/voices` with `"isCustom": true` (matches the field Inworld's own catalog uses for previously-cloned voices, so the client can treat both the same way).
- `GET /api/voices/custom` — lists just this app's locally-tracked clones (a subset of what's cloned on the Inworld account — see `isCustom` above for the full picture).
- `DELETE /api/voices/custom/{voiceId}` → **deletes the voice for real, at Inworld** (not just from local tracking). Only works on voices that are actually owned + IVC-cloned on the account — `403` otherwise. Irreversible; the sample audio was never kept, so there's no way to re-clone it identically. `404` if the voice doesn't exist on the account at all.
- `GET /api/voices/preview?voiceId=…&modelId=…` → a short, Inworld-picked sample line for any voice (built-in or cloned). Returns raw `audio/mpeg` (not JSON), cached for a day — **not metered or billed**, safe to call on every hover/click while browsing.

### `GET /api/usage`
Persisted usage — every TTS render and enhance call is counted and priced when
it happens, so these totals survive reloads, restarts, and deleting a render
from history. As an admin:
```json
{
  "you":      { "generations": 12, "chars": 8420, "costUsd": 0.0842, "enhances": 3 },
  "allUsers": { "generations": 57, "chars": 41200, "costUsd": 0.412, "enhances": 9 },
  "byModel":  [ { "modelId": "inworld-tts-1.5-max", "generations": 40, "chars": 30000, "costUsd": 0.3 } ]
}
```
A `user` gets `you` and `byModel` only, both without `costUsd`.

### `POST /api/enhance` (optional, needs `OPENAI_API_KEY`)
Inserts emotion/non-verbal tags into the text via gpt-4o-mini.
```json
// request
{ "text": "I got the job but my friend moved away" }
// response
{ "enhanced": "[happy] I got the job [sad] but my friend moved away.", "usageTotals": { … } }
```
The call is counted toward the signed-in account's usage automatically, and
`usageTotals` carries the refreshed numbers.

---

## Emotion tags (put inside `text`, before the phrase)
- Emotion: `[happy] [sad] [angry] [surprised] [whispering]`
- Non-verbal: `[laugh] [sigh] [breathe] [clear_throat] [cough]`

## Errors
Non-200 → `{ "detail": "..." }`. Read `detail` for the message.

## Example (JS)
```js
const API = "http://localhost:8000";

async function speak(text, voiceId = "Ashley", modelId = "inworld-tts-1.5-max") {
  const res = await fetch(`${API}/api/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voiceId, modelId }),
  });
  if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
  const { dataUrl } = await res.json();
  new Audio(dataUrl).play();
}
```

> 💡 Every synthesize call bills Inworld per character; every enhance call bills
> OpenAI. See [COSTING.md](COSTING.md).
