// Inworld per-character rates (see COSTING.md). Mini is quoted at its
// upper-bound rate ($15/M) rather than its "at volume" tiered rate — the
// exact character threshold where it drops to $7/M isn't published anywhere
// in this repo's sources, and COSTING.md's own worked scenarios use the same
// convention: "Both vendors lower rates at volume, so these are upper-bound
// estimates." Never under-quote what a generation could cost.

export const RATE_PER_MILLION = {
  "inworld-tts-1.5-max": 10,
  "inworld-tts-1.5-mini": 15,
  "inworld-tts-2": 5,
};

export function rateFor(modelId) {
  return RATE_PER_MILLION[modelId] ?? RATE_PER_MILLION["inworld-tts-1.5-max"];
}

export function costFor(chars, modelId) {
  return (Number(chars) || 0) / 1_000_000 * rateFor(modelId);
}
