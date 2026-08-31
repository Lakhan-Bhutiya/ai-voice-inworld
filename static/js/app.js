import { initTheme } from "./theme.js";
import * as api from "./api.js";
import { createVoicePicker } from "./voices.js";
import { createPlayer } from "./player.js";
import { createRipple } from "./ripple.js";
import { createHistory } from "./history.js";
import { initComposer } from "./composer.js";
import { createSegmented } from "./segmented.js";
import { initClone } from "./clone.js";
import { createPreviewController } from "./preview.js";
import { RATE_PER_MILLION, costFor } from "./pricing.js";

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

function updateVoiceCounts(delta) {
  document.querySelectorAll("#voiceCountStudio, #voiceCountVoices").forEach((el) => {
    el.textContent = String(Math.max(0, Number(el.textContent) + delta));
  });
}

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
const previewController = createPreviewController({ onError: showToast });

// ---- Session history (server-persisted) ----------------------------------------

const history = createHistory({
  container: document.getElementById("historyStrip"),
  filterBar: document.getElementById("historyFilterBar"),
  onSelect: (entry) => composer.loadHistoryEntry(entry),
  onDelete: async (entry) => {
    if (!entry.renderId) return;
    try {
      await api.deleteHistoryEntry(entry.renderId);
      history.remove(entry.renderId);
      refreshStats();
    } catch (e) {
      showToast(`Couldn't delete: ${e.message}`);
    }
  },
  onToggleLike: async (entry) => {
    if (!entry.renderId) return null;
    try {
      return await api.toggleLike({ itemType: "render", itemId: entry.renderId });
    } catch (e) {
      showToast(`Couldn't toggle like: ${e.message}`);
      return null;
    }
  },
});

// ---- Usage / costs --------------------------------------------------------------
// Read from the server's usage ledger, not an in-memory counter — so the view
// stays correct across reloads and after cloning a voice (which no longer
// force-reloads the page at all). Money is admin-only: the backend omits the
// cost fields for a regular user, and applyRole below strips the UI that would
// show them.

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
  if (statEls.cost) statEls.cost.textContent = `$${(stats.costUsd || 0).toFixed(4)}`;
  if (statEls.enhances) statEls.enhances.textContent = String(stats.enhances);
  if (statEls.allGenerations) statEls.allGenerations.textContent = String(allTime.generations);
  if (statEls.allChars) statEls.allChars.textContent = allTime.chars.toLocaleString();
  if (statEls.allCost) statEls.allCost.textContent = `$${(allTime.costUsd || 0).toFixed(4)}`;
  if (statEls.allEnhances) statEls.allEnhances.textContent = String(allTime.enhances);
}
renderStats();

// Totals come from the backend, which logs every billable call to SQLite — so
// they're the same numbers after a reload, a restart, or a new browser tab, and
// deleting a render doesn't erase what it already cost. The cost fields are
// omitted server-side unless you're signed in as an admin.
function applyTotals(totals) {
  if (!totals) return;
  Object.assign(stats, totals.you);
  // allUsers is admin-only, so a user's payload simply doesn't carry it.
  if (totals.allUsers) Object.assign(allTime, totals.allUsers);
  renderStats();
}

async function refreshStats(totals) {
  // Synthesize/enhance hand back the refreshed totals, so only fall back to a
  // fetch when we weren't given any (a delete, say).
  if (totals) return applyTotals(totals);
  try {
    applyTotals(await api.getUsage());
  } catch {
    /* keep last-known stats on a transient failure */
  }
}

refreshStats();

// ---- Role gating ----------------------------------------------------------------
// Only an admin sees money. Everyone sees what they've used: generations,
// characters billed, and enhance calls. The backend enforces this on the data;
// this just takes the corresponding UI out of the page.

let isAdmin = true;

function applyRole(me) {
  isAdmin = !!me.isAdmin;
  for (const el of document.querySelectorAll("[data-admin-only]")) {
    if (!isAdmin) el.remove();
  }
  for (const el of document.querySelectorAll("[data-user-only]")) {
    el.hidden = isAdmin;
    if (isAdmin) el.remove();
  }
  const whoami = document.getElementById("whoami");
  if (whoami && me.username) {
    whoami.textContent = `${me.username} · ${me.role}`;
    whoami.hidden = false;
  }
  if (!isAdmin) {
    // A "Costs" page with no costs on it is just usage.
    const eyebrow = document.getElementById("costsEyebrow");
    if (eyebrow) eyebrow.textContent = "03 · Usage";
    for (const btn of document.querySelectorAll('[data-view="costs"]')) {
      btn.setAttribute("aria-label", "Usage");
      if (btn.title) btn.title = "Usage (3)";
    }
  }
}

api
  .getMe()
  .then((me) => {
    applyRole(me);
    if (me.isAdmin) loadUsers();
  })
  .catch(() => {
    // Can't tell who this is — assume the stricter of the two and hide money.
    applyRole({ isAdmin: false });
  });

// ---- Admin: accounts ------------------------------------------------------------
// The admin creates an account, hands over the password once, and watches what
// each person generates. Every control here lives inside [data-admin-only]
// markup, so for a user it was removed from the page before this ever runs —
// and the endpoints answer 403 regardless.

const createUserForm = document.getElementById("createUserForm");
const userTableBody = document.getElementById("userTableBody");
const userCount = document.getElementById("userCount");
const credentialSlip = document.getElementById("credentialSlip");
const credentialLine = document.getElementById("credentialLine");

function formatWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const days = (Date.now() - d) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function showCredentials(username, password) {
  if (!credentialSlip) return;
  credentialLine.textContent = `${username} / ${password}`;
  credentialSlip.hidden = false;
}

function userRow(user) {
  const tr = document.createElement("tr");
  if (user.disabled) tr.classList.add("is-disabled");

  const who = document.createElement("td");
  const name = document.createElement("span");
  name.className = "user-name";
  name.textContent = user.username;
  who.appendChild(name);
  if (user.displayName) {
    const sub = document.createElement("span");
    sub.className = "user-sub";
    sub.textContent = user.displayName;
    who.appendChild(sub);
  }
  if (user.disabled) {
    const tag = document.createElement("span");
    tag.className = "user-tag";
    tag.textContent = "suspended";
    who.appendChild(tag);
  }

  const u = user.usage;
  const cells = [
    u.generations.toLocaleString(),
    u.chars.toLocaleString(),
    `$${(u.costUsd || 0).toFixed(4)}`,
    String(u.enhances),
  ].map((text) => {
    const td = document.createElement("td");
    td.className = "num mono";
    td.textContent = text;
    return td;
  });

  const last = document.createElement("td");
  last.className = "micro";
  last.textContent = formatWhen(u.lastUsedAt);

  const actions = document.createElement("td");
  actions.className = "user-actions";
  if (user.id) {
    actions.append(
      userAction("Reset password", "fa-key", async () => {
        const { password } = await api.resetUserPassword(user.id);
        showCredentials(user.username, password);
        showToast(`New password for ${user.username} — shown above.`);
      }),
      userAction(user.disabled ? "Restore" : "Suspend",
        user.disabled ? "fa-circle-play" : "fa-ban", async () => {
          await api.setUserDisabled(user.id, !user.disabled);
          showToast(`${user.username} ${user.disabled ? "restored" : "suspended"}.`);
          await loadUsers();
        }),
      userAction("Delete", "fa-trash", async (btn) => {
        // Two-step rather than a confirm() dialog, which blocks the page.
        if (btn.dataset.armed !== "1") {
          btn.dataset.armed = "1";
          btn.classList.add("danger");
          btn.title = "Deletes their renders and audio too — click again";
          btn.querySelector("i").className = "fa-solid fa-triangle-exclamation";
          setTimeout(() => {
            btn.dataset.armed = "0";
            btn.classList.remove("danger");
            btn.title = "Delete";
            btn.querySelector("i").className = "fa-solid fa-trash";
          }, 4000);
          return;
        }
        await api.deleteUser(user.id);
        showToast(`Deleted ${user.username} and everything they generated.`);
        await loadUsers();
      }),
    );
  } else {
    const note = document.createElement("span");
    note.className = "micro";
    note.textContent = "from .env";
    actions.appendChild(note);
  }

  tr.append(who, ...cells, last, actions);
  return tr;
}

function userAction(label, icon, handler) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-action";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
  btn.addEventListener("click", async () => {
    try {
      await handler(btn);
    } catch (e) {
      showToast(e.message);
    }
  });
  return btn;
}

async function loadUsers() {
  if (!userTableBody) return;
  try {
    const { users, admin } = await api.listUsers();
    userTableBody.replaceChildren(
      // The admin sits at the top of its own table, without action buttons:
      // its credentials live in .env, not in the database.
      userRow({ username: admin.username, displayName: "admin · from .env", usage: admin.usage }),
      ...users.map(userRow),
    );
    if (userCount) {
      userCount.textContent = `${users.length} account${users.length === 1 ? "" : "s"}`;
    }
  } catch (e) {
    showToast(`Couldn't load accounts: ${e.message}`);
  }
}

createUserForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("newUsername");
  const displayName = document.getElementById("newDisplayName");
  const password = document.getElementById("newPassword");
  const submit = document.getElementById("createUserBtn");
  if (!username.value.trim()) return;

  submit.disabled = true;
  try {
    const user = await api.createUser({
      username: username.value.trim(),
      password: password.value,
      displayName: displayName.value.trim() || null,
    });
    showCredentials(user.username, user.password);
    username.value = "";
    displayName.value = "";
    password.value = "";
    await loadUsers();
    await refreshStats();
  } catch (err) {
    showToast(err.message);
  } finally {
    submit.disabled = false;
  }
});

document.getElementById("copyCredentials")?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(credentialLine.textContent);
    showToast("Credentials copied.");
  } catch {
    showToast("Couldn't copy — select the text instead.");
  }
});

// Restore this account's persisted renders (survive reloads and restarts).
api
  .getHistory()
  .then(({ history: rows, likedRenderIds }) => {
    // Add oldest-first so the newest ends up on top after each unshift.
    for (const r of [...rows].reverse()) {
      history.add({
        renderId: r.renderId,
        voiceId: r.voiceId,
        displayName: r.voiceName,
        audioUrl: r.audioUrl,
        text: r.text.length > 60 ? r.text.slice(0, 60) + "…" : r.text,
      });
    }
    if (likedRenderIds?.length) {
      history.setLikedIds(likedRenderIds);
    }
  })
  .catch(() => {});

const calcChars = document.getElementById("calcChars");
const calcResults = document.getElementById("calcResults");
function renderCalc() {
  if (!calcChars || !calcResults) return;
  const n = Math.max(0, Number(calcChars.value) || 0);
  calcResults.innerHTML = "";
  for (const modelId of Object.keys(RATE_PER_MILLION)) {
    const cost = costFor(n, modelId);
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

// ---- Advanced delivery controls (Model / Delivery segmented pickers) -----------
// Built ahead of the voice catalog fetch — they don't depend on it — then
// threaded into the composer once it's constructed below.

const modelControl = createSegmented({
  container: document.getElementById("modelSeg"),
  options: [
    { value: "inworld-tts-1.5-max", label: "1.5-max" },
    { value: "inworld-tts-1.5-mini", label: "1.5-mini" },
    { value: "inworld-tts-2", label: "tts-2" },
  ],
  value: "inworld-tts-1.5-max",
});
const deliveryControl = createSegmented({
  container: document.getElementById("deliverySeg"),
  options: [
    { value: "", label: "Default" },
    { value: "STABLE", label: "Stable" },
    { value: "BALANCED", label: "Balanced" },
    { value: "CREATIVE", label: "Creative" },
  ],
  value: "",
});

// ---- Voice catalog + two synced pickers ----------------------------------------

let composer = { loadHistoryEntry: () => {}, generate: () => {}, onVoiceChanged: () => {} };
let pickers = [];
let broadcastSelectionRef = () => {}; // set once pickers exist; used by clone.js's "Use this voice"

api
  .getVoices()
  .then(async (data) => {
    const voices = data?.voices || data?.result || [];
    if (!Array.isArray(voices) || !voices.length) {
      showToast("No voices returned by the catalog.");
      return;
    }

    document.querySelectorAll("#voiceCountStudio, #voiceCountVoices").forEach((el) => {
      el.textContent = String(voices.length);
    });

    function broadcastSelection(voice) {
      for (const p of pickers) if (p.setSelected) p.setSelected(voice.voiceId);
      // A voice switch no longer auto-regenerates: that used to bill a real
      // Inworld render on every click while browsing voices. It just updates
      // the dock so a regenerate is one explicit click away.
      composer.onVoiceChanged(voice);
    }
    broadcastSelectionRef = broadcastSelection;

    function onPreview(voice, btn, modelId) {
      previewController.toggle(voice, btn, modelId);
    }

    async function onDeleteVoice(voice) {
      try {
        await api.deleteCustomVoice(voice.voiceId);
        let fallback = null;
        for (const p of pickers) fallback = p.removeVoice(voice.voiceId) || fallback;
        if (fallback) composer.onVoiceChanged(fallback);
        updateVoiceCounts(-1);
        showToast(`Deleted "${voice.displayName}".`);
        return true;
      } catch (e) {
        showToast(`Couldn't delete: ${e.message}`);
        return false;
      }
    }

    async function onToggleLike(voice) {
      try {
        const result = await api.toggleLike({ itemType: "voice", itemId: voice.voiceId });
        // Sync the other picker's liked state
        for (const p of pickers) {
          // Each picker manages its own internal likedIds via the button click handler,
          // but we need to re-render the *other* picker to reflect the change.
        }
        return result;
      } catch (e) {
        showToast(`Couldn't toggle like: ${e.message}`);
        return null;
      }
    }

    // Fetch liked voice IDs for initial render
    let initialLikedVoiceIds = [];
    try {
      const likesData = await api.getLikes("voice");
      initialLikedVoiceIds = likesData?.likes || [];
    } catch { /* proceed without liked state */ }

    const studioPicker = createVoicePicker({
      root: document.getElementById("studioVoicePanel"),
      voices,
      mode: "list",
      initialSelectedId: voices[0].voiceId,
      onSelect: broadcastSelection,
      onPreview,
      onDeleteVoice,
      onToggleLike: async (voice) => {
        const result = await onToggleLike(voice);
        if (result) {
          // Sync the other picker — find all like buttons for this voice and update them
          for (const p of pickers) {
            if (p !== studioPicker) {
              const ids = result.liked
                ? [...initialLikedVoiceIds, voice.voiceId]
                : initialLikedVoiceIds.filter((id) => id !== voice.voiceId);
              // We'll just re-set on both pickers after the toggle
            }
          }
          // Update the shared tracked set
          if (result.liked) {
            if (!initialLikedVoiceIds.includes(voice.voiceId)) initialLikedVoiceIds.push(voice.voiceId);
          } else {
            initialLikedVoiceIds = initialLikedVoiceIds.filter((id) => id !== voice.voiceId);
          }
          // Sync all pickers
          for (const p of pickers) p.setLikedIds(initialLikedVoiceIds);
        }
        return result;
      },
      getModelId: () => modelControl.getValue(),
      initialLikedIds: initialLikedVoiceIds,
    });
    const gridPicker = createVoicePicker({
      root: document.getElementById("voicesGridPanel"),
      voices,
      mode: "grid",
      initialSelectedId: voices[0].voiceId,
      onSelect: broadcastSelection,
      onPreview,
      onDeleteVoice,
      onToggleLike: async (voice) => {
        const result = await onToggleLike(voice);
        if (result) {
          if (result.liked) {
            if (!initialLikedVoiceIds.includes(voice.voiceId)) initialLikedVoiceIds.push(voice.voiceId);
          } else {
            initialLikedVoiceIds = initialLikedVoiceIds.filter((id) => id !== voice.voiceId);
          }
          for (const p of pickers) p.setLikedIds(initialLikedVoiceIds);
        }
        return result;
      },
      getModelId: () => modelControl.getValue(),
      initialLikedIds: initialLikedVoiceIds,
    });
    pickers = [studioPicker, gridPicker];

    composer = initComposer({
      scriptEl: document.getElementById("scriptText"),
      counterEl: document.getElementById("scriptCount"),
      tagButtons: [...document.querySelectorAll("[data-tag-group] .pill")],
      directionInput: document.getElementById("directionInput"),
      directionPresets: [...document.querySelectorAll("[data-direction-presets] .pill")],
      enhanceBtn: document.getElementById("enhanceBtn"),
      modelControl,
      deliveryControl,
      speedInput: document.getElementById("speedInput"),
      temperatureInput: document.getElementById("tempInput"),
      advancedSummary: document.getElementById("advancedSummary"),
      dockPlayBtn: document.getElementById("dockPlay"),
      downloadLink: document.getElementById("downloadLink"),
      regenBtn: document.getElementById("regenBtn"),
      dockMetaLabel: document.getElementById("dockMetaLabel"),
      dockMetaUsage: document.getElementById("dockMetaUsage"),
      dockMetaEstimate: document.getElementById("dockMetaEstimate"),
      getVoice: () => studioPicker.getSelected(),
      player,
      ripple,
      history,
      setBusy,
      onError: showToast,
      onUsage: (totals) => refreshStats(totals),
      onEnhanceUsed: (totals) => refreshStats(totals),
    });
  })
  .catch((e) => showToast(`Couldn't load voices: ${e.message}`));

// ---- Voice cloning --------------------------------------------------------------

initClone({
  recordBtn: document.getElementById("recordBtn"),
  recMeter: document.getElementById("recMeter"),
  recordTimer: document.getElementById("recordTimer"),
  fileDrop: document.getElementById("fileDrop"),
  fileInput: document.getElementById("cloneFile"),
  fileDropIdle: document.getElementById("fileDropIdle"),
  fileDropFilled: document.getElementById("fileDropFilled"),
  fileDropName: document.getElementById("fileDropName"),
  fileDropSize: document.getElementById("fileDropSize"),
  fileDropRemove: document.getElementById("fileDropRemove"),
  previewBlock: document.getElementById("clonePreviewBlock"),
  previewPlayBtn: document.getElementById("clonePreviewPlay"),
  previewWave: document.getElementById("clonePreviewWave"),
  previewTime: document.getElementById("clonePreviewTime"),
  previewDuration: document.getElementById("clonePreviewDuration"),
  rerecordBtn: document.getElementById("cloneRerecordBtn"),
  nameInput: document.getElementById("cloneName"),
  langInput: document.getElementById("cloneLang"),
  transcriptInput: document.getElementById("cloneTranscript"),
  cloneBtn: document.getElementById("cloneBtn"),
  cloneStatus: document.getElementById("cloneStatus"),
  successActions: document.getElementById("cloneSuccessActions"),
  successPreviewBtn: document.getElementById("cloneSuccessPreview"),
  successUseBtn: document.getElementById("cloneSuccessUse"),
  offcanvasEl: document.getElementById("cloneOffcanvas"),
  onError: showToast,
  onCloned: (voice) => {
    showToast(`Cloned "${voice.displayName}". It's now in your voice list.`);
    for (const p of pickers) p.addVoice?.(voice);
    updateVoiceCounts(1);
  },
  onPreviewRequest: (voice, btn) => previewController.toggle(voice, btn, modelControl.getValue()),
  onUseVoice: (voice) => broadcastSelectionRef(voice),
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
  if (!typingInField && ["1", "2", "3", "4"].includes(e.key)) {
    const names = ["studio", "voices", "costs", "people"];
    const name = names[Number(e.key) - 1];
    // "4" is the admin's Users view; for anyone else it isn't in the page.
    if (document.querySelector(`.view[data-view="${name}"]`)) showView(name);
  }
});
