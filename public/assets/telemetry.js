/* =========================================================================
   The browser's own report.

   Everything the healer knows about today comes from the server: a status code,
   a probe, a scan. That leaves the largest class of real bugs completely
   invisible — a page that answers 200 and then throws. The catalogue renders, a
   module fails to parse, a template hits an undefined property, a promise
   rejects and the grid stays empty. The status was fine. The site is broken. No
   probe and no scan can see it, because the failure happens in the browser after
   the response was already sent.

   This module is the missing sense: it listens to the browser's own error
   channels and reports *aggregated* evidence, not individual exceptions.

   The rules it is built on, because a self-reporting client can easily become
   its own outage:

   1. Never more than a handful of requests per page view. Errors are bucketed by
      a stable fingerprint and counted locally; the server sees the bucket, not
      the exception.
   2. Nothing personal leaves the page. A message is truncated, URLs inside it
      are reduced to their path, and query strings are stripped — a lecture URL
      carries a signature and a student id in its query.
   3. It cannot fail loudly. Every call is wrapped, the beacon is
      `keepalive`, and a network failure is swallowed. Telemetry is never
      load-bearing.
   4. It stays quiet when things are fine: an error that has already been
      reported on this page view is not reported again, and a page that reports
      nothing sends nothing.

   What it listens to:

     · `error` — script errors, including the stack's top frame, which is what
       turns "something threw" into "the module at this URL threw".
     · `unhandledrejection` — the majority of real-world breakage in an
       ES-module site: an await that rejected and nobody caught.
     · `error` in the *capture* phase on elements — a resource (script, stylesheet,
       image, module) that failed to load. These do not bubble, so they need the
       capture flag, and they are the cleanest signal that a deploy shipped a
       file that is not there.
   ========================================================================= */

/** How many distinct faults one page view will report. */
const MAX_FINGERPRINTS = 6;
/** How many times the same fingerprint is counted before it stops mattering. */
const MAX_PER_FINGERPRINT = 50;
/** A message longer than this is truncated; the tail is rarely the useful part. */
const MESSAGE_MAX = 240;
/** The endpoint. It is a rewrite onto the admin function, so no extra lambda. */
const ENDPOINT = "/api/client-error";

/** Stable id → { count, first, last, sent }. Reset on every page view. */
const buckets = new Map();
/** Which fingerprints have already been sent from this page view. */
const sent = new Set();
let installed = false;
let flushTimer = null;

/**
 * Strip the things that must not leave the page.
 *
 * A stack line or a resource URL can carry a signed lecture token and a student
 * id in its query string. The path is the part that identifies the bug; the
 * query is the part that identifies the person.
 */
export function scrub(text, limit = MESSAGE_MAX) {
  if (!text) return "";
  let out = String(text);
  // Query strings and fragments go first, before anything else can re-add them.
  out = out.replace(/(https?:\/\/[^\s"')]+)/g, (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url.split("?")[0].split("#")[0];
    }
  });
  // Same-origin absolute paths with a query string.
  out = out.replace(/(\/[a-z0-9._~%/-]*)\?[^\s"')]*/gi, "$1");
  // A bare JWT or a long opaque token, wherever it appears.
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[token]");
  // Email addresses: the site has accounts, so a stray one must not be logged.
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, "[email]");
  return out.length > limit ? out.slice(0, limit - 1) + "…" : out;
}

/**
 * A stable identity for a fault.
 *
 * The message alone is too coarse: "Cannot read properties of undefined" happens
 * in a dozen places. The message plus the top stack frame is specific enough to
 * group a real bug and stable enough that two visitors hitting it land in the
 * same bucket — which is what makes "how many people hit this" answerable.
 */
export function fingerprint({ kind = "error", message = "", source = "", line = 0, column = 0 }) {
  const where = source ? `${source}:${line || 0}` : "";
  return `${kind}|${scrub(message, 120)}|${scrub(where, 120)}|${column || 0}`;
}

/** The page this happened on, as a path. Never a URL with a query in it. */
function pageOf() {
  try {
    return scrub((location && location.pathname) || "/", 120) || "/";
  } catch {
    return "/";
  }
}

/** The build this page was served from, so a report can be tied to a deploy. */
function buildOf() {
  try {
    const meta = document.querySelector('meta[name="build"]');
    return meta ? String(meta.getAttribute("content") || "").slice(0, 40) : "";
  } catch {
    return "";
  }
}

function bucketFor(print) {
  let entry = buckets.get(print);
  if (!entry) {
    if (buckets.size >= MAX_FINGERPRINTS) return null;
    entry = { print, count: 0, first: Date.now(), last: 0 };
    buckets.set(print, entry);
  }
  return entry;
}

/**
 * Record one fault.
 *
 * Exported so the player can report a fault that *it* diagnoses but the browser
 * never throws — a segment that six times in a row could not be decoded is a bug
 * even though no exception was raised.
 */
export function note({ kind = "error", message = "", source = "", line = 0, column = 0, detail = "" } = {}) {
  try {
    const msg = scrub(message);
    // A message that scrubs down to nothing is not evidence of anything.
    if (!msg || msg === "Script error.") return false;
    const print = fingerprint({ kind, message: msg, source, line, column });
    const entry = bucketFor(print);
    if (!entry) return false;
    entry.count = Math.min(MAX_PER_FINGERPRINT, entry.count + 1);
    entry.last = Date.now();
    entry.payload = {
      kind: String(kind).slice(0, 24),
      message: msg,
      source: scrub(source, 120),
      line: Number(line) || 0,
      column: Number(column) || 0,
      detail: scrub(detail, 160),
      page: pageOf(),
      build: buildOf(),
    };
    scheduleFlush();
    return true;
  } catch {
    return false; // telemetry is never load-bearing
  }
}

/**
 * Send what has not been sent yet.
 *
 * One request per flush, however many buckets are waiting. A page that has just
 * had a bad deploy can throw hundreds of times; the server must see six buckets,
 * not hundreds of requests.
 */
export function flush({ force = false } = {}) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const pending = [];
    for (const entry of buckets.values()) {
      if (sent.has(entry.print) && !force) continue;
      pending.push({ ...entry.payload, fingerprint: entry.print, count: entry.count });
      sent.add(entry.print);
    }
    if (!pending.length) return 0;

    const body = JSON.stringify({ page: pageOf(), build: buildOf(), faults: pending });

    // `sendBeacon` survives the tab closing, which is exactly when the last
    // error usually happens. It cannot set a content type, so the server reads
    // the body as JSON regardless of what the browser claims.
    if (navigator && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return pending.length;
    }
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
    return pending.length;
  } catch {
    return 0;
  }
}

/**
 * Wait a moment before sending.
 *
 * The first error of a page view usually arrives with two more behind it — the
 * module fails to parse, then every consumer of it throws. Sending immediately
 * costs four beacons for one bug.
 */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1200);
}

/** Install the listeners. Idempotent, and a no-op outside a browser. */
export function install() {
  if (installed) return false;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return false;
  installed = true;

  // Script errors. `event.error.stack` carries the frame that identifies the bug;
  // the filename and line are the fallback when it is cross-origin.
  window.addEventListener("error", (event) => {
    // A resource that failed to load dispatches `error` on the *element*, which
    // does not bubble but is caught here in the capture phase.
    const target = event && event.target;
    if (target && target !== window && target.tagName) {
      const tag = String(target.tagName).toLowerCase();
      const what = target.src || target.href || "";
      if (tag === "script" || tag === "link" || tag === "img" || tag === "video" || tag === "source") {
        // A missing image is a cosmetic problem, not a bug: every `onerror` in
        // this site already removes it. Scripts and stylesheets are the ones
        // that leave a page broken.
        if (tag === "img") return;
        note({ kind: "resource", message: `${tag} failed to load`, source: what, detail: target.id || "" });
      }
      return;
    }

    const stack = event && event.error && event.error.stack ? String(event.error.stack) : "";
    // The second line of a stack is the throwing frame; the first is the error.
    const frame = stack.split("\n").find((line) => /:\d+:\d+/.test(line) && !/^\w*Error/.test(line.trim())) || "";
    const frameMatch = frame.match(/([^()\s]+):(\d+):(\d+)/);

    note({
      kind: "error",
      message: (event && event.message) || (event && event.error && event.error.message) || "Script error.",
      source: (event && event.filename) || (frameMatch && frameMatch[1]) || "",
      line: (event && event.lineno) || (frameMatch && Number(frameMatch[2])) || 0,
      column: (event && event.colno) || (frameMatch && Number(frameMatch[3])) || 0,
      detail: frame ? frame.trim().slice(0, 160) : "",
    });
  }, true);

  // Rejected promises: in an ES-module site this is most of the real breakage.
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    const message = typeof reason === "string" ? reason : (reason && reason.message) || "";
    const stack = (reason && reason.stack) || "";
    const frame = stack.split("\n").find((line) => /:\d+:\d+/.test(line)) || "";
    const frameMatch = frame.match(/([^()\s]+):(\d+):(\d+)/);
    note({
      kind: "rejection",
      message: message || "a promise rejected with no message",
      source: (frameMatch && frameMatch[1]) || "",
      line: (frameMatch && Number(frameMatch[2])) || 0,
      column: (frameMatch && Number(frameMatch[3])) || 0,
      detail: frame ? frame.trim().slice(0, 160) : "",
    });
  });

  // The last chance to send: a fault in the final second of a page view would
  // otherwise be lost, and that is often the one that made the student leave.
  window.addEventListener("pagehide", () => flush({ force: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush({ force: true });
  });

  return true;
}

/** Test seam: clear the buckets between cases. */
export function reset() {
  buckets.clear();
  sent.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  installed = false;
}

/** Test seam: what is waiting to be sent. */
export function pending() {
  return [...buckets.values()].map((e) => ({ ...e.payload, fingerprint: e.print, count: e.count }));
}

/* ------------------------------------------------------------------ booting */

/*
 * Every page loads this module, and listening is the only thing it must do on
 * load — there is no render, no DOM, and nothing to wait for. The guard keeps the
 * module importable from a Node test, where neither global exists.
 */
if (typeof window !== "undefined" && typeof document !== "undefined") {
  install();
}
