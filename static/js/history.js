// Session generation history. Backed by the server (SQLite via db.py) so it
// survives reloads and restarts — this module just renders whatever entries
// it's given and reports back when the user acts on one (select or delete).

const MAX_ENTRIES = 20;

export function createHistory({ container, filterBar, onSelect, onDelete, onToggleLike }) {
  const entries = [];
  let likedIds = new Set();
  let filterLiked = false;

  function renderFilterBar() {
    if (!filterBar) return;
    filterBar.innerHTML = "";
    const likedCount = entries.filter((e) => likedIds.has(e.renderId)).length;
    if (likedCount === 0 && !filterLiked) return; // hide pill when nothing is liked

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill pill-liked" + (filterLiked ? " active" : "");
    const label = document.createTextNode("♥ Liked ");
    pill.appendChild(label);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(likedCount);
    pill.appendChild(count);
    pill.addEventListener("click", () => {
      filterLiked = !filterLiked;
      render();
    });
    filterBar.appendChild(pill);
  }

  function renderEmpty() {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = filterLiked
      ? "No liked renders yet — tap ♥ on a render to favourite it."
      : "No renders yet this session generate something to see it here.";
    container.appendChild(empty);
  }

  function render() {
    if (!container) return;
    container.innerHTML = "";
    renderFilterBar();

    const visible = filterLiked
      ? entries.filter((e) => likedIds.has(e.renderId))
      : entries;

    if (!visible.length) {
      renderEmpty();
      return;
    }
    for (const entry of visible) {
      const el = document.createElement("div");
      el.className = "history-item";

      const main = document.createElement("button");
      main.type = "button";
      main.className = "history-item-main";

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

      main.append(avatar, text, play);
      main.addEventListener("click", () => onSelect?.(entry));

      el.appendChild(main);

      // Like button
      if (entry.renderId) {
        const liked = likedIds.has(entry.renderId);
        const likeBtn = document.createElement("button");
        likeBtn.type = "button";
        likeBtn.className = "history-item-like" + (liked ? " liked" : "");
        likeBtn.setAttribute("aria-label", liked ? "Unlike render" : "Like render");
        likeBtn.innerHTML = `<i class="fa-${liked ? "solid" : "regular"} fa-heart" aria-hidden="true"></i>`;
        likeBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const result = await onToggleLike?.(entry);
          if (result == null) return;
          if (result.liked) {
            likedIds.add(entry.renderId);
          } else {
            likedIds.delete(entry.renderId);
          }
          render();
        });
        el.appendChild(likeBtn);
      }

      // Delete button
      if (entry.renderId) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "history-item-remove";
        remove.setAttribute("aria-label", `Delete "${entry.text}" from history`);
        remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        remove.addEventListener("click", (e) => {
          e.stopPropagation();
          onDelete?.(entry);
        });
        el.appendChild(remove);
      }

      container.appendChild(el);
    }
  }

  render();

  return {
    add(entry) {
      entries.unshift(entry);
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
      render();
    },
    remove(renderId) {
      const i = entries.findIndex((e) => e.renderId === renderId);
      if (i !== -1) entries.splice(i, 1);
      likedIds.delete(renderId);
      render();
    },
    isEmpty: () => entries.length === 0,
    setLikedIds(ids) {
      likedIds = new Set(ids);
      render();
    },
  };
}
