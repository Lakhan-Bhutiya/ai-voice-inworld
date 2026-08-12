import { initTheme } from "./theme.js";
import * as api from "./api.js";
import { createVoicePicker } from "./voices.js";
import { createPlayer } from "./player.js";
import { createRipple } from "./ripple.js";
import { createHistory } from "./history.js";
import { initComposer } from "./composer.js";

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

// ---- Session history (in-memory only) ------------------------------------------

const history = createHistory({
  container: document.getElementById("historyStrip"),
  onSelect: (entry) => composer.loadHistoryEntry(entry),
});
const historyLabel = document.getElementById("historyLabel");
const origHistoryAdd = history.add.bind(history);
history.add = (entry) => {
  origHistoryAdd(entry);
  if (historyLabel) historyLabel.style.display = "";
};

// ---- Costs / session stats -----------------------------------------------------

const RATE_PER_MILLION = {
  "inworld-tts-1.5-max": 10,
  "inworld-tts-1.5-mini": 15,
  "inworld-tts-2": 5,
};

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

function recordUsage(usage) {
  if (!usage || typeof usage.processedCharactersCount !== "number") return;
  stats.generations += 1;
  stats.chars += usage.processedCharactersCount;
  const rate = RATE_PER_MILLION[usage.modelId] ?? RATE_PER_MILLION["inworld-tts-1.5-max"];
  stats.costUsd += (usage.processedCharactersCount / 1_000_000) * rate;
  renderStats();
}
function recordEnhance() {
  stats.enhances += 1;
  renderStats();
}

const calcChars = document.getElementById("calcChars");
const calcResults = document.getElementById("calcResults");
function renderCalc() {
  if (!calcChars || !calcResults) return;
  const n = Math.max(0, Number(calcChars.value) || 0);
  calcResults.innerHTML = "";
  for (const [modelId, rate] of Object.entries(RATE_PER_MILLION)) {
    const cost = (n / 1_000_000) * rate;
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

// ---- Voice catalog + two synced pickers ----------------------------------------

let composer = { loadHistoryEntry: () => {}, generate: () => {} };

api
  .getVoices()
  .then((data) => {
    const voices = data?.voices || data?.result || [];
    if (!Array.isArray(voices) || !voices.length) {
      showToast("No voices returned by the catalog.");
      return;
    }

    const pickers = [];
    function broadcastSelection(voice) {
      for (const p of pickers) if (p.setSelected) p.setSelected(voice.voiceId);
      // Audio already exists for this session — treat a voice change as
      // "redo this line in the new voice" rather than requiring an explicit
      // regenerate click. Before any first generation (dormant), there's no
      // audio to update, so just record the selection and don't bill yet.
      if (!player.isDormant()) composer.generate();
    }

    const studioPicker = createVoicePicker({
      root: document.getElementById("studioVoicePanel"),
      voices,
      mode: "list",
      initialSelectedId: voices[0].voiceId,
      onSelect: broadcastSelection,
    });
    const gridPicker = createVoicePicker({
      root: document.getElementById("voicesGridPanel"),
      voices,
      mode: "grid",
      initialSelectedId: voices[0].voiceId,
      onSelect: broadcastSelection,
    });
    pickers.push(studioPicker, gridPicker);

    composer = initComposer({
      scriptEl: document.getElementById("scriptText"),
      counterEl: document.getElementById("scriptCount"),
      tagButtons: [...document.querySelectorAll("[data-tag-group] .pill")],
      directionInput: document.getElementById("directionInput"),
      directionPresets: [...document.querySelectorAll("[data-direction-presets] .pill")],
      enhanceBtn: document.getElementById("enhanceBtn"),
      modelSelect: document.getElementById("modelSelect"),
      dockPlayBtn: document.getElementById("dockPlay"),
      downloadLink: document.getElementById("downloadLink"),
      regenBtn: document.getElementById("regenBtn"),
      dockMetaLabel: document.getElementById("dockMetaLabel"),
      dockMetaUsage: document.getElementById("dockMetaUsage"),
      getVoice: () => studioPicker.getSelected(),
      player,
      ripple,
      history,
      setBusy,
      onError: showToast,
      onUsage: recordUsage,
      onEnhanceUsed: recordEnhance,
    });
  })
  .catch((e) => showToast(`Couldn't load voices: ${e.message}`));

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
