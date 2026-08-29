import { initTheme } from "./theme.js";
import * as api from "./api.js";
import { createVoicePicker } from "./voices.js";
import { createPlayer } from "./player.js";
import { createRipple } from "./ripple.js";
import { createHistory } from "./history.js";
import { initComposer } from "./composer.js";
import { createSegmented } from "./segmented.js";
import { initClone } from "./clone.js";
import { createPreviewController } from "./preview.js";
import { RATE_PER_MILLION, costFor } from "./pricing.js";

initTheme();

// ---- View routing ----------------------------------------------------------

const views = document.querySelectorAll(".view");
const navButtons = document.querySelectorAll(".rail-link[data-view], .mnav-link[data-view]");

function showView(name) {
  views.forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  navButtons.forEach((b) => b.classList.toggle("active", b.dataset.view === name));
}
navButtons.forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

// ---- Toasts -----------------------------------------------------------------

const toastStack = document.getElementById("toastStack");
function showToast(message) {
  if (!toastStack) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ---- Health check / status dot ----------------------------------------------

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

api
  .getHealth()
  .then((data) => {
    if (!statusDot || !statusText) return;
    if (data.ttsConfigured) {
      statusDot.className = "status-dot ok";
      statusText.textContent = "Connected";
    } else {
      statusDot.className = "status-dot warn";
      statusText.textContent = "API key missing";
    }
  })
  .catch(() => {
    if (statusDot) statusDot.className = "status-dot err";
    if (statusText) statusText.textContent = "Offline";
  });

function updateVoiceCounts(delta) {
  document.querySelectorAll("#voiceCountStudio, #voiceCountVoices").forEach((el) => {
    el.textContent = String(Math.max(0, Number(el.textContent) + delta));
  });
}

function setBusy(busy) {
  if (!statusDot || !statusText) return;
  if (busy) {
    statusDot.className = "status-dot busy";
    statusText.textContent = "Generating…";
  } else {
    statusDot.className = "status-dot ok";
    statusText.textContent = "Connected";
  }
}

// ---- Player + ripple ----------------------------------------------------------

const player = createPlayer({
  canvas: document.getElementById("dockWave"),
  playBtn: document.getElementById("dockPlay"),
  timeCurrent: document.getElementById("timeCurrent"),
  timeTotal: document.getElementById("timeTotal"),
});
const ripple = createRipple(document.getElementById("rippleCanvas"));
const previewController = createPreviewController({ onError: showToast });

// ---- Session history (server-persisted) ----------------------------------------

const history = createHistory({
  container: document.getElementById("historyStrip"),
  filterBar: document.getElementById("historyFilterBar"),
  onSelect: (entry) => composer.loadHistoryEntry(entry),
  onDelete: async (entry) => {
    if (!entry.renderId) return;
    try {
      await api.deleteHistoryEntry(entry.renderId);
      history.remove(entry.renderId);
      refreshStats();
    } catch (e) {
      showToast(`Couldn't delete: ${e.message}`);
    }
  },
  onToggleLike: async (entry) => {
    if (!entry.renderId) return null;
    try {
      return await api.toggleLike({ itemType: "render", itemId: entry.renderId });
    } catch (e) {
      showToast(`Couldn't toggle like: ${e.message}`);
      return null;
    }
  },
});

// ---- Costs / session stats -----------------------------------------------------
// Derived live from the server's render + enhance-call records, not an
// in-memory counter — so the Costs view stays correct across reloads and
// after cloning a voice (which no longer force-reloads the page at all).

const stats = { generations: 0, chars: 0, costUsd: 0, enhances: 0 };
const statGenerations = document.getElementById("statGenerations");
const statChars = document.getElementById("statChars");
const statCost = document.getElementById("statCost");
const statEnhances = document.getElementById("statEnhances");

function renderStats() {
  if (statGenerations) statGenerations.textContent = String(stats.generations);
  if (statChars) statChars.textContent = stats.chars.toLocaleString();
  if (statCost) statCost.textContent = `$${stats.costUsd.toFixed(4)}`;
  if (statEnhances) statEnhances.textContent = String(stats.enhances);
}
renderStats();

function applyHistoryStats(rows, enhanceCount) {
  stats.generations = rows.length;
  stats.chars = rows.reduce((sum, r) => sum + (r.charsBilled || 0), 0);
  stats.costUsd = rows.reduce((sum, r) => sum + costFor(r.charsBilled || 0, r.modelId), 0);
  stats.enhances = enhanceCount || 0;
  renderStats();
}

async function refreshStats() {
  try {
    const { history: rows, enhanceCount } = await api.getHistory();
    applyHistoryStats(rows, enhanceCount);
  } catch {
    /* keep last-known stats on a transient failure */
  }
}

// Restore this session's persisted renders (survive reloads and restarts)
// and seed the Costs stats from the same fetch.
api
  .getHistory()
  .then(({ history: rows, enhanceCount, likedRenderIds }) => {
    // Add oldest-first so the newest ends up on top after each unshift.
    for (const r of [...rows].reverse()) {
      history.add({
        renderId: r.renderId,
        voiceId: r.voiceId,
        displayName: r.voiceName,
        audioUrl: r.audioUrl,
        text: r.text.length > 60 ? r.text.slice(0, 60) + "…" : r.text,
      });
    }
    if (likedRenderIds?.length) {
      history.setLikedIds(likedRenderIds);
    }
    applyHistoryStats(rows, enhanceCount);
  })
  .catch(() => {});

const calcChars = document.getElementById("calcChars");
const calcResults = document.getElementById("calcResults");
function renderCalc() {
  if (!calcChars || !calcResults) return;
  const n = Math.max(0, Number(calcChars.value) || 0);
  calcResults.innerHTML = "";
  for (const modelId of Object.keys(RATE_PER_MILLION)) {
    const cost = costFor(n, modelId);
    const span = document.createElement("span");
    span.className = "calc-result";
    const b = document.createElement("b");
    b.textContent = `$${cost.toFixed(4)}`;
    span.append(`${modelId}: `, b);
    calcResults.appendChild(span);
  }
}
calcChars?.addEventListener("input", renderCalc);
renderCalc();

// ---- Advanced delivery controls (Model / Delivery segmented pickers) -----------
// Built ahead of the voice catalog fetch — they don't depend on it — then
// threaded into the composer once it's constructed below.

const modelControl = createSegmented({
  container: document.getElementById("modelSeg"),
  options: [
    { value: "inworld-tts-1.5-max", label: "1.5-max" },
    { value: "inworld-tts-1.5-mini", label: "1.5-mini" },
    { value: "inworld-tts-2", label: "tts-2" },
  ],
  value: "inworld-tts-1.5-max",
});
const deliveryControl = createSegmented({
  container: document.getElementById("deliverySeg"),
  options: [
    { value: "", label: "Default" },
    { value: "STABLE", label: "Stable" },
    { value: "BALANCED", label: "Balanced" },
    { value: "CREATIVE", label: "Creative" },
  ],
  value: "",
});

// ---- Voice catalog + two synced pickers ----------------------------------------

let composer = { loadHistoryEntry: () => {}, generate: () => {}, onVoiceChanged: () => {} };
let pickers = [];
let broadcastSelectionRef = () => {}; // set once pickers exist; used by clone.js's "Use this voice"

api
  .getVoices()
  .then(async (data) => {
    const voices = data?.voices || data?.result || [];
    if (!Array.isArray(voices) || !voices.length) {
      showToast("No voices returned by the catalog.");
      return;
    }

    document.querySelectorAll("#voiceCountStudio, #voiceCountVoices").forEach((el) => {
      el.textContent = String(voices.length);
    });

    function broadcastSelection(voice) {
      for (const p of pickers) if (p.setSelected) p.setSelected(voice.voiceId);
      // A voice switch no longer auto-regenerates: that used to bill a real
      // Inworld render on every click while browsing voices. It just updates
      // the dock so a regenerate is one explicit click away.
      composer.onVoiceChanged(voice);
    }
    broadcastSelectionRef = broadcastSelection;

    function onPreview(voice, btn, modelId) {
      previewController.toggle(voice, btn, modelId);
    }

    async function onDeleteVoice(voice) {
      try {
        await api.deleteCustomVoice(voice.voiceId);
        let fallback = null;
        for (const p of pickers) fallback = p.removeVoice(voice.voiceId) || fallback;
        if (fallback) composer.onVoiceChanged(fallback);
        updateVoiceCounts(-1);
        showToast(`Deleted "${voice.displayName}".`);
        return true;
      } catch (e) {
        showToast(`Couldn't delete: ${e.message}`);
        return false;
      }
    }

    async function onToggleLike(voice) {
      try {
        const result = await api.toggleLike({ itemType: "voice", itemId: voice.voiceId });
        // Sync the other picker's liked state
        for (const p of pickers) {
          // Each picker manages its own internal likedIds via the button click handler,
          // but we need to re-render the *other* picker to reflect the change.
        }
        return result;
      } catch (e) {
        showToast(`Couldn't toggle like: ${e.message}`);
        return null;
      }
    }

    // Fetch liked voice IDs for initial render
    let initialLikedVoiceIds = [];
    try {
      const likesData = await api.getLikes("voice");
      initialLikedVoiceIds = likesData?.likes || [];
    } catch { /* proceed without liked state */ }

    const studioPicker = createVoicePicker({
      root: document.getElementById("studioVoicePanel"),
      voices,
      mode: "list",
      initialSelectedId: voices[0].voiceId,
      onSelect: broadcastSelection,
      onPreview,
      onDeleteVoice,
      onToggleLike: async (voice) => {
        const result = await onToggleLike(voice);
        if (result) {
          // Sync the other picker — find all like buttons for this voice and update them
          for (const p of pickers) {
            if (p !== studioPicker) {
              const ids = result.liked
                ? [...initialLikedVoiceIds, voice.voiceId]
                : initialLikedVoiceIds.filter((id) => id !== voice.voiceId);
              // We'll just re-set on both pickers after the toggle
            }
          }
          // Update the shared tracked set
          if (result.liked) {
            if (!initialLikedVoiceIds.includes(voice.voiceId)) initialLikedVoiceIds.push(voice.voiceId);
          } else {
            initialLikedVoiceIds = initialLikedVoiceIds.filter((id) => id !== voice.voiceId);
          }
          // Sync all pickers
          for (const p of pickers) p.setLikedIds(initialLikedVoiceIds);
        }
        return result;
      },
      getModelId: () => modelControl.getValue(),
      initialLikedIds: initialLikedVoiceIds,
    });
    const gridPicker = createVoicePicker({
      root: document.getElementById("voicesGridPanel"),
      voices,
      mode: "grid",
      initialSelectedId: voices[0].voiceId,
      onSelect: broadcastSelection,
      onPreview,
      onDeleteVoice,
      onToggleLike: async (voice) => {
        const result = await onToggleLike(voice);
        if (result) {
          if (result.liked) {
            if (!initialLikedVoiceIds.includes(voice.voiceId)) initialLikedVoiceIds.push(voice.voiceId);
          } else {
            initialLikedVoiceIds = initialLikedVoiceIds.filter((id) => id !== voice.voiceId);
          }
          for (const p of pickers) p.setLikedIds(initialLikedVoiceIds);
        }
        return result;
      },
      getModelId: () => modelControl.getValue(),
      initialLikedIds: initialLikedVoiceIds,
    });
    pickers = [studioPicker, gridPicker];

    composer = initComposer({
      scriptEl: document.getElementById("scriptText"),
      counterEl: document.getElementById("scriptCount"),
      tagButtons: [...document.querySelectorAll("[data-tag-group] .pill")],
      directionInput: document.getElementById("directionInput"),
      directionPresets: [...document.querySelectorAll("[data-direction-presets] .pill")],
      enhanceBtn: document.getElementById("enhanceBtn"),
      modelControl,
      deliveryControl,
      speedInput: document.getElementById("speedInput"),
      temperatureInput: document.getElementById("tempInput"),
      advancedSummary: document.getElementById("advancedSummary"),
      dockPlayBtn: document.getElementById("dockPlay"),
      downloadLink: document.getElementById("downloadLink"),
      regenBtn: document.getElementById("regenBtn"),
      dockMetaLabel: document.getElementById("dockMetaLabel"),
      dockMetaUsage: document.getElementById("dockMetaUsage"),
      dockMetaEstimate: document.getElementById("dockMetaEstimate"),
      getVoice: () => studioPicker.getSelected(),
      player,
      ripple,
      history,
      setBusy,
      onError: showToast,
      onUsage: () => refreshStats(),
      onEnhanceUsed: () => refreshStats(),
    });
  })
  .catch((e) => showToast(`Couldn't load voices: ${e.message}`));

// ---- Voice cloning --------------------------------------------------------------

initClone({
  recordBtn: document.getElementById("recordBtn"),
  recMeter: document.getElementById("recMeter"),
  recordTimer: document.getElementById("recordTimer"),
  fileDrop: document.getElementById("fileDrop"),
  fileInput: document.getElementById("cloneFile"),
  fileDropIdle: document.getElementById("fileDropIdle"),
  fileDropFilled: document.getElementById("fileDropFilled"),
  fileDropName: document.getElementById("fileDropName"),
  fileDropSize: document.getElementById("fileDropSize"),
  fileDropRemove: document.getElementById("fileDropRemove"),
  previewBlock: document.getElementById("clonePreviewBlock"),
  previewPlayBtn: document.getElementById("clonePreviewPlay"),
  previewWave: document.getElementById("clonePreviewWave"),
  previewTime: document.getElementById("clonePreviewTime"),
  previewDuration: document.getElementById("clonePreviewDuration"),
  rerecordBtn: document.getElementById("cloneRerecordBtn"),
  nameInput: document.getElementById("cloneName"),
  langInput: document.getElementById("cloneLang"),
  transcriptInput: document.getElementById("cloneTranscript"),
  cloneBtn: document.getElementById("cloneBtn"),
  cloneStatus: document.getElementById("cloneStatus"),
  successActions: document.getElementById("cloneSuccessActions"),
  successPreviewBtn: document.getElementById("cloneSuccessPreview"),
  successUseBtn: document.getElementById("cloneSuccessUse"),
  offcanvasEl: document.getElementById("cloneOffcanvas"),
  onError: showToast,
  onCloned: (voice) => {
    showToast(`Cloned "${voice.displayName}". It's now in your voice list.`);
    for (const p of pickers) p.addVoice?.(voice);
    updateVoiceCounts(1);
  },
  onPreviewRequest: (voice, btn) => previewController.toggle(voice, btn, modelControl.getValue()),
  onUseVoice: (voice) => broadcastSelectionRef(voice),
});

// ---- Keyboard shortcuts ---------------------------------------------------------

document.addEventListener("keydown", (e) => {
  const typingInField = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const active = document.querySelector(".view.active");
    active?.querySelector('[data-role="voice-search"]')?.focus();
    return;
  }
  if (!typingInField && e.key === "/") {
    e.preventDefault();
    showView("studio");
    document.getElementById("scriptText")?.focus();
    return;
  }
  if (!typingInField && ["1", "2", "3"].includes(e.key)) {
    const names = ["studio", "voices", "costs"];
    showView(names[Number(e.key) - 1]);
  }
});
