import * as api from "./api.js";
import { costFor } from "./pricing.js";

// Wires the Script panel, the shared voice selection, the Advanced delivery
// controls, and the dock's generate/play button (one button, two meanings:
// "generate" while dormant, "play/pause" once audio has loaded — mirrors a
// persistent player dock rather than a one-shot form submit).

const MODEL_LABELS = {
  "inworld-tts-1.5-max": "1.5-max",
  "inworld-tts-1.5-mini": "1.5-mini",
  "inworld-tts-2": "tts-2",
};
const DELIVERY_LABELS = { STABLE: "Stable", BALANCED: "Balanced", CREATIVE: "Creative" };

export function initComposer({
  scriptEl,
  counterEl,
  tagButtons,
  directionInput,
  directionPresets,
  enhanceBtn,
  modelControl,
  deliveryControl,
  speedInput,
  temperatureInput,
  advancedSummary,
  dockPlayBtn,
  downloadLink,
  regenBtn,
  dockMetaLabel,
  dockMetaUsage,
  dockMetaEstimate,
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

  function isTts2() {
    return modelControl.getValue() === "inworld-tts-2";
  }

  function updateEstimate() {
    const chars = scriptEl.value.length;
    if (dockMetaUsage) dockMetaUsage.hidden = true;
    if (!dockMetaEstimate) return;
    if (!chars) {
      dockMetaEstimate.textContent = "";
      return;
    }
    const cost = costFor(chars, modelControl.getValue());
    dockMetaEstimate.textContent = `≈ ${chars} chars · $${cost.toFixed(4)}`;
  }

  function updateGating() {
    const tts2 = isTts2();
    deliveryControl.setDisabled(!tts2);
    if (!tts2 && deliveryControl.getValue() !== "") deliveryControl.setValue("");
    if (temperatureInput) temperatureInput.disabled = tts2;
  }

  function updateSummary() {
    if (!advancedSummary) return;
    const modelId = modelControl.getValue();
    const speed = `${parseFloat(speedInput?.value ?? "1").toFixed(1)}×`;
    const tts2 = isTts2();
    const third = tts2
      ? (deliveryControl.getValue() ? DELIVERY_LABELS[deliveryControl.getValue()] : "default delivery")
      : `v${parseFloat(temperatureInput?.value ?? "1").toFixed(1)}`;
    advancedSummary.textContent = `${MODEL_LABELS[modelId] || modelId} · ${speed} · ${third}`;
  }

  function setRangeFill(input) {
    if (!input) return;
    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || 1;
    const val = parseFloat(input.value);
    const pct = ((val - min) / (max - min)) * 100;
    input.style.setProperty("--pct", `${pct}%`);
  }

  function refreshAll() {
    updateGating();
    updateSummary();
    updateEstimate();
  }

  scriptEl.addEventListener("input", () => {
    updateCount();
    updateEstimate();
  });
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
    updateEstimate();
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
      const { enhanced } = await api.enhance({ text: scriptEl.value });
      scriptEl.value = enhanced;
      updateCount();
      updateEstimate();
      onEnhanceUsed?.();
    } catch (e) {
      onError?.(e.message);
    } finally {
      enhanceBtn.disabled = false;
      enhanceBtn.innerHTML = original;
    }
  });

  // ---- Advanced delivery controls: gating + live summary ----------------------

  [speedInput, temperatureInput].forEach((input) => {
    if (!input) return;
    setRangeFill(input);
    input.addEventListener("input", () => {
      setRangeFill(input);
      const v = parseFloat(input.value).toFixed(1);
      if (input === speedInput) {
        const el = document.getElementById("speedVal");
        if (el) el.textContent = `${v}×`;
        input.setAttribute("aria-valuetext", `${v} times normal speed`);
      } else {
        const el = document.getElementById("tempVal");
        if (el) el.textContent = v;
        input.setAttribute("aria-valuetext", v);
      }
      updateSummary();
      updateEstimate();
    });
  });

  modelControl.el.addEventListener("change", refreshAll);
  deliveryControl.el.addEventListener("change", updateSummary);

  refreshAll();

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
      const modelId = modelControl.getValue();
      const tts2 = modelId === "inworld-tts-2";
      const speakingRate = speedInput ? parseFloat(speedInput.value) : 1.0;
      const temperature = tts2 ? null : (temperatureInput ? parseFloat(temperatureInput.value) : null);
      const deliveryMode = tts2 ? (deliveryControl.getValue() || null) : null;
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
      if (dockMetaEstimate) dockMetaEstimate.hidden = true;
      if (dockMetaUsage) {
        dockMetaUsage.hidden = !res.usage;
        dockMetaUsage.textContent = res.usage
          ? `${res.usage.processedCharactersCount} chars billed`
          : "";
      }
      if (res.usage) onUsage?.({ ...res.usage, modelId: res.usage.modelId || modelId });
      if (downloadLink) {
        downloadLink.href = res.dataUrl;
        downloadLink.download = `${voice.displayName || "speech"}.mp3`;
      }
      history.add({
        renderId: res.renderId,
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
    onVoiceChanged(voice) {
      // A voice switch doesn't re-bill automatically (see app.js) — just
      // reflect the change so the dock makes clear a regenerate is needed.
      if (player.isDormant() || !dockMetaLabel) return;
      dockMetaLabel.textContent = `${voice.displayName} selected — regenerate to hear it`;
    },
    loadHistoryEntry(entry) {
      player.load(entry.dataUrl || entry.audioUrl).then(() => {
        player.play();
        if (dockMetaLabel) dockMetaLabel.textContent = entry.displayName || "";
        if (dockMetaUsage) dockMetaUsage.hidden = true;
        if (dockMetaEstimate) dockMetaEstimate.hidden = true;
        if (downloadLink) {
          downloadLink.href = entry.dataUrl || entry.audioUrl;
          downloadLink.download = `${entry.displayName || "speech"}.mp3`;
        }
      });
    },
  };
}
