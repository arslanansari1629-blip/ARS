/**
 * Download keys — a signed pass that lasts a day.
 *
 * The idea is the one every "key generate" page uses: a visitor cannot download
 * a lecture until they have asked for a key, and asking has a cost — a short
 * wait, an optional sponsor page, and a cap per visitor per day. The pass they
 * get back covers every lecture for the next 24 hours.
 *
 * Two decisions make this safe to run on a serverless plan with no database:
 *
 *   1. a key is *signed*, not *stored*. `d.<expiresAt>.<hmac>` — the HMAC proves
 *      this site issued it and the timestamp proves it is still good. Nothing to
 *      look up, nothing to leak, and a key minted on one instance verifies on
 *      another because only the secret has to be shared.
 *   2. the wait is enforced the same way. A challenge is `c.<issuedAt>.<hmac>`;
 *      redeeming it too early fails, so the timer cannot be skipped by calling
 *      the endpoint directly. Replaying a challenge only mints another key.
 *
 * What this is not: proof of identity. A key is a speed bump and a reason to
 * show a page, which is what these gates are. Anyone determined enough can wait
 * the timer once and then share one key with a group chat, and a key cannot be
 * revoked before it expires without a database. Both are stated in the README
 * rather than papered over.
 */

import crypto from "node:crypto";

/**
 * The HMAC secret.
 *
 * In production this must come from `DOWNLOAD_KEY_SECRET` (a Vercel environment
 * variable). The fallback exists so local development and the tests work out of
 * the box — it is public in this repository, so a fallback deployment is
 * trivially forgeable. `keyConfig()` reports which one is in use, and the admin
 * panel shows it, so this is visible rather than a silent hole.
 */
const DEV_SECRET = "arsvibe-download-key-development-secret-do-not-use-in-production";

function secret() {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  return env.DOWNLOAD_KEY_SECRET || DEV_SECRET;
}

/** How long one key is good for. `DOWNLOAD_KEY_TTL_HOURS` overrides it. */
export function ttlMs() {
  const env = (typeof process !== "undefined" && process.env) || {};
  const hours = Number(env.DOWNLOAD_KEY_TTL_HOURS);
  const safe = Number.isFinite(hours) && hours > 0 && hours <= 24 * 30 ? hours : 24;
  return safe * 60 * 60 * 1000;
}

/**
 * The wait before a key can be collected, in milliseconds.
 *
 * Long enough to be a real gate, short enough that a student on a bad
 * connection does not give up. Configurable because the honest answer to "how
 * long" depends on whether a sponsor page is in front of it.
 */
export function waitMs() {
  const env = (typeof process !== "undefined" && process.env) || {};
  const seconds = Number(env.DOWNLOAD_KEY_WAIT_SECONDS);
  const safe = Number.isFinite(seconds) && seconds >= 0 && seconds <= 300 ? seconds : 30;
  return safe * 1000;
}

/**
 * Where a visitor is sent when a sponsor/shortlink is configured.
 *
 * `{challenge}` in the URL is replaced with the signed challenge. Without this
 * set, the gate is the plain wait, which is the default because it needs no
 * third-party account and cannot break.
 */
export function rewardUrl(challenge = "") {
  const env = (typeof process !== "undefined" && process.env) || {};
  const url = env.DOWNLOAD_KEY_REWARD_URL || "";
  if (!url) return "";
  return url
    .replaceAll("{challenge}", encodeURIComponent(challenge))
    .replaceAll("{origin}", encodeURIComponent(env.PUBLIC_ORIGIN || ""));
}

/** How many keys one visitor may collect per rolling window. */
export function ratePolicy() {
  const env = (typeof process !== "undefined" && process.env) || {};
  const perHour = Number(env.DOWNLOAD_KEY_PER_HOUR);
  const perDay = Number(env.DOWNLOAD_KEY_PER_DAY);
  return {
    perHour: Number.isFinite(perHour) && perHour > 0 ? perHour : 6,
    perDay: Number.isFinite(perDay) && perDay > 0 ? perDay : 12,
  };
}

/** How long a challenge stays redeemable after the wait, so tabs left open work. */
const CHALLENGE_GRACE_MS = 30 * 60 * 1000;

/* --------------------------------- signing -------------------------------- */

function sign(value) {
  return crypto.createHmac("sha256", secret()).update(String(value)).digest("base64url").slice(0, 32);
}

/** Constant-time compare: a signature check is a comparison, not a shortcut. */
function sameSignature(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/* -------------------------------- challenges ------------------------------ */

/** Start a wait: nothing about this is stored server-side. */
export function mintChallenge(now = Date.now()) {
  const issuedAt = Math.floor(now);
  return `c.${issuedAt}.${sign(`c.${issuedAt}`)}`;
}

/**
 * Can the wait be over yet?
 *
 * Returns `{ ok, waitMs }` — `waitMs` is what the page counts down, so the
 * client never has to invent its own clock (and cannot fake one).
 */
export function checkChallenge(token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "c") return { ok: false, reason: "bad-challenge", waitMs: waitMs() };
  const issuedAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: "bad-challenge", waitMs: waitMs() };
  if (!sameSignature(parts[2], sign(`c.${issuedAt}`))) {
    return { ok: false, reason: "bad-challenge", waitMs: waitMs() };
  }

  const elapsed = now - issuedAt;
  const remaining = waitMs() - elapsed;
  if (remaining > 0) return { ok: false, reason: "wait", waitMs: Math.ceil(remaining) };
  // A challenge left open for a day is a stale tab, not a patient visitor.
  if (elapsed > CHALLENGE_GRACE_MS) return { ok: false, reason: "expired", waitMs: waitMs() };
  return { ok: true, waitMs: 0 };
}

/* ----------------------------------- keys --------------------------------- */

/** Mint a pass. The only thing that travels is its expiry and a signature. */
export function mintKey(now = Date.now()) {
  const expiresAt = Math.floor(now) + ttlMs();
  return { key: `d.${expiresAt}.${sign(`d.${expiresAt}`)}`, expiresAt, ttlMs: ttlMs() };
}

/**
 * Is this key ours, and is it still good?
 *
 * `msLeft` is returned so the page can show a countdown instead of discovering
 * expiry halfway through a download.
 */
export function verifyKey(token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "d") return { ok: false, reason: "bad-key" };
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "bad-key" };
  if (!sameSignature(parts[2], sign(`d.${expiresAt}`))) return { ok: false, reason: "bad-key" };
  const msLeft = expiresAt - now;
  if (msLeft <= 0) return { ok: false, reason: "expired", expiresAt, msLeft: 0 };
  return { ok: true, expiresAt, msLeft };
}

/* ------------------------------- rate limiting ---------------------------- */

/**
 * Who is asking.
 *
 * `x-forwarded-for` is client-controlled in principle, so this is a courtesy
 * limit, not a security boundary — it stops one tab in a loop, which is the
 * realistic abuse of a free key. The first hop is used because Vercel rewrites
 * the header and the originating client is the leftmost entry.
 */
export function clientKey(req) {
  const header = req && req.headers ? req.headers["x-forwarded-for"] || req.headers["x-real-ip"] : "";
  const first = String(Array.isArray(header) ? header[0] : header || "")
    .split(",")[0]
    .trim();
  if (first) return first;
  return (req && req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Per-instance counters.
 *
 * A serverless function has several instances, so the true count can be higher
 * than any one instance believes. That is fine for the purpose — nobody is
 * billing on it — and it avoids a database for a limit this soft.
 */
const issued = new Map();

export function noteKeyIssued(ip, now = Date.now()) {
  const entry = issued.get(ip) || { hourStart: now, dayStart: now, hour: 0, day: 0 };
  if (now - entry.hourStart >= 60 * 60 * 1000) {
    entry.hourStart = now;
    entry.hour = 0;
  }
  if (now - entry.dayStart >= 24 * 60 * 60 * 1000) {
    entry.dayStart = now;
    entry.day = 0;
  }
  entry.hour += 1;
  entry.day += 1;
  issued.set(ip, entry);
  // Bounded: a map keyed by IP is otherwise a slow leak on a long-lived instance.
  if (issued.size > 5000) {
    for (const [key, value] of issued) {
      if (now - value.dayStart > 24 * 60 * 60 * 1000) issued.delete(key);
    }
  }
  return entry;
}

/** `{ allowed, retryAfterMs, reason }` for the next key request. */
export function checkRate(ip, now = Date.now()) {
  const entry = issued.get(ip);
  if (!entry) return { allowed: true };
  const policy = ratePolicy();
  const hourAge = now - entry.hourStart;
  const dayAge = now - entry.dayStart;
  if (hourAge < 60 * 60 * 1000 && entry.hour >= policy.perHour) {
    return {
      allowed: false,
      reason: "hour",
      retryAfterMs: 60 * 60 * 1000 - hourAge,
      limit: policy.perHour,
    };
  }
  if (dayAge < 24 * 60 * 60 * 1000 && entry.day >= policy.perDay) {
    return {
      allowed: false,
      reason: "day",
      retryAfterMs: 24 * 60 * 60 * 1000 - dayAge,
      limit: policy.perDay,
    };
  }
  return { allowed: true };
}

/** Test helper: forget every counter. */
export function resetRateLimits() {
  issued.clear();
}

/** What the gate is configured to do, for the page and the admin panel. */
export function keyConfig() {
  const env = (typeof process !== "undefined" && process.env) || {};
  return {
    ttlHours: Math.round(ttlMs() / (60 * 60 * 1000)),
    waitSeconds: Math.round(waitMs() / 1000),
    mode: env.DOWNLOAD_KEY_REWARD_URL ? "reward" : "wait",
    // Deliberately boolean: whether the secret is a deployment secret, never
    // what it is.
    secretFromEnv: Boolean(env.DOWNLOAD_KEY_SECRET),
    rate: ratePolicy(),
  };
}
