# Costing Guide — Inworld TTS + OpenAI

Cost breakdown for running this POC. Two services are billed:

1. **Inworld TTS** — billed **per character** of text synthesized (the main cost).
2. **OpenAI gpt-4o-mini** — billed **per token**, only for the optional ✨ Enhance
   button (tiny cost).

> ⚠️ Prices below are as of **Aug 2026** from public pricing pages. Always confirm
> live rates in the [Inworld Portal](https://platform.inworld.ai) and
> [OpenAI pricing](https://openai.com/api/pricing) before relying on them.
> Both vendors lower rates at volume, so these are **upper-bound** estimates.

---

## 1. Inworld TTS — per-character pricing

| Model | Price / 1M chars | Notes |
|---|---|---|
| **Realtime TTS-2** | **$5** (at scale) | Newest, most expressive, natural-language steering |
| **TTS-1.5 Max** | **$10** | Best quality-to-price (this app's default) |
| **TTS-1.5 Mini** | **$15 → $7** | Cheapest/fastest at volume; tiered |

**Rule of thumb:** ~1,000 characters ≈ ~165 words ≈ **~1 minute** of speech.

### Cost per unit of audio (TTS-1.5 Max @ $10/M)
| You generate | Characters | Cost |
|---|---|---|
| 1 sentence (~100 chars) | 100 | $0.001 |
| 1 paragraph (~500 chars) | 500 | $0.005 |
| ~1 minute (~1,000 chars) | 1,000 | **$0.01** |
| ~1 hour (~60,000 chars) | 60,000 | **$0.60** |

Same audio on **TTS-2** ($5/M) is **half**; on **Mini** ($15/M) is **1.5×**.

---

## 2. OpenAI gpt-4o-mini — per-token pricing (Enhance only)

| | Price / 1M tokens |
|---|---|
| Input | **$0.15** |
| Output | **$0.60** |
| Cached input | $0.075 (50% off repeated prefixes) |
| Batch API | 50% off (non-real-time) |

**Rule of thumb:** ~1 token ≈ ~4 characters of English.

### Cost per Enhance call
One call = system prompt (~200 tokens) + your text in + tagged text out. For a
~300-char input (~80 tokens) the math is roughly:
- Input: ~280 tokens × $0.15/M ≈ $0.00004
- Output: ~100 tokens × $0.60/M ≈ $0.00006
- **≈ $0.0001 per call → ~10,000 Enhance calls per $1.**

Enhance cost is **negligible** next to TTS. Only relevant if you enhance millions
of times.

---

## 3. Worked monthly scenarios

Assumes TTS-1.5 Max ($10/M) and Enhance used on **every** generation.

| Scenario | Generations / mo | Avg chars | TTS chars/mo | **Inworld** | **OpenAI** | **Total / mo** |
|---|---|---|---|---|---|---|
| **A. Dev / demo** | 3,000 | 200 | 0.6M | $6.00 | ~$0.20 | **~$6** |
| **B. Small product** | 10,000 | 300 | 3.0M | $30.00 | ~$1.00 | **~$31** |
| **C. Growing app** | 100,000 | 300 | 30M | $300 | ~$10 | **~$310** |
| **D. Scale** | 1,000,000 | 300 | 300M | $3,000* | ~$100 | **~$3,100** |

\* At scale you'd move to **TTS-2 ($5/M)** and negotiated volume rates, roughly
**halving** the Inworld line (Scenario D ≈ **$1,500** on TTS-2).

### Same scenarios, cheapest setup (TTS-2 @ $5/M)
| Scenario | Inworld (TTS-2) | + OpenAI | Total |
|---|---|---|---|
| A. Dev / demo | $3 | $0.20 | **~$3** |
| B. Small product | $15 | $1 | **~$16** |
| C. Growing app | $150 | $10 | **~$160** |
| D. Scale | $1,500 | $100 | **~$1,600** |

---

## 4. Key takeaways

- **TTS is ~97%+ of the cost.** OpenAI enhancement is rounding error — enable it
  freely.
- **Character count is the lever.** You pay per character sent to Inworld, so
  trimming filler text directly cuts cost. Emotion tags like `[happy]` **do** count
  as characters, but they're tiny.
- **Pick the model per need:** Mini for high-volume/low-stakes, Max for quality,
  TTS-2 for best expression or scale pricing.
- **Cache/re-use audio.** If the same text is spoken repeatedly (prompts, UI
  cues), synthesize once and store the file instead of re-billing every play.
- **This POC generates on demand** — every "Generate speech" click bills Inworld;
  every "Enhance" click bills OpenAI. There is no charge when idle.

---

## 5. Quick formulas

```
Inworld cost  = (total characters / 1,000,000) × model_rate      # $10 Max, $5 TTS-2, $15 Mini
OpenAI cost   ≈ number_of_enhance_calls × $0.0001                # ~negligible
Audio minutes ≈ total characters / 1,000
```

**Sources (Aug 2026):**
[Inworld TTS pricing](https://inworld.ai/tts-api) ·
[Inworld pricing guide](https://www.eesel.ai/blog/inworld-ai-pricing) ·
[OpenAI API pricing](https://openai.com/api/pricing)
