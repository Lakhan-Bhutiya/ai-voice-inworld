# Frontend Integration Guide — Inworld AI Voice API

Everything needed to consume the Inworld TTS backend. No keys or Python needed on
the frontend — just call the HTTP API.

- **Base URL (local):** `http://localhost:8000`
- **CORS:** same-origin by default. To call from another host (e.g. React on
  `localhost:3000`), set `ALLOWED_ORIGINS=http://localhost:3000` in `.env` and
  send requests with `credentials: "include"`.
- **Auth:** if `APP_USERNAME`/`APP_PASSWORD` are set in `.env`, every endpoint
  except `/api/health` and `/api/login` needs the session cookie from
  `POST /api/login` — otherwise you get `401 {"detail": "Not signed in."}`.
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
{ "ok": true, "username": "admin" }
```
Wrong credentials → `401 { "detail": "Wrong username or password." }`.

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
| `sessionId` | string | no | persist this render to the session's history (see below) |

**Pauses:** put SSML `<break time="0.5s"/>` inside `text` for silences (≤10s each, ≤20 per request).

Request:
```json
{ "text": "Let me think. <break time=\"1s\"/> Okay!", "voiceId": "Ashley",
  "modelId": "inworld-tts-1.5-max", "speakingRate": 0.9, "sessionId": "abc123" }
```
Response:
```json
{
  "audioContent": "<base64>",
  "dataUrl": "data:audio/mpeg;base64,...",
  "usage": { "processedCharactersCount": 27, "modelId": "inworld-tts-1.5-max" },
  "renderId": "…", "audioUrl": "/api/audio/…"   // present when sessionId was sent
}
```
`usage` is passed through verbatim from Inworld — the authoritative billed-character count.
`renderId`/`audioUrl` appear when the render was persisted to session history.
`usageTotals` (same shape as `GET /api/usage`) carries the refreshed running totals.

### Session history & custom voices
- `GET /api/history?sessionId=…` → `{ history: [{ renderId, text, voiceId, voiceName, modelId, audioUrl, charsBilled, createdAt }], enhanceCount: number }`. `enhanceCount` is this session's total billed Enhance calls — use it with the `charsBilled` in `history` to rebuild session stats after a reload instead of keeping an in-memory counter.
- `GET /api/audio/{renderId}` → the stored audio file (replay without re-billing)
- `DELETE /api/history/{renderId}`
- `POST /api/voices/clone` (multipart: `file`, `displayName`, `languageCode`, `transcription?`, `sessionId?`) → clone a voice from a 5–15s sample (wav/mp3/webm, ≤4MB). Cloned voices appear first in `GET /api/voices` with `"isCustom": true` (matches the field Inworld's own catalog uses for previously-cloned voices, so the client can treat both the same way).
- `GET /api/voices/custom` — lists just this app's locally-tracked clones (a subset of what's cloned on the Inworld account — see `isCustom` above for the full picture).
- `DELETE /api/voices/custom/{voiceId}` → **deletes the voice for real, at Inworld** (not just from local tracking). Only works on voices that are actually owned + IVC-cloned on the account — `403` otherwise. Irreversible; the sample audio was never kept, so there's no way to re-clone it identically. `404` if the voice doesn't exist on the account at all.
- `GET /api/voices/preview?voiceId=…&modelId=…` → a short, Inworld-picked sample line for any voice (built-in or cloned). Returns raw `audio/mpeg` (not JSON), cached for a day — **not metered or billed**, safe to call on every hover/click while browsing.

### `GET /api/usage?sessionId=…`
Persisted spend — every TTS render and enhance call is priced and stored, so
these totals survive reloads and restarts.
```json
{
  "session": { "generations": 12, "chars": 8420, "costUsd": 0.0842, "enhances": 3 },
  "allTime": { "generations": 57, "chars": 41200, "costUsd": 0.412, "enhances": 9 },
  "byModel": [ { "modelId": "inworld-tts-1.5-max", "generations": 40, "chars": 30000, "costUsd": 0.3 } ]
}
```
`sessionId` is optional; omit it for all-time numbers only.

### `POST /api/enhance` (optional, needs `OPENAI_API_KEY`)
Inserts emotion/non-verbal tags into the text via gpt-4o-mini.
```json
// request
{ "text": "I got the job but my friend moved away", "sessionId": "abc123" }
// response
{ "enhanced": "[happy] I got the job [sad] but my friend moved away.", "usageTotals": { … } }
```
`sessionId` is optional; pass it to count this billed call toward that session's
Costs stats (see `enhanceCount` below).

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
