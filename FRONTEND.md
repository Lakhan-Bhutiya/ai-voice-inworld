# Frontend Integration Guide — Inworld AI Voice API

Everything needed to consume the Inworld TTS backend. No keys or Python needed on
the frontend — just call the HTTP API.

- **Base URL (local):** `http://localhost:8000`
- **CORS:** open (`*`) — call from any origin (e.g. React on `localhost:3000`).
- **Interactive docs:** `http://localhost:8000/docs`

Audio returns as **base64** + a ready **`dataUrl`** (default MP3). Set it as an
`<audio>` src and play.

---

## Endpoints

### `GET /api/health`
```json
{ "status": "ok", "engine": "inworld", "ttsConfigured": true, "enhanceAvailable": true }
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

Request:
```json
{ "text": "[happy] Hello there! [laugh]", "voiceId": "Ashley", "modelId": "inworld-tts-1.5-max" }
```
Response:
```json
{ "audioContent": "<base64>", "dataUrl": "data:audio/mpeg;base64,..." }
```

### `POST /api/enhance` (optional, needs `OPENAI_API_KEY`)
Inserts emotion/non-verbal tags into the text via gpt-4o-mini.
```json
// request
{ "text": "I got the job but my friend moved away" }
// response
{ "enhanced": "[happy] I got the job [sad] but my friend moved away." }
```

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
