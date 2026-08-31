// Thin wrapper over the backend endpoints (see /docs or FRONTEND.md).
// Every function throws a plain Error whose .message is the backend's
// `detail` string when present, so callers never touch response shape.

// Nothing here identifies the caller: the backend owns everything by the
// signed-in account, read from the session cookie. History, cloned voices,
// likes and usage all follow the login, not the browser.

async function request(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error("Can't reach the server. Is it still running?");
  }
  if (res.status === 401) {
    // Session cookie expired or missing — back to the sign-in screen.
    window.location.replace("/login");
    throw new Error("Not signed in.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch {
      /* body wasn't JSON; keep statusText */
    }
    throw new Error(detail);
  }
  return res.json();
}

export function getHealth() {
  return request("/api/health");
}

export function getVoices() {
  return request("/api/voices");
}

export function synthesize({
  text, voiceId, voiceName, modelId, description, audioEncoding,
  speakingRate, temperature, deliveryMode,
}) {
  return request("/api/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text, voiceId, voiceName, modelId, description, audioEncoding,
      speakingRate, temperature, deliveryMode,
    }),
  });
}

export function enhance({ text }) {
  return request("/api/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function getHistory() {
  return request("/api/history");
}

export function deleteHistoryEntry(renderId) {
  return request(`/api/history/${encodeURIComponent(renderId)}`, { method: "DELETE" });
}

// Your persisted usage totals, per model, plus everyone's for an admin. Money
// figures are omitted by the backend unless you're signed in as an admin.
export function getUsage() {
  return request("/api/usage");
}

// Who's signed in, and whether they may see costs.
export function getMe() {
  return request("/api/me");
}

export function logout() {
  return request("/api/logout", { method: "POST" });
}

// Clone a voice from an audio File/Blob. Returns the new custom voice object.
export function cloneVoice({ file, displayName, languageCode = "en-US", transcription = "" }) {
  const form = new FormData();
  form.append("file", file);
  form.append("displayName", displayName);
  form.append("languageCode", languageCode);
  form.append("transcription", transcription);
  return request("/api/voices/clone", { method: "POST", body: form });
}

// ---- Likes / favourites ----------------------------------------------------

export function toggleLike({ itemType, itemId }) {
  return request("/api/likes/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemType, itemId }),
  });
}

export function getLikes(itemType) {
  return request(`/api/likes?itemType=${encodeURIComponent(itemType)}`);
}

// Deletes the voice at Inworld for real (not just from local tracking) —
// irreversible, since the sample audio was never kept.
export function deleteCustomVoice(voiceId) {
  return request(`/api/voices/custom/${encodeURIComponent(voiceId)}`, { method: "DELETE" });
}

// ---- Admin: accounts -------------------------------------------------------
// All admin-only; a regular user gets 403 from every one of these.

export function listUsers() {
  return request("/api/admin/users");
}

// Leave `password` empty to have the server generate one. It comes back in the
// response — that's the only time it's ever readable.
export function createUser({ username, password = "", displayName = null }) {
  return request("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, displayName }),
  });
}

export function resetUserPassword(userId, password = "") {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

export function setUserDisabled(userId, disabled) {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/disabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled }),
  });
}

export function deleteUser(userId) {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
