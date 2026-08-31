import * as api from "./api.js";
import { createPlayer } from "./player.js";

// Voice cloning: record from the mic (with a live level meter) or drag/drop
// a file, preview the sample through the same waveform player the dock
// uses, then submit. All state resets when the offcanvas drawer closes so
// reopening it always starts clean.

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Elapsed-time captions during the clone request. Each names a real
// server-side phase; none claims a percentage — Inworld gives no progress
// signal on a single POST, so the wait is genuinely indeterminate.
const CLONE_CAPTIONS = [
  [0, "Uploading your sample…"],
  [4, "Analyzing timbre and pitch…"],
  [12, "Building the voice model…"],
  [45, "Still going — longer samples take a little more…"],
];
const SCAN_CYCLE_MS = 1800;

export function initClone({
  recordBtn, recMeter, recordTimer,
  fileDrop, fileInput, fileDropIdle, fileDropFilled, fileDropName, fileDropSize, fileDropRemove,
  previewBlock, previewPlayBtn, previewWave, previewTime, previewDuration, rerecordBtn,
  nameInput, langInput, transcriptInput,
  cloneBtn, cloneStatus,
  successActions, successPreviewBtn, successUseBtn,
  offcanvasEl,
  onCloned,
  onPreviewRequest,
  onUseVoice,
  onError,
}) {
  let sample = null; // { blob, filename }
  let mediaRecorder = null;
  let recTimerId = null;
  let recSeconds = 0;
  let meterCtx = null;
  let meterRafId = null;
  let previewPlayer = null;
  let scanRafId = null;
  let captionTimerId = null;

  function fmtTimer(s) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  // ---- level meter (mic input while recording) ----------------------------

  function startMeter(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    meterCtx = new AC();
    const src = meterCtx.createMediaStreamSource(stream);
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const ctx2d = recMeter.getContext("2d");
    const barCount = 24;

    function draw() {
      meterRafId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const rect = recMeter.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      recMeter.width = Math.max(1, Math.round(rect.width * dpr));
      recMeter.height = Math.max(1, Math.round(rect.height * dpr));
      const w = recMeter.width, h = recMeter.height;
      ctx2d.clearRect(0, 0, w, h);
      const step = Math.max(1, Math.floor(data.length / barCount));
      const barW = w / barCount - 2;
      const fill = getComputedStyle(document.documentElement).getPropertyValue("--rec").trim() || "#c8402a";
      ctx2d.fillStyle = fill;
      for (let i = 0; i < barCount; i++) {
        const v = data[i * step] / 255;
        const barH = Math.max(2, v * h);
        const x = i * (barW + 2);
        const y = (h - barH) / 2;
        ctx2d.fillRect(x, y, Math.max(barW, 1), barH);
      }
    }
    draw();
  }

  function stopMeter() {
    if (meterRafId) cancelAnimationFrame(meterRafId);
    meterRafId = null;
    if (meterCtx) {
      meterCtx.close().catch(() => {});
      meterCtx = null;
    }
  }

  // ---- recording ------------------------------------------------------------

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError?.("Recording isn't supported in this browser.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError?.("Microphone access denied.");
      return;
    }
    const chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stopMeter();
      stream.getTracks().forEach((t) => t.stop());
      recordBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Re-record';
      recordBtn.classList.remove("is-recording");
      recMeter.hidden = true;
      recordTimer.hidden = true;
      if (recSeconds < 5) onError?.("That sample is short — 5–15s clones best.");
      const blob = new Blob(chunks, { type: "audio/webm" });
      setSample(blob, "recording.webm");
    };
    mediaRecorder.start();
    recSeconds = 0;
    recordTimer.hidden = false;
    recordTimer.textContent = "0:00";
    recMeter.hidden = false;
    recordBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
    recordBtn.classList.add("is-recording");
    startMeter(stream);
    recTimerId = setInterval(() => {
      recSeconds += 1;
      recordTimer.textContent = fmtTimer(recSeconds);
      if (recSeconds >= 15) stopRecording(); // Inworld trims >15s anyway
    }, 1000);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    clearInterval(recTimerId);
  }

  recordBtn.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
    else startRecording();
  });
  rerecordBtn.addEventListener("click", startRecording);

  // ---- file drop --------------------------------------------------------------

  function updateFileDropUI(file) {
    if (file) {
      fileDrop.classList.add("has-file");
      fileDropIdle.hidden = true;
      fileDropFilled.hidden = false;
      fileDropName.textContent = file.name;
      fileDropSize.textContent = formatSize(file.size);
    } else {
      fileDrop.classList.remove("has-file");
      fileDropIdle.hidden = false;
      fileDropFilled.hidden = true;
    }
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) setSample(file, file.name);
  });

  ["dragenter", "dragover"].forEach((evt) => {
    fileDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      fileDrop.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    fileDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      fileDrop.classList.remove("drag-over");
    });
  });
  fileDrop.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files; // keep the real input in sync with the drop
    setSample(file, file.name);
  });
  fileDropRemove.addEventListener("click", (e) => {
    e.preventDefault(); // stop the wrapping <label> from reopening the file picker
    e.stopPropagation();
    clearSample();
  });

  // ---- shared sample state + waveform preview --------------------------------

  function ensurePreviewPlayer() {
    if (previewPlayer) return previewPlayer;
    previewPlayer = createPlayer({
      canvas: previewWave,
      playBtn: previewPlayBtn,
      timeCurrent: previewTime,
      timeTotal: previewDuration,
    });
    return previewPlayer;
  }

  // ---- cloning-in-progress: a scan sweeping across YOUR sample's own
  // waveform, not a generic spinner — reuses the peaks the preview player
  // already decoded. Loops (there's no real progress to report on a single
  // POST), then settles to fully-lit as a one-shot "done" flash on success.

  function drawScanFrame(peaks, sweepFraction) {
    const rect = previewWave.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    previewWave.width = Math.max(1, Math.round(rect.width * dpr));
    previewWave.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = previewWave.getContext("2d");
    const w = previewWave.width, h = previewWave.height;
    ctx.clearRect(0, 0, w, h);
    const bars = peaks && peaks.length ? peaks : Array.from({ length: 48 }, () => 0.3);
    const n = bars.length;
    const gap = 2;
    const barW = w / n - gap;
    const styles = getComputedStyle(document.documentElement);
    const lit = styles.getPropertyValue("--block-accent").trim() || "#a3e635";
    const dim = styles.getPropertyValue("--block-ink-3").trim() || "rgba(245,245,240,.38)";
    const sweepIndex = Math.floor(sweepFraction * n);
    for (let i = 0; i < n; i++) {
      const barH = Math.max(bars[i], 0.06) * h;
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      ctx.fillStyle = i <= sweepIndex ? lit : dim;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, Math.max(barW, 1), barH, 2);
      else ctx.rect(x, y, Math.max(barW, 1), barH);
      ctx.fill();
    }
  }

  function startScan() {
    const peaks = ensurePreviewPlayer().getPeaks();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      drawScanFrame(peaks, 1); // static "in progress" look, no sweep motion
      return;
    }
    const start = performance.now();
    const loop = (t) => {
      const fraction = ((t - start) % SCAN_CYCLE_MS) / SCAN_CYCLE_MS;
      drawScanFrame(peaks, fraction);
      scanRafId = requestAnimationFrame(loop);
    };
    scanRafId = requestAnimationFrame(loop);
  }

  function stopScan(success) {
    if (scanRafId) cancelAnimationFrame(scanRafId);
    scanRafId = null;
    if (!previewPlayer) return; // never started a scan — nothing to restore
    if (success) {
      drawScanFrame(previewPlayer.getPeaks(), 1); // brief "all lit" completion flash
      setTimeout(() => previewPlayer.redraw(), 650);
    } else {
      previewPlayer.redraw(); // back to the plain waveform — sample is still editable
    }
  }

  function startCaptions() {
    let elapsed = 0;
    const update = () => {
      let text = CLONE_CAPTIONS[0][1];
      for (const [threshold, label] of CLONE_CAPTIONS) {
        if (elapsed >= threshold) text = label;
      }
      cloneStatus.textContent = text;
      elapsed += 1;
    };
    update();
    captionTimerId = setInterval(update, 1000);
  }

  function stopCaptions() {
    clearInterval(captionTimerId);
    captionTimerId = null;
  }

  async function setSample(blob, filename) {
    sample = { blob, filename };
    const isFile = blob instanceof File;
    updateFileDropUI(isFile ? blob : null);
    if (!isFile) fileInput.value = "";

    previewBlock.hidden = false;
    const url = URL.createObjectURL(blob);
    await ensurePreviewPlayer().load(url);
  }

  function clearSample() {
    sample = null;
    fileInput.value = "";
    updateFileDropUI(null);
    previewBlock.hidden = true;
  }

  // ---- success actions --------------------------------------------------------

  function hideSuccessActions() {
    successActions.hidden = true;
  }

  function showSuccessActions(voice) {
    successActions.hidden = false;
    successPreviewBtn.onclick = () => onPreviewRequest?.(voice, successPreviewBtn);
    successUseBtn.onclick = () => {
      onUseVoice?.(voice);
      bootstrap.Offcanvas.getOrCreateInstance(offcanvasEl).hide();
    };
  }

  // ---- submit ------------------------------------------------------------------

  cloneBtn.addEventListener("click", async () => {
    if (!sample) return onError?.("Record or upload an audio sample first.");
    const displayName = nameInput.value.trim();
    if (!displayName) return onError?.("Give the voice a name.");
    const languageCode = langInput.value.trim() || "en-US";
    const transcription = transcriptInput.value.trim();

    const file = sample.blob instanceof File
      ? sample.blob
      : new File([sample.blob], sample.filename || "recording.webm", {
          type: sample.blob.type || "audio/webm",
        });

    cloneBtn.disabled = true;
    hideSuccessActions();
    startCaptions();
    startScan();
    try {
      const voice = await api.cloneVoice({ file, displayName, languageCode, transcription });
      stopScan(true);
      stopCaptions();
      cloneStatus.textContent = `"${voice.displayName}" is ready.`;
      onCloned?.(voice);
      showSuccessActions(voice);
    } catch (e) {
      stopScan(false);
      stopCaptions();
      cloneStatus.textContent = "";
      onError?.(`Clone failed: ${e.message}`);
    } finally {
      cloneBtn.disabled = false;
    }
  });

  // ---- reset when the drawer closes ---------------------------------------------

  offcanvasEl?.addEventListener("hidden.bs.offcanvas", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
    stopScan(false);
    stopCaptions();
    hideSuccessActions();
    clearSample();
    nameInput.value = "";
    langInput.value = "en-US";
    transcriptInput.value = "";
    cloneStatus.textContent = "";
    recordBtn.innerHTML = '<i class="fa-solid fa-microphone"></i> Record';
  });
}
