// Sign-in screen. Posts the credentials to /api/login, which compares them to
// the APP_USERNAME/APP_PASSWORD pair in .env and sets a signed session cookie.
import { initTheme } from "./theme.js";

initTheme();

const form = document.getElementById("loginForm");
const username = document.getElementById("username");
const password = document.getElementById("password");
const submit = document.getElementById("loginSubmit");
const error = document.getElementById("loginError");

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.hidden = true;
  if (!username.value.trim() || !password.value) {
    showError("Enter both a username and a password.");
    return;
  }

  submit.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    if (!res.ok) {
      let detail = "Sign-in failed.";
      try {
        detail = (await res.json()).detail || detail;
      } catch {
        /* not JSON; keep the generic message */
      }
      showError(detail);
      password.value = "";
      password.focus();
      return;
    }
    window.location.replace("/");
  } catch {
    showError("Can't reach the server. Is it still running?");
  } finally {
    submit.disabled = false;
  }
});

// Same connection indicator as the studio topbar, so a missing API key is
// visible before you sign in rather than after.
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
fetch("/api/health")
  .then((r) => r.json())
  .then((data) => {
    statusDot.className = data.ttsConfigured ? "status-dot ok" : "status-dot warn";
    statusText.textContent = data.ttsConfigured ? "Connected" : "API key missing";
  })
  .catch(() => {
    statusDot.className = "status-dot err";
    statusText.textContent = "Offline";
  });
