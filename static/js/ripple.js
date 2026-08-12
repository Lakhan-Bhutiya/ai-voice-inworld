// Flat geometric sound-ripple, drawn around the dock's mic button while a
// synthesize request is in flight. Deliberately not the glow/particle-orb
// look — crisp expanding rings only, matching the flat reference aesthetic
// rather than reading as a generic "AI is thinking" spinner.

const RING_COUNT = 3;
const CYCLE_MS = 1400;
const START_RADIUS = 26;
const END_RADIUS = 46;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function createRipple(canvas) {
  const ctx = canvas.getContext("2d");
  const reduced = prefersReducedMotion();
  let rafId = null;
  let running = false;
  let startTime = 0;

  function accentColor() {
    const s = getComputedStyle(document.documentElement);
    return s.getPropertyValue("--block-accent").trim() || "#a3e635";
  }

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { w, h, dpr };
  }

  function draw(t) {
    const { w, h, dpr } = sizeCanvas();
    const cx = w / 2;
    const cy = h / 2;
    const color = accentColor();
    ctx.clearRect(0, 0, w, h);

    const elapsed = t - startTime;
    for (let i = 0; i < RING_COUNT; i++) {
      const offset = (i / RING_COUNT) * CYCLE_MS;
      const phase = ((elapsed + offset) % CYCLE_MS) / CYCLE_MS; // 0..1
      const radius = (START_RADIUS + (END_RADIUS - START_RADIUS) * phase) * dpr;
      const alpha = 1 - phase;
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    draw(t);
    if (running) rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    startTime = performance.now();
    if (reduced) return; // static mic icon alone is enough feedback
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    const { w, h } = sizeCanvas();
    ctx.clearRect(0, 0, w, h);
  }

  return { start, stop };
}
