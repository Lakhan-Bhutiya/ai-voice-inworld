// Waveform player. Decodes the synth response's dataUrl via Web Audio, draws
// real peaks to a canvas, and drives playback through a hidden <audio>
// element (simpler than managing an AudioBufferSourceNode's own clock).
//
// Lives inside the dark player dock, which uses theme-constant --block-*
// tokens — so unlike page-level canvases, this one never needs a repaint on
// theme flip; its colors don't change.

const BAR_GAP = 2;
const BAR_MIN_HEIGHT = 0.06;

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function createPlayer({ canvas, playBtn, timeCurrent, timeTotal }) {
  const ctx = canvas.getContext("2d");
  const audioEl = new Audio();
  let audioCtx = null;
  let peaks = null; // null => decode failed or nothing loaded; fall back to a flat progress bar
  let duration = 0;
  let isPlaying = false;
  let rafId = null;
  let dormant = true;

  function colors() {
    const s = getComputedStyle(document.documentElement);
    return {
      accent: s.getPropertyValue("--block-accent").trim() || "#a3e635",
      dim: s.getPropertyValue("--block-ink-3").trim() || "rgba(245,245,240,.38)",
    };
  }

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    return { w: canvas.width, h: canvas.height };
  }

  function drawBars(barValues, progressFraction) {
    const { w, h } = sizeCanvas();
    const c = colors();
    ctx.clearRect(0, 0, w, h);
    const n = barValues.length;
    const barWidth = w / n - BAR_GAP;
    const progressIndex = Math.floor(progressFraction * n);
    for (let i = 0; i < n; i++) {
      const value = Math.max(barValues[i], BAR_MIN_HEIGHT);
      const barHeight = value * h;
      const x = i * (barWidth + BAR_GAP);
      const y = (h - barHeight) / 2;
      ctx.fillStyle = i <= progressIndex ? c.accent : c.dim;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, Math.max(barWidth, 1), barHeight, 2);
      else ctx.rect(x, y, Math.max(barWidth, 1), barHeight);
      ctx.fill();
    }
  }

  function currentProgressFraction() {
    if (!duration) return 0;
    return Math.min(1, audioEl.currentTime / duration);
  }

  function redraw() {
    const frac = currentProgressFraction();
    drawBars(peaks || dormantBars, frac);
  }

  function tick() {
    if (timeCurrent) timeCurrent.textContent = formatTime(audioEl.currentTime);
    redraw();
    if (isPlaying) rafId = requestAnimationFrame(tick);
  }

  // --- dormant (idle, no audio yet) ---
  const dormantBars = Array.from({ length: 48 }, () => 0.1 + Math.random() * 0.05);
  function showDormant() {
    dormant = true;
    peaks = null;
    duration = 0;
    if (timeCurrent) timeCurrent.textContent = "0:00";
    if (timeTotal) timeTotal.textContent = "0:00";
    setPlayIcon(false);
    drawBars(dormantBars, 0);
  }

  // Peaks are averaged absolute-sample energy per bucket, which for spoken
  // word audio tops out well under 1.0 (~0.1 in practice) — normalizing
  // against the clip's own max is required or the waveform renders as a
  // near-flat line.
  async function computePeaks(dataUrl, bucketCount) {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    const res = await fetch(dataUrl);
    const buf = await res.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(buf);
    const channel = decoded.getChannelData(0);
    const bucketSize = Math.floor(channel.length / bucketCount) || 1;
    const values = new Array(bucketCount).fill(0);
    for (let i = 0; i < bucketCount; i++) {
      let sum = 0;
      const start = i * bucketSize;
      const end = Math.min(start + bucketSize, channel.length);
      for (let j = start; j < end; j++) sum += Math.abs(channel[j]);
      values[i] = end > start ? sum / (end - start) : 0;
    }
    const max = Math.max(...values, 0.0001);
    return { values: values.map((v) => v / max), duration: decoded.duration };
  }

  async function load(dataUrl) {
    dormant = false;
    audioEl.pause();
    isPlaying = false;
    setPlayIcon(false);
    audioEl.src = dataUrl;

    const bucketCount = Math.max(24, Math.floor(canvas.getBoundingClientRect().width / 6));
    try {
      const decoded = await computePeaks(dataUrl, bucketCount);
      peaks = decoded.values;
      duration = decoded.duration;
    } catch {
      peaks = null;
      await new Promise((resolve) => {
        audioEl.addEventListener("loadedmetadata", resolve, { once: true });
        audioEl.load();
      });
      duration = audioEl.duration || 0;
    }
    if (timeTotal) timeTotal.textContent = formatTime(duration);
    if (timeCurrent) timeCurrent.textContent = "0:00";
    redraw();
    return duration;
  }

  function setPlayIcon(playing) {
    if (!playBtn) return;
    const icon = playBtn.querySelector("i");
    if (icon) icon.className = playing ? "fa-solid fa-pause" : "fa-solid fa-play";
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function play() {
    if (dormant) return;
    audioEl.play().catch(() => {});
  }
  function pause() {
    audioEl.pause();
  }
  function togglePlay() {
    if (dormant) return;
    if (audioEl.paused) play();
    else pause();
  }

  audioEl.addEventListener("play", () => {
    isPlaying = true;
    setPlayIcon(true);
    tick();
  });
  audioEl.addEventListener("pause", () => {
    isPlaying = false;
    setPlayIcon(false);
    if (rafId) cancelAnimationFrame(rafId);
  });
  audioEl.addEventListener("ended", () => {
    audioEl.currentTime = 0;
    isPlaying = false;
    setPlayIcon(false);
    if (rafId) cancelAnimationFrame(rafId);
    redraw();
    if (timeCurrent) timeCurrent.textContent = "0:00";
  });

  canvas.addEventListener("click", (e) => {
    if (dormant || !duration) return;
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audioEl.currentTime = fraction * duration;
    redraw();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 120);
  });

  showDormant();

  return {
    showDormant,
    load,
    play,
    pause,
    togglePlay,
    isPlaying: () => isPlaying,
    isDormant: () => dormant,
    getAudioUrl: () => audioEl.src,
    // Exposed so another feature can draw its own thing on this canvas from
    // the same source data (e.g. clone.js's cloning-in-progress scan, drawn
    // over the sample's own waveform instead of a generic spinner) without
    // re-decoding the audio a second time.
    getPeaks: () => peaks,
    redraw,
  };
}
