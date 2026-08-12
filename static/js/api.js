// Thin wrapper over the backend's 4 endpoints (see /docs or FRONTEND.md).
// Every function throws a plain Error whose .message is the backend's
// `detail` string when present, so callers never touch response shape.

async function request(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error("Can't reach the server. Is it still running?");
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

export function synthesize({ text, voiceId, modelId, description, audioEncoding }) {
  return request("/api/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voiceId, modelId, description, audioEncoding }),
  });
}

export function enhance({ text }) {
  return request("/api/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}
