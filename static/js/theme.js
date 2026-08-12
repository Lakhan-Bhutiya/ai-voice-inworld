// Light-default theme with persisted dark toggle. Sets data-bs-theme on
// <html> so Bootstrap's own dark-mode variables flip alongside ours. Two
// toggle buttons exist (rail + mobile bottom nav) and stay in sync.

const STORAGE_KEY = "aivoice-inworld.theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-bs-theme", theme);
  document.querySelectorAll(".theme-toggle-btn").forEach((btn) => {
    const icon = btn.querySelector("i");
    if (icon) icon.className = theme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  });
  // Canvas pixels are baked at draw time and don't repaint themselves when CSS
  // custom properties change, so anything drawing to a <canvas> off our tokens
  // needs an explicit signal to redraw.
  window.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
}

export function initTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  const theme = stored || "light";
  applyTheme(theme);

  document.querySelectorAll(".theme-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      applyTheme(next);
      btn.classList.remove("spin");
      void btn.offsetWidth;
      btn.classList.add("spin");
    });
  });
}
