/* =========================================================================
   ArsVibe PW — shared client runtime
   - session ("Bypass Login" / Google-style sign in, stored locally)
   - API helpers with proxy fallback
   - toasts, avatar, nav toggle
   ========================================================================= */

export const SITE = {
  name: "ArsVibe",
  tag: "PW",
  title: "Physics Wallah — ArsVibe",
  // No links to third-party players or mirrors: the site plays everything it
  // lists. Recovery is Retry, never "go somewhere else".
  telegram: "https://t.me/ArsVibe_Main",
};

/**
 * localStorage keys, with a one-time migration from the previous brand.
 *
 * Renaming the site must not wipe anyone's saved session, preferences or
 * lecture library: the old key is read once, copied to the new name, and the
 * value is left in place so a rollback still finds it.
 */
function migrateKey(newKey, oldKey) {
  try {
    if (localStorage.getItem(newKey) === null) {
      const legacy = localStorage.getItem(oldKey);
      if (legacy !== null) localStorage.setItem(newKey, legacy);
    }
  } catch {
    /* private mode / storage disabled — nothing to migrate */
  }
  return newKey;
}

const SESSION_KEY = migrateKey("arsvibe.session", "eduvibe.session");
const RELAY = (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`;

/* --------------------------------- session -------------------------------- */

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.name) return null;
    return s;
  } catch {
    return null;
  }
}

export function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  window.dispatchEvent(new CustomEvent("session:change", { detail: session }));
}

export function signInBypass() {
  const adjectives = ["Bright", "Swift", "Focus", "Sharp", "Bold", "Calm"];
  const nouns = ["Aspirant", "Learner", "Topper", "Scholar", "Achiever"];
  const name = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${
    nouns[Math.floor(Math.random() * nouns.length)]
  }`;
  setSession({
    name,
    email: "student@arsvibe.local",
    provider: "instant",
    joinedAt: Date.now(),
  });
  return getSession();
}

export function signInWithEmail(name, email) {
  setSession({
    name: name || (email || "").split("@")[0] || "Student",
    email: email || "student@arsvibe.local",
    provider: "google",
    joinedAt: Date.now(),
  });
  return getSession();
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new CustomEvent("session:change", { detail: null }));
}

export function initials(name) {
  return (name || "S")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/* ------------------------------- local prefs ------------------------------ */

const PREFS_KEY = migrateKey("arsvibe.prefs", "eduvibe.prefs");
export function getPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}
export function setPref(key, value) {
  const prefs = getPrefs();
  prefs[key] = value;
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function recentBatches() {
  return getPrefs().recent || [];
}
export function rememberBatch(batch) {
  if (!batch || !batch.id) return;
  const list = recentBatches().filter((b) => b.id !== batch.id);
  list.unshift({ id: batch.id, name: batch.name, image: batch.image || "" });
  setPref("recent", list.slice(0, 8));
}

/* ---------------------------------- fetch --------------------------------- */

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, ...opts });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.success === false) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * API call with a browser-side fallback.
 *
 * If our serverless route cannot reach the upstream API (some networks block
 * it), it answers with `{ needsProxy: true, relay }`. In that case the browser
 * fetches the upstream JSON through the public CORS relay and normalises it
 * client-side, so the site keeps working with live data.
 */
export async function api(path, { proxyFallback = null } = {}) {
  const data = await fetchJson(path);
  if (data && data.needsProxy && proxyFallback) {
    return proxyFallback(data);
  }
  return data;
}

export async function relayJson(target) {
  const res = await fetch(RELAY(target));
  if (!res.ok) throw new Error(`Relay failed (${res.status})`);
  return res.json();
}

/* --------------------------------- toasts --------------------------------- */

let toastHost = null;
export function toast(message, kind = "") {
  if (typeof document === "undefined") return;
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "0.25s ease";
    setTimeout(() => el.remove(), 260);
  }, 3400);
}

/* --------------------------------- helpers -------------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name) || "";
}

export function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtRelative(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(value);
}

export function money(value) {
  if (value === null || value === undefined) return "";
  if (!value) return "FREE";
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

export function debounce(fn, ms = 380) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------- nav / chrome ----------------------------- */

export function mountChrome(activePage) {
  const nav = $("#nav");
  if (nav) {
    $("#navToggle")?.addEventListener("click", () => {
      $("#navLinks")?.classList.toggle("open");
    });
    $$("#navLinks a").forEach((a) => {
      if (a.dataset.page === activePage) a.classList.add("active");
    });
  }
  renderSessionChip();
  window.addEventListener("session:change", renderSessionChip);
}

function renderSessionChip() {
  const host = $("#sessionChip");
  if (!host) return;
  const session = getSession();
  if (session) {
    host.innerHTML = `
      <a class="avatar" href="/dashboard.html" title="${esc(session.name)} — open dashboard">
        ${esc(initials(session.name))}
      </a>`;
  } else {
    host.innerHTML = `<a class="btn btn-ghost btn-sm" href="/login.html">Sign in</a>`;
  }
}

/** Redirect to the sign-in page when a page requires a session. */
export function requireSession(redirectBack = true) {
  const session = getSession();
  if (session) return session;
  const next = redirectBack ? encodeURIComponent(location.pathname + location.search) : "";
  location.href = `/login.html${next ? `?next=${next}` : ""}`;
  return null;
}

/** Thumbnail URL through our own relay for hosts without CORS/frame rules. */
export function imageUrl(url) {
  if (!url) return "";
  return url;
}

export function skeletonCards(count = 8) {
  return Array.from({ length: count })
    .map(() => `<div class="skeleton sk-card"></div>`)
    .join("");
}

export function emptyState(title, hint, action = "") {
  return `
    <div class="empty">
      <div class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
        </svg>
      </div>
      <strong>${esc(title)}</strong>
      <span class="tiny">${esc(hint)}</span>
      ${action}
    </div>`;
}
