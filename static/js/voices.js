// Faceted voice browser over the real Inworld catalog (289 voices at last
// check: 166 en, 34 es, 21 ru, 17 de, ... — count drifts as voices are added
// or cloned, so the UI reads it live from the fetched list rather than
// hardcoding it). Two instances share this module —
// a compact list in the Studio panel and a full card grid in the Voices view
// — so all voice-derived strings are set via textContent (not innerHTML):
// they come from a third-party API response, not something to trust blindly.
//
// Each row/card is a non-interactive wrapper around a "select" button plus
// 1-2 action buttons (preview; delete for custom voices only) — siblings,
// never a nested <button>, which is invalid HTML and breaks click/focus.

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

export function createVoicePicker({
  root,
  voices,
  mode = "list",
  onSelect,
  initialSelectedId,
  onPreview,
  onDeleteVoice,
  onToggleLike,
  getModelId,
  initialLikedIds,
}) {
  // Own copy — two picker instances (Studio list + Voices grid) are commonly
  // constructed from the same source array, and addVoice()/removeVoice()
  // below mutate it.
  voices = [...voices];
  const searchInput = root.querySelector('[data-role="voice-search"]');
  const langFacetEl = root.querySelector('[data-role="facets-lang"]');
  const tagFacetEl = root.querySelector('[data-role="facets-tag"]');
  const listEl = root.querySelector('[data-role="voice-list"]');
  const countEl = root.querySelector('[data-role="voice-count"]');

  let query = "";
  let activeLang = null;
  let activeTag = null;
  let activeCustom = false;
  let selectedId = initialSelectedId || voices[0]?.voiceId || null;
  let filtered = voices;
  let likedIds = new Set(initialLikedIds || []);
  let activeLiked = false;

  let langCounts = countBy(voices, (v) => v.languages || []).slice(0, 8);
  let tagCounts = countBy(voices, (v) => v.tags || []).slice(0, 10);

  function pill(label, count, active, onClick, extraClass) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pill" + (active ? " active" : "") + (extraClass ? ` ${extraClass}` : "");
    const labelSpan = document.createTextNode(label + " ");
    btn.appendChild(labelSpan);
    const countSpan = document.createElement("span");
    countSpan.className = "count";
    countSpan.textContent = String(count);
    btn.appendChild(countSpan);
    btn.addEventListener("click", onClick);
    return btn;
  }

  let langDisclosureOpen = true;
  let tagDisclosureOpen = false;

  function renderFacets() {
    if (langFacetEl) {
      langFacetEl.innerHTML = "";
      // Quick filters row (always visible)
      langFacetEl.appendChild(
        pill("all", voices.length, activeLang === null && !activeCustom && !activeLiked && !activeTag, () => {
          activeLang = null;
          activeCustom = false;
          activeLiked = false;
          activeTag = null;
          renderFacets();
          applyFilter();
        })
      );
      const customCount = voices.filter((v) => v.isCustom).length;
      if (customCount > 0) {
        langFacetEl.appendChild(
          pill("◈ Custom", customCount, activeCustom, () => {
            activeCustom = !activeCustom;
            renderFacets();
            applyFilter();
          }, "pill-accent")
        );
      }
      const likedCount = voices.filter((v) => likedIds.has(v.voiceId)).length;
      if (likedCount > 0) {
        langFacetEl.appendChild(
          pill("♥ Liked", likedCount, activeLiked, () => {
            activeLiked = !activeLiked;
            renderFacets();
            applyFilter();
          }, "pill-liked")
        );
      }
    }

    if (tagFacetEl) {
      tagFacetEl.innerHTML = "";

      // Disclosure 1: Languages (open by default)
      const langDetails = document.createElement("details");
      langDetails.className = "disclosure filter-disclosure";
      if (langDisclosureOpen) langDetails.open = true;
      langDetails.addEventListener("toggle", () => {
        langDisclosureOpen = langDetails.open;
      });

      const langSummary = document.createElement("summary");
      langSummary.className = "disclosure-summary";

      const langLeft = document.createElement("span");
      langLeft.className = "disclosure-summary-left";
      langLeft.innerHTML = '<i class="fa-solid fa-chevron-right disclosure-chevron" aria-hidden="true"></i> Languages';

      const langVal = document.createElement("span");
      langVal.className = "disclosure-summary-value";
      langVal.textContent = activeLang ? activeLang.toUpperCase() : `${langCounts.length} languages`;

      langSummary.append(langLeft, langVal);

      const langBody = document.createElement("div");
      langBody.className = "disclosure-body facet-group";
      for (const [lang, count] of langCounts) {
        langBody.appendChild(
          pill(lang, count, activeLang === lang, () => {
            activeLang = activeLang === lang ? null : lang;
            renderFacets();
            applyFilter();
          })
        );
      }

      langDetails.append(langSummary, langBody);

      // Disclosure 2: Style & Use Case (closed by default)
      const tagDetails = document.createElement("details");
      tagDetails.className = "disclosure filter-disclosure";
      if (tagDisclosureOpen) tagDetails.open = true;
      tagDetails.addEventListener("toggle", () => {
        tagDisclosureOpen = tagDetails.open;
      });

      const tagSummary = document.createElement("summary");
      tagSummary.className = "disclosure-summary";

      const tagLeft = document.createElement("span");
      tagLeft.className = "disclosure-summary-left";
      tagLeft.innerHTML = '<i class="fa-solid fa-chevron-right disclosure-chevron" aria-hidden="true"></i> Style & Use Case';

      const tagVal = document.createElement("span");
      tagVal.className = "disclosure-summary-value";
      const defaultTagSummary = tagCounts.length > 2
        ? `${tagCounts[0][0]}, ${tagCounts[1][0]}, +${tagCounts.length - 2} more`
        : `${tagCounts.length} tags`;
      tagVal.textContent = activeTag ? activeTag : defaultTagSummary;

      tagSummary.append(tagLeft, tagVal);

      const tagBody = document.createElement("div");
      tagBody.className = "disclosure-body facet-group";
      for (const [tag, count] of tagCounts) {
        tagBody.appendChild(
          pill(tag, count, activeTag === tag, () => {
            activeTag = activeTag === tag ? null : tag;
            renderFacets();
            applyFilter();
          })
        );
      }

      tagDetails.append(tagSummary, tagBody);

      const rowContainer = document.createElement("div");
      rowContainer.className = mode === "grid" ? "filter-disclosure-row" : "filter-disclosure-stack";
      rowContainer.append(langDetails, tagDetails);

      tagFacetEl.append(rowContainer);
    }
  }

  function applyFilter() {
    filtered = voices.filter((v) => {
      if (activeCustom && !v.isCustom) return false;
      if (activeLiked && !likedIds.has(v.voiceId)) return false;
      if (activeLang && !(v.languages || []).includes(activeLang)) return false;
      if (activeTag && !(v.tags || []).includes(activeTag)) return false;
      if (query) {
        const hay = `${v.displayName || ""} ${v.description || ""} ${(v.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
    render();
  }

  // ---- action buttons (preview + delete) shared by both row and card modes ----

  function buildPreviewButton(voice) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-icon-btn voice-row-preview";
    btn.setAttribute("aria-label", "Play preview");
    btn.innerHTML = '<i class="fa-solid fa-play" aria-hidden="true"></i>';
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onPreview?.(voice, btn, getModelId?.() || "inworld-tts-1.5-max");
    });
    return btn;
  }

  function buildLikeButton(voice) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-icon-btn voice-like-btn" + (likedIds.has(voice.voiceId) ? " liked" : "");
    btn.setAttribute("aria-label", likedIds.has(voice.voiceId) ? "Unlike voice" : "Like voice");
    btn.innerHTML = `<i class="fa-${likedIds.has(voice.voiceId) ? "solid" : "regular"} fa-heart" aria-hidden="true"></i>`;
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const result = await onToggleLike?.(voice);
      if (result == null) return;
      if (result.liked) {
        likedIds.add(voice.voiceId);
      } else {
        likedIds.delete(voice.voiceId);
      }
      btn.classList.toggle("liked", result.liked);
      btn.setAttribute("aria-label", result.liked ? "Unlike voice" : "Like voice");
      btn.innerHTML = `<i class="fa-${result.liked ? "solid" : "regular"} fa-heart" aria-hidden="true"></i>`;
      // Re-render facets to update the liked count pill
      renderFacets();
      // If the liked filter is active and we just unliked, re-filter
      if (activeLiked && !result.liked) applyFilter();
    });
    return btn;
  }

  function buildDeleteButton(voice) {
    const wrap = document.createElement("span");
    wrap.className = "voice-row-delete-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-icon-btn voice-row-delete";
    btn.setAttribute("aria-label", `Delete "${voice.displayName}"`);
    btn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';

    function showConfirm() {
      const confirm = document.createElement("span");
      confirm.className = "voice-row-confirm";

      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "voice-row-confirm-yes";
      yes.textContent = "Delete";

      const no = document.createElement("button");
      no.type = "button";
      no.className = "voice-row-confirm-no";
      no.textContent = "Cancel";

      no.addEventListener("click", (e) => {
        e.stopPropagation();
        wrap.replaceChildren(btn);
      });
      yes.addEventListener("click", async (e) => {
        e.stopPropagation();
        yes.disabled = true;
        no.disabled = true;
        yes.textContent = "…";
        const ok = await onDeleteVoice?.(voice);
        if (!ok) wrap.replaceChildren(btn); // row survives — revert to idle
        // On success the row is removed by removeVoice()'s re-render.
      });

      confirm.append(yes, no);
      wrap.replaceChildren(confirm);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      showConfirm();
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function buildRow(voice, index) {
    const wrapper = document.createElement("div");
    wrapper.className = (mode === "grid" ? "voice-card" : "voice-row") + " enter";
    wrapper.style.animationDelay = `${Math.min(index, 12) * 16}ms`;
    wrapper.setAttribute("role", "listitem");
    wrapper.dataset.voiceId = voice.voiceId;
    if (voice.voiceId === selectedId) wrapper.classList.add("selected");

    const main = document.createElement("button");
    main.type = "button";
    main.className = mode === "grid" ? "voice-card-main" : "voice-row-main";
    main.setAttribute("aria-pressed", voice.voiceId === selectedId ? "true" : "false");

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
    if (voice.isCustom) {
      const badge = document.createElement("span");
      badge.className = "badge-custom";
      badge.textContent = "Custom";
      top.appendChild(badge);
    }

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
      main.append(avatar, info);
    } else {
      const check = document.createElement("i");
      check.className = "voice-row-check fa-solid fa-check";
      check.setAttribute("aria-hidden", "true");
      main.append(avatar, info, check);
    }

    main.addEventListener("click", () => selectVoice(voice));

    const actions = document.createElement("div");
    actions.className = mode === "grid" ? "voice-card-actions" : "voice-row-actions";
    actions.appendChild(buildLikeButton(voice));
    actions.appendChild(buildPreviewButton(voice));
    if (voice.isCustom) actions.appendChild(buildDeleteButton(voice));

    wrapper.append(main, actions);
    return wrapper;
  }

  // A quiet footer nudge toward cloning — the "moment of need" after
  // scanning the list. A real button (data-bs-toggle wires it to the same
  // offcanvas the two static triggers use, via Bootstrap's own delegated
  // click handling — no extra JS needed here).
  function buildListCta() {
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "voice-list-cta";
    cta.setAttribute("data-bs-toggle", "offcanvas");
    cta.setAttribute("data-bs-target", "#cloneOffcanvas");
    cta.setAttribute("aria-controls", "cloneOffcanvas");
    const q = document.createElement("span");
    q.className = "voice-list-cta-q";
    q.textContent = "Not hearing the right voice?";
    const action = document.createElement("span");
    action.className = "voice-list-cta-action";
    action.append("Clone your own ");
    const arrow = document.createElement("i");
    arrow.className = "fa-solid fa-arrow-right";
    arrow.setAttribute("aria-hidden", "true");
    action.appendChild(arrow);
    cta.append(q, action);
    return cta;
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (countEl) {
      const isFiltered = query || activeLang || activeTag || activeCustom || activeLiked;
      countEl.textContent = isFiltered
        ? `${filtered.length} of ${voices.length}`
        : `${voices.length} voices`;
    }

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "voice-empty";
      empty.textContent = "No voices match those filters.";
      listEl.appendChild(empty);
      listEl.appendChild(buildListCta());
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

    listEl.appendChild(buildListCta());
  }

  // `silent` skips onSelect — used by setSelected() to sync this instance's
  // highlight when a DIFFERENT picker instance was the one actually clicked.
  // Without it, two pickers sharing one onSelect callback that calls
  // setSelected() on each other recurses infinitely on every click.
  function selectVoice(voice, { silent = false } = {}) {
    selectedId = voice.voiceId;
    for (const wrapper of listEl.children) {
      if (!wrapper.dataset) continue;
      const isSel = wrapper.dataset.voiceId === voice.voiceId;
      wrapper.classList.toggle("selected", isSel);
      const mainBtn = wrapper.querySelector(".voice-row-main, .voice-card-main");
      mainBtn?.setAttribute("aria-pressed", isSel ? "true" : "false");
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
        listEl?.querySelector(".voice-row-main, .voice-card-main")?.focus();
      }
    });
  }

  if (listEl) {
    listEl.setAttribute("role", "list");
    listEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const mains = [...listEl.querySelectorAll(".voice-row-main, .voice-card-main")];
      const idx = mains.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      if (e.key === "ArrowDown") {
        mains[idx + 1]?.focus();
      } else if (idx === 0) {
        searchInput?.focus();
      } else {
        mains[idx - 1]?.focus();
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
    // Add a freshly-cloned voice without rebuilding the picker (which would
    // re-attach a second set of listeners onto the same long-lived search
    // input). Doesn't change the current selection — the user opts in.
    addVoice(voice) {
      voices = [voice, ...voices];
      langCounts = countBy(voices, (v) => v.languages || []).slice(0, 8);
      tagCounts = countBy(voices, (v) => v.tags || []).slice(0, 10);
      renderFacets();
      applyFilter();
      // The new voice lands first in `filtered` (unless an active language/
      // tag filter excludes it) — give it a one-shot highlight so it doesn't
      // just blend into the entrance animation every row gets.
      const row = listEl?.querySelector(`[data-voice-id="${CSS.escape(voice.voiceId)}"]`);
      if (row) {
        row.classList.add("highlight-new");
        row.addEventListener("animationend", () => row.classList.remove("highlight-new"), { once: true });
      }
    },
    // Remove a deleted voice. Returns the newly-selected voice if the
    // deleted one was the active selection (so the caller can update
    // whatever depends on "which voice is selected"), otherwise null.
    removeVoice(voiceId) {
      const wasSelected = selectedId === voiceId;
      voices = voices.filter((v) => v.voiceId !== voiceId);
      likedIds.delete(voiceId);
      langCounts = countBy(voices, (v) => v.languages || []).slice(0, 8);
      tagCounts = countBy(voices, (v) => v.tags || []).slice(0, 10);
      if (wasSelected) selectedId = voices[0]?.voiceId || null;
      renderFacets();
      applyFilter();
      return wasSelected ? (voices.find((v) => v.voiceId === selectedId) || null) : null;
    },
    setLikedIds(ids) {
      likedIds = new Set(ids);
      renderFacets();
      applyFilter();
    },
  };
}
