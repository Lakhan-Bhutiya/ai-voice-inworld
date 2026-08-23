import * as api from "./api.js";

// Wires the Script panel, the shared voice selection, and the dock's
// generate/play button (one button, two meanings: "generate" while dormant,
// "play/pause" once audio has loaded — mirrors a persistent player dock
// rather than a one-shot form submit).

export function initComposer({
  scriptEl,
  counterEl,
  tagButtons,
  directionInput,
  directionPresets,
  enhanceBtn,
  modelSelect,
  speedInput,
  temperatureInput,
  deliverySelect,
  dockPlayBtn,
  downloadLink,
  regenBtn,
  dockMetaLabel,
  dockMetaUsage,
  getVoice,
  player,
  ripple,
  history,
  setBusy,
  onError,
  onUsage,
  onEnhanceUsed,
}) {
  function updateCount() {
    if (counterEl) counterEl.textContent = String(scriptEl.value.length);
  }
  scriptEl.addEventListener("input", updateCount);
  updateCount();

  function insertAtCursor(str) {
    const el = scriptEl;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const pad = start > 0 && el.value[start - 1] !== " " ? " " : "";
    el.value = el.value.slice(0, start) + pad + str + " " + el.value.slice(end);
    const pos = start + pad.length + str.length + 1;
    el.focus();
    el.setSelectionRange(pos, pos);
    updateCount();
  }

  tagButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      // data-insert lets a button show a friendly label but insert something
      // else (e.g. an SSML <break> tag) — otherwise insert the label itself.
      insertAtCursor(btn.dataset.insert || btn.textContent.trim());
      btn.classList.remove("chip-pop");
      void btn.offsetWidth; // restart the animation on repeat clicks
      btn.classList.add("chip-pop");
    });
  });

  directionPresets.forEach((btn) => {
    btn.addEventListener("click", () => {
      directionInput.value = btn.textContent.trim();
      directionInput.focus();
    });
  });

  enhanceBtn?.addEventListener("click", async () => {
    if (!scriptEl.value.trim()) return;
    const original = enhanceBtn.innerHTML;
    enhanceBtn.disabled = true;
    enhanceBtn.textContent = "Enhancing…";
    try {
      const { enhanced, usageTotals } = await api.enhance({ text: scriptEl.value });
      scriptEl.value = enhanced;
      updateCount();
      onEnhanceUsed?.(usageTotals);
    } catch (e) {
      onError?.(e.message);
    } finally {
      enhanceBtn.disabled = false;
      enhanceBtn.innerHTML = original;
    }
  });

  let busy = false;

  async function generate() {
    const text = scriptEl.value.trim();
    if (!text || busy) return;
    const voice = getVoice();
    if (!voice) {
      onError?.("Pick a voice first.");
      return;
    }

    busy = true;
    dockPlayBtn.disabled = true;
    if (regenBtn) regenBtn.disabled = true;
    const icon = dockPlayBtn.querySelector("i");
    if (icon) icon.className = "fa-solid fa-microphone";
    ripple.start();
    setBusy?.(true);

    try {
      const modelId = modelSelect?.value || "inworld-tts-1.5-max";
      const speakingRate = speedInput ? parseFloat(speedInput.value) : 1.0;
      const temperature = temperatureInput ? parseFloat(temperatureInput.value) : null;
      const deliveryMode = deliverySelect?.value || null;
      const res = await api.synthesize({
        text,
        voiceId: voice.voiceId,
        voiceName: voice.displayName,
        modelId,
        description: directionInput?.value.trim() || null,
        audioEncoding: "MP3",
        speakingRate,
        temperature,
        deliveryMode,
      });
      await player.load(res.dataUrl);
      player.play();

      if (dockMetaLabel) dockMetaLabel.textContent = `${voice.displayName} · ${modelId}`;
      if (dockMetaUsage) {
        dockMetaUsage.textContent = res.usage
          ? `${res.usage.processedCharactersCount} chars billed`
          : "";
      }
      // usageTotals are the server's persisted running totals for this session.
      onUsage?.(res.usageTotals);
      if (downloadLink) {
        downloadLink.href = res.dataUrl;
        downloadLink.download = `${voice.displayName || "speech"}.mp3`;
      }
      history.add({
        voiceId: voice.voiceId,
        displayName: voice.displayName,
        dataUrl: res.dataUrl,
        audioUrl: res.audioUrl,  // persisted URL, for replay after reload
        text: text.length > 60 ? text.slice(0, 60) + "…" : text,
      });
    } catch (e) {
      onError?.(e.message);
      player.showDormant();
    } finally {
      busy = false;
      dockPlayBtn.disabled = false;
      if (regenBtn) regenBtn.disabled = false;
      ripple.stop();
      setBusy?.(false);
    }
  }

  dockPlayBtn.addEventListener("click", () => {
    if (player.isDormant()) generate();
    else player.togglePlay();
  });
  regenBtn?.addEventListener("click", generate);

  scriptEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
  });

  return {
    generate,
    loadHistoryEntry(entry) {
      player.load(entry.dataUrl || entry.audioUrl).then(() => {
        player.play();
        if (dockMetaLabel) dockMetaLabel.textContent = entry.displayName || "";
        if (dockMetaUsage) dockMetaUsage.textContent = "";
        if (downloadLink) {
          downloadLink.href = entry.dataUrl || entry.audioUrl;
          downloadLink.download = `${entry.displayName || "speech"}.mp3`;
        }
      });
    },
  };
}
