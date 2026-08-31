// Shared voice-preview player. One <audio> element for the whole app, so
// clicking preview on a second voice always stops the first — a voice-row
// preview button is an "audition," not a persistent player, and only one
// audition makes sense at a time. Deliberately separate from player.js
// (the dock): previewing a voice must never touch audio you've generated.

function setBtnState(btn, state) {
  if (!btn) return;
  const icon = btn.querySelector("i");
  btn.classList.toggle("is-loading", state === "loading");
  btn.classList.toggle("is-playing", state === "playing");
  btn.setAttribute("aria-label", state === "playing" ? "Pause preview" : "Play preview");
  if (icon) {
    icon.className =
      state === "loading" ? "fa-solid fa-spinner fa-spin"
      : state === "playing" ? "fa-solid fa-pause"
      : "fa-solid fa-play";
  }
}

export function createPreviewController({ onError } = {}) {
  const audioEl = new Audio();
  let activeBtn = null;
  let activeVoiceId = null;

  audioEl.addEventListener("playing", () => setBtnState(activeBtn, "playing"));
  audioEl.addEventListener("pause", () => setBtnState(activeBtn, "idle"));
  audioEl.addEventListener("ended", () => setBtnState(activeBtn, "idle"));
  audioEl.addEventListener("error", () => {
    if (audioEl.src) onError?.("Couldn't load that preview.");
    setBtnState(activeBtn, "idle");
    activeBtn = null;
    activeVoiceId = null;
  });

  function toggle(voice, btn, modelId) {
    const isCurrent = activeVoiceId === voice.voiceId;
    if (isCurrent && !audioEl.paused) {
      audioEl.pause();
      return;
    }
    if (isCurrent && audioEl.currentTime > 0) {
      audioEl.play().catch(() => setBtnState(btn, "idle"));
      return;
    }
    if (activeBtn && activeBtn !== btn) setBtnState(activeBtn, "idle");
    activeBtn = btn;
    activeVoiceId = voice.voiceId;
    setBtnState(btn, "loading");
    audioEl.src = `/api/voices/preview?voiceId=${encodeURIComponent(voice.voiceId)}&modelId=${encodeURIComponent(modelId)}`;
    audioEl.play().catch(() => {
      setBtnState(btn, "idle");
      onError?.("Couldn't load that preview.");
    });
  }

  return { toggle };
}
