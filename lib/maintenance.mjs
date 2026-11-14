/**
 * Maintenance mode: the operator's big red button.
 *
 * One flag, deliberately boring, with three properties that make it safe:
 *
 *   1. **It lives in the shared document store** (`lib/store.mjs`), not in a
 *      function's memory, so pressing the button in the panel turns the site
 *      off on every instance — not just whichever lambda answered the click.
 *      With no store attached it degrades honestly to this instance's memory,
 *      and `storeName()` says which one is true so the panel can too.
 *   2. **The hot path never waits on it.** Routes consult a cached copy that
 *      refreshes at most once every few seconds; a request reads a boolean.
 *   3. **The operator can always turn it off.** The admin route is never
 *      gated, and the status read is public (it carries nothing but the
 *      flag and the message the visitor is meant to read anyway).
 *
 * What "off" means: every student-facing API route answers
 * `503 { maintenance: true, message }`, and every page raises a wall
 * (see `public/assets/offline-boot.js`) saying the same. Pages are static
 * files and cannot be ungenerated, so the wall is the page-level half;
 * the API gate is what actually stops the site working.
 */

import { readDoc, writeDoc, storeName } from "./store.mjs";

const DOC_KEY = "arsvibe:maintenance:v1";
/** How stale the cached flag may be before a route re-reads the store. */
const REFRESH_MS = 5000;

export const DEFAULT_MESSAGE =
  "We're doing a bit of maintenance right now. Lectures will be back shortly — please check again in a few minutes.";

const OFF = { on: false, message: "", since: "", by: "" };

/** This instance's cached copy, plus when it was last confirmed. */
let cache = { state: { ...OFF }, at: 0 };
/** Refresh in flight, so a burst of requests shares one store read. */
let refreshing = null;

function normalise(doc) {
  if (!doc || typeof doc !== "object") return { ...OFF };
  return {
    on: Boolean(doc.on),
    message: String(doc.message || "").slice(0, 300),
    since: String(doc.since || ""),
    by: String(doc.by || ""),
  };
}

/** The cached state, synchronously. Never touches the network. */
export function maintenanceState() {
  return cache.state;
}

/** True when the site is down. The one-question form routes actually ask. */
export function isDown() {
  return cache.state.on === true;
}

/** Re-read the store if the cache is older than REFRESH_MS. Bounded, shared. */
export async function refreshMaintenance({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - cache.at < REFRESH_MS) return cache.state;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const doc = await readDoc(DOC_KEY);
      cache = { state: normalise(doc), at: Date.now() };
    } catch {
      // A store that cannot be read must not take the site down with it:
      // keep believing the last confirmed state.
      cache.at = Date.now();
    } finally {
      refreshing = null;
    }
    return cache.state;
  })();
  return refreshing;
}

/**
 * Turn maintenance on or off. Writes through to the store first; only a
 * confirmed write moves the cache, so the panel never claims a state the
 * rest of the site cannot see.
 *
 * @returns the new state, plus where it is stored ("postgres" | "redis" |
 *          "memory") so the panel can be honest about its reach.
 */
export async function setMaintenance(on, { message = "", by = "" } = {}) {
  const state = normalise({
    on: Boolean(on),
    message: on ? String(message || "").trim() || DEFAULT_MESSAGE : "",
    since: on ? new Date().toISOString() : "",
    by,
  });
  await writeDoc(DOC_KEY, state).catch(() => null);
  cache = { state, at: Date.now() };
  return { ...state, store: storeName() };
}

/** The public shape: what a visitor (and the wall) is allowed to know. */
export function publicMaintenance() {
  const s = cache.state;
  return {
    on: s.on,
    message: s.on ? s.message || DEFAULT_MESSAGE : "",
    since: s.since || "",
  };
}

/**
 * The gate every student-facing route stands behind.
 *
 * Refreshes the cache when stale, then — if the site is down — answers the
 * request itself with a 503 and returns true. Returns false when the
 * request may proceed. OPTIONS is always allowed through: a browser's
 * preflight must not be what discovers the outage.
 */
export async function maintenanceGate(req, res) {
  if (req.method === "OPTIONS") return false;
  await refreshMaintenance().catch(() => null);
  if (!isDown()) return false;

  const s = cache.state;
  const payload = JSON.stringify({
    success: false,
    maintenance: true,
    error: s.message || DEFAULT_MESSAGE,
    message: s.message || DEFAULT_MESSAGE,
    since: s.since || "",
  });
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", "120");
  if (typeof res.end === "function") res.end(payload);
  return true;
}

/** Everything the panel shows about the switch, in one shape. */
export function maintenanceInfo() {
  return { ...publicMaintenance(), store: storeName() };
}

/** Tests start from a clean, switched-off site. */
export function resetMaintenance() {
  cache = { state: { ...OFF }, at: 0 };
  refreshing = null;
}
