// Segmented control — replaces a native <select> for small enumerable
// choices (Model, Delivery mode) so they read as the same hand-drawn pill
// language as the rest of the app instead of OS chrome. role="radiogroup"
// over role="radio" buttons, with roving-tabindex arrow key navigation.

export function createSegmented({ container, options, value, onChange }) {
  let current = value ?? options[0]?.value ?? null;
  let disabled = false;
  const buttons = new Map();

  function render() {
    container.innerHTML = "";
    buttons.clear();
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seg-opt";
      btn.setAttribute("role", "radio");
      btn.textContent = opt.label;
      btn.dataset.value = opt.value;
      btn.disabled = disabled;
      btn.addEventListener("click", () => setValue(opt.value));
      buttons.set(opt.value, btn);
      container.appendChild(btn);
    }
    syncState();
  }

  function syncState() {
    for (const [val, btn] of buttons) {
      const isActive = val === current;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-checked", isActive ? "true" : "false");
      btn.tabIndex = isActive ? 0 : -1;
      btn.disabled = disabled;
    }
  }

  function setValue(v, { silent = false } = {}) {
    if (disabled || !options.some((o) => o.value === v)) return;
    current = v;
    syncState();
    if (!silent) {
      onChange?.(v);
      // A DOM-level event (not just the onChange callback) so code that
      // didn't construct this control — e.g. a wiring module assembled
      // after this one — can still react, regardless of whether the value
      // changed via mouse click or arrow-key navigation.
      container.dispatchEvent(new CustomEvent("change", { detail: { value: v } }));
    }
  }

  container.setAttribute("role", "radiogroup");
  container.addEventListener("keydown", (e) => {
    if (disabled) return;
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const idx = options.findIndex((o) => o.value === current);
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = options[(idx + dir + options.length) % options.length];
    setValue(next.value);
    buttons.get(next.value)?.focus();
  });

  render();

  return {
    getValue: () => current,
    setValue: (v) => setValue(v, { silent: true }),
    setDisabled(next) {
      disabled = next;
      syncState();
    },
    el: container,
  };
}
