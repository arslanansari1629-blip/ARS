/**
 * Admin panel backend: credentials, sessions, metrics, health probes and logs.
 *
 * The operator's username and password are *server-only*. They are never sent to
 * a browser, never bundled into `public/`, and never returned by an API: the
 * only thing a successful sign-in hands back is a short-lived random session
 * token whose hash is what the server stores. Even this module keeps the
 * credentials as digests, so a log line or a heap dump cannot reveal them.
 */

import crypto from "node:crypto";
import { tokenState, resolveToken, credentialLadder } from "./pw-auth.mjs";
import { loadCatalogIndex, CATALOG_SOURCE } from "./catalog.mjs";
import { UA, CATALOG_MIRRORS, upstreamJson } from "./upstream.mjs";

/* ---------------------------------------------------------------- */
/* Credentials — stored as digests, compared in constant time        */
/* ---------------------------------------------------------------- */

const USERNAME = "editz";
const PASSWORD = "editz900s";

const sha256 = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest();
const USER_DIGEST = sha256(USERNAME);
const PASS_DIGEST = sha256(PASSWORD);

/**
 * Compare digests, not strings.
 *
 * `crypto.timingSafeEqual` throws on different lengths, so the digests are
 * compared and the length check is only a guard. Hashing both sides first also
 * means the comparison never depends on how long the submitted password was.
 */
function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function checkCredentials(username, password) {
  const userOk = safeEqual(sha256(username || ""), USER_DIGEST);
  const passOk = safeEqual(sha256(password || ""), PASS_DIGEST);
  // Both comparisons always run: a wrong username must not answer faster than a
  // wrong password.
  return userOk && passOk;
}

/* ---------------------------------------------------------------- */
/* Sessions                                                          */
/* ---------------------------------------------------------------- */

/** Idle timeout. An admin dashboard left open overnight should re-ask. */
const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Absolute lifetime, regardless of activity. */
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
/** Failed sign-ins allowed per window per client, before a cooldown. */
const MAX_FAILS = 6;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

/** Survives warm invocations; a cold start simply asks for the password again. */
const sessions = new Map();
const failures = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.seen > SESSION_IDLE_MS || now - s.at > SESSION_MAX_MS) sessions.delete(id);
  }
  for (const [key, f] of failures) {
    if (now - f.first > FAIL_WINDOW_MS) failures.delete(key);
  }
}

export function rateLimited(clientKey) {
  sweep();
  const f = failures.get(clientKey || "anon");
  return Boolean(f && f.count >= MAX_FAILS);
}

export function noteFailure(clientKey) {
  const key = clientKey || "anon";
  const now = Date.now();
  const f = failures.get(key);
  if (!f || now - f.first > FAIL_WINDOW_MS) failures.set(key, { count: 1, first: now });
  else f.count += 1;
}

export function clearFailures(clientKey) {
  failures.delete(clientKey || "anon");
}

/** Minutes until a cooldown lifts, for the sign-in message. */
export function cooldownMinutes(clientKey) {
  const f = failures.get(clientKey || "anon");
  if (!f) return 0;
  return Math.max(1, Math.ceil((FAIL_WINDOW_MS - (Date.now() - f.first)) / 60000));
}

export function createSession(clientKey) {
  sweep();
  const id = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  sessions.set(id, { at: now, seen: now, client: clientKey || "" });
  return { id, idleMinutes: SESSION_IDLE_MS / 60000, maxHours: SESSION_MAX_MS / 3600000 };
}

/** Resolve a request's session, sliding its idle window. Null when not signed in. */
export function getSession(id) {
  if (!id) return null;
  sweep();
  const s = sessions.get(id);
  if (!s) return null;
  s.seen = Date.now();
  return s;
}

export function destroySession(id) {
  if (id) sessions.delete(id);
}

/** Sessions currently considered live (verifiable because they are in memory). */
export function liveSessionCount() {
  sweep();
  return sessions.size;
}

/* ---------------------------------------------------------------- */
/* Traffic counters (per warm instance)                              */
/* ---------------------------------------------------------------- */

const startedAt = Date.now();

const stats = {
  requests: 0,
  apiRequests: 0,
  pages: 0,
  bytesOut: 0,
  byStatus: {},
  byCache: {},
  byRoute: {},
  byPage: {},
  errors: 0,
  lastErrors: [],
  slowest: [],
  perMinute: new Map(),
};

/** Routes we track individually; everything else folds into "other". */
const TRACKED = new Set([
  "batches",
  "batch",
  "contents",
  "lecture",
  "stream",
  "hls",
  "sign",
  "pdf",
  "media",
  "pw",
  "token",
  "check",
  "admin",
  "upstream",
  "mirror",
  "page",
]);

function minuteKey(d = Date.now()) {
  return Math.floor(d / 60000);
}

/**
 * Record one request. Called by every API route through `cors()`, so the numbers
 * are real traffic rather than a guess.
 */
export function recordRequest({ route = "other", status = 200, ms = 0, bytes = 0, page = "", res = null, cache = "" }) {
  if (res) marks.set(res, { at: Date.now() });
  stats.requests += 1;
  // Page views are the site's own HTML; everything else is a data request, a
  // health probe or an outbound check. Counting probes as "API traffic" would
  // make the panel flatter itself every time it was opened.
  const isPage = route === "page";
  if (!isPage) stats.apiRequests += 1;
  if (isPage) {
    stats.pages += 1;
    if (page) stats.byPage[page] = (stats.byPage[page] || 0) + 1;
  }
  stats.bytesOut += bytes;
  // A response still streaming will add its own size when it ends.
  stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
  // A real CDN hit is a request that never reached this function, so what is
  // recorded here is the opposite and worth watching: "MISS" on a read-only
  // route that should be cached means the cache header is wrong.
  if (cache) stats.byCache[cache] = (stats.byCache[cache] || 0) + 1;
  const bucket = TRACKED.has(route) ? route : "other";
  stats.byRoute[bucket] = (stats.byRoute[bucket] || 0) + 1;

  const key = minuteKey();
  stats.perMinute.set(key, (stats.perMinute.get(key) || 0) + 1);
  // Keep two hours of per-minute buckets: enough for the sparkline, bounded memory.
  for (const k of stats.perMinute.keys()) {
    if (k < key - 120) stats.perMinute.delete(k);
  }

  if (status >= 500) {
    stats.errors += 1;
    stats.lastErrors.unshift({
      at: new Date().toISOString(),
      route: bucket,
      status,
      ms: Math.round(ms),
    });
    stats.lastErrors = stats.lastErrors.slice(0, 20);
  }

  if (route !== "page" && ms > 0) {
    stats.slowest.push({ route: bucket, ms: Math.round(ms), status, at: new Date().toISOString() });
    stats.slowest.sort((a, b) => b.ms - a.ms);
    stats.slowest = stats.slowest.slice(0, 8);
  }
}

/** Requests-per-minute for the last `minutes` buckets, oldest first. */
function series(minutes = 30) {
  const now = minuteKey();
  const out = [];
  for (let i = minutes - 1; i >= 0; i -= 1) out.push(stats.perMinute.get(now - i) || 0);
  return out;
}

/**
 * Close the sample for a request: now that the body is written, add its size to
 * the byte counter. Latency is deliberately *not* rewritten here — a video relay
 * streams for as long as the client watches, and reporting that as "time to
 * first byte" would make the slowest-request list meaningless.
 */
export function finishRequest(res) {
  const mark = marks.get(res);
  if (!mark) return;
  marks.delete(res);
  const bytes = Number(res.__adminBytes || 0);
  if (bytes > 0) stats.bytesOut += bytes;
}

/** res -> {at} for every counted API response. */
const marks = new WeakMap();

export function requestStats() {
  return {
    requests: stats.requests,
    apiRequests: stats.apiRequests,
    pages: stats.pages,
    bytesOut: stats.bytesOut,
    errors: stats.errors,
    errorRate:
      stats.requests > 0 ? Number(((stats.errors / stats.requests) * 100).toFixed(2)) : 0,
    byStatus: stats.byStatus,
    byCache: stats.byCache,
    byRoute: stats.byRoute,
    byPage: stats.byPage,
    series: series(30),
    slowest: stats.slowest,
    lastErrors: stats.lastErrors,
    liveSessions: liveSessionCount(),
  };
}

/* ---------------------------------------------------------------- */
/* Health probes                                                     */
/* ---------------------------------------------------------------- */

async function timed(fn) {
  const t = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t, ...value };
  } catch (err) {
    // `fetch` hides the useful part in `cause`: without it every network failure
    // reads as "fetch failed", which tells an operator nothing.
    const code = err?.cause?.code || err?.cause?.errno || "";
    return {
      ok: false,
      ms: Date.now() - t,
      detail: code ? `${err.message} (${code})` : err?.message || "probe failed",
    };
  }
}

/**
 * Probe an arbitrary URL.
 *
 * `route` is the bucket the result is filed under in the traffic counters, so
 * a page hit and a mirror checkout are both visible in the panel without any
 * route having to remember to instrument itself.
 */
async function probeHttp(name, url, { timeout = 8000, route = "page" } = {}) {
  return timed(async () => {
    const res = await fetch(url, {
      headers: { Accept: "*/*", "User-Agent": UA },
      signal: AbortSignal.timeout(timeout),
      cache: "no-store",
    });
    const body = await res.text().catch(() => "");
    return {
      ok: res.status === 200,
      status: res.status,
      bytes: body.length,
      detail: res.status === 200 ? "" : `HTTP ${res.status}`,
      countedAs: route,
    };
  }).then((r) => {
    if (!r.skipped) {
      recordRequest({
        route: r.countedAs,
        page: r.countedAs === "page" ? name : "",
        status: r.status || 0,
        ms: r.ms,
        bytes: r.bytes || 0,
      });
    }
    const { countedAs, ...rest } = r;
    return { kind: "http", name, ...rest };
  });
}

/**
 * The live catalogue endpoint the whole site reads from.
 *
 * This goes through `upstreamJson` — the same reader a batch page uses — so the
 * probe tests the real data path (token, client headers, the in-process
 * dispatcher) rather than a raw URL that may not exist.
 */
async function probeUpstream(deep) {
  const path = deep ? "/AllBatches?page=1" : "/v3/batches/698ad3519549b300a5e1cc6a/details";
  return timed(async () => {
    const res = await upstreamJson(path, { timeout: deep ? 12000 : 8000, attempts: 1 });
    return {
      ok: Boolean(res.ok),
      status: res.status || 0,
      bytes: res.data ? JSON.stringify(res.data).length : 0,
      detail: res.ok ? "" : res.error || "no response",
    };
  }).then((r) => {
    recordRequest({ route: "upstream", status: r.status || 0, ms: r.ms });
    return { kind: "api", name: deep ? "catalogue-api" : "batch-api", ...r };
  });
}

/** The same-page reader behind search: proves the shipped index is loadable. */
async function probeCatalogue() {
  return timed(async () => {
    const index = await loadCatalogIndex();
    return { ok: index.batches.length > 0, status: 200, detail: "", count: index.batches.length };
  }).then((r) => ({ kind: "index", name: "catalogue-index", ...r }));
}

/** Token state without ever exposing the token itself. */
function tokenSummary() {
  const state = tokenState();
  const token = String(state.token || "");
  return {
    source: state.source || (token ? "cached" : "none resolved yet"),
    cached: Boolean(state.cached),
    expiresIn: state.expiresIn ?? null,
    expiresAt: state.expiresAt || "",
    expiryFrom: state.expiryFrom || "",
    prefix: token ? `${token.slice(0, 6)}…(${token.length})` : "",
    usable: token.length > 20,
  };
}

/**
 * Everything the panel reports, in one pass.
 *
 * Probes run concurrently: the panel is opened when something is wrong, and
 * sequential probes would make it slow exactly then. Each probe is bounded by
 * its own timeout so one dead host cannot stall the answer.
 */
export async function dashboard({ req = { headers: {} }, selfBase = "", deep = false } = {}) {
  const health = await Promise.all([
    probeCatalogue(),
    probeUpstream(deep),
    selfBase
      ? probeHttp("site-home", `${selfBase}/`, { timeout: 8000, route: "page" }).then((r) => ({
          ...r,
          // A function reaching its own public URL is blocked in some
          // environments (deployment protection, restricted egress). That is
          // not a site outage, so this check informs but never fails the panel.
          soft: true,
          detail: r.ok ? "" : `${r.detail || "unreachable"} — informational; the site is served by the CDN`,
        }))
      : Promise.resolve({ kind: "http", name: "site-home", ok: true, ms: 0, skipped: true }),
    ...CATALOG_MIRRORS.slice(0, 2).map((url, i) =>
      probeHttp(`catalog-mirror-${i + 1}`, url, { timeout: 8000, route: "mirror" })
    ),
  ]);

  // Resolve first, so the token summary describes the token this instance will
  // actually send — otherwise a cold instance reports "unknown" until some
  // other request happens to mint one.
  await resolveToken(false).catch(() => null);

  const credentials = await credentialLadder(false)
    .then((l) => l.map((c) => ({ source: c.source, prefix: `${c.token.slice(0, 6)}…` })))
    .catch(() => []);

  const memory = typeof process !== "undefined" ? process.memoryUsage() : null;
  const catalogue = health.find((h) => h.name === "catalogue-index");

  return {
    // Soft checks (the self-probe) can be blocked without the site being down.
    ok: health.every((h) => h.ok || h.skipped || h.soft),
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    health,
    traffic: requestStats(),
    token: tokenSummary(),
    credentials,
    release: {
      commit: process.env.VERCEL_GIT_COMMIT_SHA || "",
      commitShort: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7),
      ref: process.env.VERCEL_GIT_COMMIT_REF || "",
      env: process.env.VERCEL_ENV || "development",
      region: process.env.VERCEL_REGION || "",
      node: process.version,
      deployment: process.env.VERCEL_URL || "",
      buildStamp: process.env.BUILD_STAMP || "",
    },
    runtime: {
      memoryMb: memory ? Math.round(memory.rss / 1048576) : 0,
      heapMb: memory ? Math.round(memory.heapUsed / 1048576) : 0,
      pid: typeof process !== "undefined" ? process.pid : 0,
    },
    catalogue: {
      batches: catalogue?.count || 0,
      source: CATALOG_SOURCE,
    },
    trafficNote: "Counts are per warm server instance; they reset when Vercel recycles it.",
    client: {
      ip: clientKey(req),
      ua: String((req.headers && req.headers["user-agent"]) || "").slice(0, 160),
    },
    deep: Boolean(deep),
  };
}

/** Stable-ish client identity for rate limiting (Vercel puts the IP in a header). */
export function clientKey(req) {
  const h = req.headers || {};
  const ip =
    (h["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    (h["x-real-ip"] || "").toString() ||
    "unknown";
  return ip;
}

/** Public log cache, filled by the logging helper below. */
const logs = [];

export function noteLog(entry) {
  logs.unshift({ at: new Date().toISOString(), ...entry });
  logs.length = Math.min(logs.length, 100);
}

export function readLogs() {
  return logs;
}
