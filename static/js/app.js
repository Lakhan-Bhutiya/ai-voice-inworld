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

const logoutBtn = document.getElementById("logoutBtn");
logoutBtn?.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  try {
    await api.logout();
  } catch {
    /* clearing the cookie failed; the sign-in page will say so */
  }
  window.location.replace("/login");
});

api
  .getHealth()
  .then((data) => {
    // Only offer sign-out when the backend actually has a login configured.
    if (logoutBtn) logoutBtn.hidden = !data.authRequired;
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

// ---- Session history ------------------------------------------

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

// Restore this session's persisted renders (survive reloads and restarts).
api
  .getHistory()
  .then(({ history: rows }) => {
    // Add oldest-first so the newest ends up on top after each unshift.
    for (const r of [...rows].reverse()) {
      history.add({
        voiceId: r.voiceId,
        displayName: r.voiceName,
        audioUrl: r.audioUrl,
        text: r.text.length > 60 ? r.text.slice(0, 60) + "…" : r.text,
      });
    }
  })
  .catch(() => {});

// ---- Costs / session stats -----------------------------------------------------

const RATE_PER_MILLION = {
  "inworld-tts-1.5-max": 10,
  "inworld-tts-1.5-mini": 15,
  "inworld-tts-2": 5,
};

const stats = { generations: 0, chars: 0, costUsd: 0, enhances: 0 };
const allTime = { generations: 0, chars: 0, costUsd: 0, enhances: 0 };

const statEls = {
  generations: document.getElementById("statGenerations"),
  chars: document.getElementById("statChars"),
  cost: document.getElementById("statCost"),
  enhances: document.getElementById("statEnhances"),
  allGenerations: document.getElementById("statAllGenerations"),
  allChars: document.getElementById("statAllChars"),
  allCost: document.getElementById("statAllCost"),
  allEnhances: document.getElementById("statAllEnhances"),
};

function renderStats() {
  if (statEls.generations) statEls.generations.textContent = String(stats.generations);
  if (statEls.chars) statEls.chars.textContent = stats.chars.toLocaleString();
  if (statEls.cost) statEls.cost.textContent = `$${stats.costUsd.toFixed(4)}`;
  if (statEls.enhances) statEls.enhances.textContent = String(stats.enhances);
  if (statEls.allGenerations) statEls.allGenerations.textContent = String(allTime.generations);
  if (statEls.allChars) statEls.allChars.textContent = allTime.chars.toLocaleString();
  if (statEls.allCost) statEls.allCost.textContent = `$${allTime.costUsd.toFixed(4)}`;
  if (statEls.allEnhances) statEls.allEnhances.textContent = String(allTime.enhances);
}
renderStats();

// Totals come from the backend, which logs every billable call to SQLite — so
// they're the same numbers after a reload, a restart, or a new browser tab.
function applyTotals(totals) {
  if (!totals) return;
  Object.assign(stats, totals.session);
  Object.assign(allTime, totals.allTime);
  renderStats();
}

api.getUsage().then(applyTotals).catch(() => {});

// The synthesize/enhance responses carry the refreshed totals with them, so a
// generation updates the Costs view without a second round trip.
const recordUsage = applyTotals;
const recordEnhance = applyTotals;

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
      speedInput: document.getElementById("speedInput"),
      temperatureInput: document.getElementById("tempInput"),
      deliverySelect: document.getElementById("deliverySelect"),
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

// ---- Voice cloning --------------------------------------------------------------

// In-browser mic recording. The raw MediaRecorder output is lossy webm/opus,
// which clones poorly — so we decode it and re-encode to clean 16-bit PCM WAV
// (mono, 24 kHz) before upload. We also show a fixed line to read aloud and use
// it as the transcription, which markedly improves clone fidelity.
// ~11-13s read aloud — stays under Inworld's 15s trim so audio and transcript match.
const READ_PROMPT =
  "I enjoy reading a good book on a quiet Sunday morning, and I often take a long " +
  "walk by the river whenever the weather turns nice and warm.";

let recordedBlob = null;       // a WAV blob once recording finishes
let recordedIsFromMic = false; // vs. an uploaded file
let mediaRecorder = null;
let recTimerId = null;
let recSeconds = 0;
const recordBtn = document.getElementById("recordBtn");
const recordTimer = document.getElementById("recordTimer");
const recordPreview = document.getElementById("recordPreview");
const readPromptText = document.getElementById("readPromptText");
if (readPromptText) readPromptText.textContent = READ_PROMPT;

// Encode an AudioBuffer's first channel as a 16-bit PCM mono WAV blob.
function encodeWav(audioBuffer, sampleRate) {
  const samples = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

// Decode a recorded blob and resample to clean mono 24 kHz WAV.
async function toCleanWav(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmp.decodeAudioData(arrayBuf);
  await tmp.close();
  const rate = 24000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered, rate);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  clearInterval(recTimerId);
  if (recordBtn) recordBtn.classList.remove("is-recording");
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return showToast("Recording isn't supported in this browser.");
  }
  let stream;
  try {
    // Preserve the true voice: keep echo cancellation / AGC off, light noise suppression.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: true,
      },
    });
  } catch {
    return showToast("Microphone access denied.");
  }
  const chunks = [];
  mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 128000 });
  mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    if (recordBtn) recordBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Re-record';
    try {
      recordedBlob = await toCleanWav(new Blob(chunks, { type: "audio/webm" }));
      recordedIsFromMic = true;
      if (recordPreview) {
        recordPreview.src = URL.createObjectURL(recordedBlob);
        recordPreview.style.display = "";
      }
    } catch {
      showToast("Couldn't process the recording — try uploading a WAV instead.");
      recordedBlob = null;
    }
    if (recSeconds < 5) showToast("That sample is short — read the full line (5–15s) for a better clone.");
  };
  mediaRecorder.start();
  recSeconds = 0;
  if (recordTimer) recordTimer.textContent = "0s";
  if (recordBtn) {
    recordBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
    recordBtn.classList.add("is-recording");
  }
  recTimerId = setInterval(() => {
    recSeconds += 1;
    if (recordTimer) recordTimer.textContent = `${recSeconds}s`;
    if (recSeconds >= 20) stopRecording();
  }, 1000);
}

recordBtn?.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});

const cloneBtn = document.getElementById("cloneBtn");
const cloneStatus = document.getElementById("cloneStatus");
cloneBtn?.addEventListener("click", async () => {
  // Prefer a fresh recording (already clean WAV); fall back to an uploaded file.
  const file = recordedBlob
    ? new File([recordedBlob], "recording.wav", { type: "audio/wav" })
    : document.getElementById("cloneFile")?.files?.[0];
  const displayName = document.getElementById("cloneName")?.value.trim();
  const languageCode = document.getElementById("cloneLang")?.value.trim() || "en-US";
  // If they recorded and left transcription blank, assume they read the prompt.
  let transcription = document.getElementById("cloneTranscript")?.value.trim() || "";
  if (!transcription && recordedIsFromMic) transcription = READ_PROMPT;
  if (!file) return showToast("Record or upload an audio sample first.");
  if (!displayName) return showToast("Give the voice a name.");

  cloneBtn.disabled = true;
  if (cloneStatus) cloneStatus.textContent = "Cloning… this can take a moment.";
  try {
    const voice = await api.cloneVoice({ file, displayName, languageCode, transcription });
    if (cloneStatus) cloneStatus.textContent = `✓ "${voice.displayName}" added. Reloading…`;
    showToast(`Cloned "${voice.displayName}". It's now in your voice list.`);
    setTimeout(() => location.reload(), 1200); // rebuild pickers with the new voice
  } catch (e) {
    if (cloneStatus) cloneStatus.textContent = "";
    showToast(`Clone failed: ${e.message}`);
  } finally {
    cloneBtn.disabled = false;
  }
});

// ---- Delivery control slider labels --------------------------------------------

const speedInput = document.getElementById("speedInput");
const speedVal = document.getElementById("speedVal");
speedInput?.addEventListener("input", () => {
  if (speedVal) speedVal.textContent = `${parseFloat(speedInput.value).toFixed(1)}×`;
});
const tempInput = document.getElementById("tempInput");
const tempVal = document.getElementById("tempVal");
tempInput?.addEventListener("input", () => {
  if (tempVal) tempVal.textContent = parseFloat(tempInput.value).toFixed(1);
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
