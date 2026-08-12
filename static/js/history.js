// Session-only generation history — lives in memory, not localStorage or a
// database, and is labelled as such in the UI. Nothing here survives a
// reload; that's honest given the backend persists nothing either.

const MAX_ENTRIES = 20;

export function createHistory({ container, onSelect }) {
  const entries = [];

  function render() {
    if (!container) return;
    container.innerHTML = "";
    for (const entry of entries) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "history-item";

      const avatar = document.createElement("span");
      avatar.className = "voice-avatar";
      avatar.textContent = (entry.displayName || "?").charAt(0).toUpperCase();
      avatar.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "history-item-text";
      text.textContent = entry.text;

      const play = document.createElement("i");
      play.className = "history-item-play fa-solid fa-play";
      play.setAttribute("aria-hidden", "true");

      el.append(avatar, text, play);
      el.addEventListener("click", () => onSelect?.(entry));
      container.appendChild(el);
    }
  }

  return {
    add(entry) {
      entries.unshift(entry);
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
      render();
    },
    isEmpty: () => entries.length === 0,
  };
}
