// Faceted voice browser over the real Inworld catalog (281 voices at last
// check: 158 en, 34 es, 21 ru, 17 de, ...). Two instances share this module —
// a compact list in the Studio panel and a full card grid in the Voices view
// — so all voice-derived strings are set via textContent (not innerHTML):
// they come from a third-party API response, not something to trust blindly.

const LIST_CAP = 40; // cap rendered rows in compact mode; full set stays searchable

function countBy(voices, getKeys) {
  const counts = new Map();
  for (const v of voices) {
    for (const key of getKeys(v)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function createVoicePicker({ root, voices, mode = "list", onSelect, initialSelectedId }) {
  const searchInput = root.querySelector('[data-role="voice-search"]');
  const langFacetEl = root.querySelector('[data-role="facets-lang"]');
  const tagFacetEl = root.querySelector('[data-role="facets-tag"]');
  const listEl = root.querySelector('[data-role="voice-list"]');
  const countEl = root.querySelector('[data-role="voice-count"]');

  let query = "";
  let activeLang = null;
  let activeTag = null;
  let selectedId = initialSelectedId || voices[0]?.voiceId || null;
  let filtered = voices;

  const langCounts = countBy(voices, (v) => v.languages || []).slice(0, 8);
  const tagCounts = countBy(voices, (v) => v.tags || []).slice(0, 10);

  function pill(label, count, active, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill" + (active ? " active" : "");
    const labelSpan = document.createTextNode(label + " ");
    btn.appendChild(labelSpan);
    const countSpan = document.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = String(count);
    btn.appendChild(countSpan);
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderFacets() {
    if (langFacetEl) {
      langFacetEl.innerHTML = "";
      langFacetEl.appendChild(
        pill("all", voices.length, activeLang === null, () => {
          activeLang = null;
          renderFacets();
          applyFilter();
        })
      );
      for (const [lang, count] of langCounts) {
        langFacetEl.appendChild(
          pill(lang, count, activeLang === lang, () => {
            activeLang = activeLang === lang ? null : lang;
            renderFacets();
            applyFilter();
          })
        );
      }
    }
    if (tagFacetEl) {
      tagFacetEl.innerHTML = "";
      for (const [tag, count] of tagCounts) {
        tagFacetEl.appendChild(
          pill(tag, count, activeTag === tag, () => {
            activeTag = activeTag === tag ? null : tag;
            renderFacets();
            applyFilter();
          })
        );
      }
    }
  }

  function applyFilter() {
    filtered = voices.filter((v) => {
      if (activeLang && !(v.languages || []).includes(activeLang)) return false;
      if (activeTag && !(v.tags || []).includes(activeTag)) return false;
      if (query) {
        const hay = `${v.displayName} ${v.description} ${(v.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    render();
  }

  function buildRow(voice, index) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = (mode === "grid" ? "voice-card" : "voice-row") + " enter";
    el.style.animationDelay = `${Math.min(index, 12) * 16}ms`;
    el.setAttribute("role", "option");
    el.dataset.voiceId = voice.voiceId;
    if (voice.voiceId === selectedId) {
      el.classList.add("selected");
      el.setAttribute("aria-selected", "true");
    }

    const avatar = document.createElement("span");
    avatar.className = "voice-avatar";
    avatar.textContent = (voice.displayName || "?").charAt(0).toUpperCase();
    avatar.setAttribute("aria-hidden", "true");

    const info = document.createElement("span");
    info.className = "voice-info";

    const top = document.createElement("span");
    top.className = "voice-info-top";
    const name = document.createElement("span");
    name.className = "voice-name";
    name.textContent = voice.displayName || voice.voiceId;
    const lang = document.createElement("span");
    lang.className = "voice-lang";
    lang.textContent = (voice.languages || []).join(", ");
    top.append(name, lang);

    const desc = document.createElement("span");
    desc.className = "voice-desc";
    desc.textContent = voice.description || "";

    info.append(top, desc);

    if (mode === "grid") {
      const tags = document.createElement("span");
      tags.className = "voice-card-tags";
      for (const t of (voice.tags || []).slice(0, 4)) {
        const chip = document.createElement("span");
        chip.className = "tag-chip-sm";
        chip.textContent = t;
        tags.appendChild(chip);
      }
      info.appendChild(tags);
      el.append(avatar, info);
    } else {
      const check = document.createElement("i");
      check.className = "voice-row-check fa-solid fa-check";
      check.setAttribute("aria-hidden", "true");
      el.append(avatar, info, check);
    }

    el.addEventListener("click", () => selectVoice(voice));
    return el;
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (countEl) countEl.textContent = `${filtered.length} of ${voices.length}`;

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "voice-empty";
      empty.textContent = "No voices match those filters.";
      listEl.appendChild(empty);
      return;
    }

    const cap = mode === "list" ? LIST_CAP : filtered.length;
    const shown = filtered.slice(0, cap);
    shown.forEach((v, i) => listEl.appendChild(buildRow(v, i)));

    if (filtered.length > cap) {
      const hint = document.createElement("div");
      hint.className = "voice-more-hint";
      hint.textContent = `+${filtered.length - cap} more — refine your search to narrow it down`;
      listEl.appendChild(hint);
    }
  }

  // `silent` skips onSelect — used by setSelected() to sync this instance's
  // highlight when a DIFFERENT picker instance was the one actually clicked.
  // Without it, two pickers sharing one onSelect callback that calls
  // setSelected() on each other recurses infinitely on every click.
  function selectVoice(voice, { silent = false } = {}) {
    selectedId = voice.voiceId;
    for (const child of listEl.children) {
      const isSel = child.dataset && child.dataset.voiceId === voice.voiceId;
      child.classList.toggle("selected", !!isSel);
      if (child.dataset) child.setAttribute("aria-selected", isSel ? "true" : "false");
    }
    if (!silent) onSelect?.(voice);
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      query = searchInput.value.trim().toLowerCase();
      applyFilter();
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        listEl?.querySelector("button")?.focus();
      }
    });
  }

  if (listEl) {
    listEl.setAttribute("role", "listbox");
    listEl.addEventListener("keydown", (e) => {
      const focused = document.activeElement;
      if (!focused || focused.parentElement !== listEl) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = focused.nextElementSibling;
        if (next && next.tagName === "BUTTON") next.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = focused.previousElementSibling;
        if (prev && prev.tagName === "BUTTON") prev.focus();
        else searchInput?.focus();
      }
    });
  }

  renderFacets();
  applyFilter();

  return {
    getSelected: () => voices.find((v) => v.voiceId === selectedId) || null,
    setSelected(voiceId) {
      const v = voices.find((x) => x.voiceId === voiceId);
      if (v) selectVoice(v, { silent: true });
    },
    focusSearch: () => searchInput?.focus(),
  };
}
