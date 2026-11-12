/**
 * The browser fault log.
 *
 * The scanner and the probes can both only see what the *server* did. A page that
 * answers 200 and then throws in the browser is invisible to both — the response
 * was fine, the site is broken. `public/assets/telemetry.js` reports those
 * faults; this module is where they land, and it exists so the healer has one
 * thing to ask: "is anything in the browser broken right now?"
 *
 * ## Why a ring buffer and not a database
 *
 * These are aggregated counts, not records. Nobody needs the fourth hundred
 * occurrence of the same fingerprint, and keeping them would mean a table of
 * personal data (a stack trace can carry a student id in a URL) in exchange for
 * no extra signal. A bounded buffer of distinct fingerprints, with a count, an
 * age and the page it happened on, answers every question the healer asks:
 * *which* bug, *how many* people, *how recently*, *on which page*.
 *
 * ## What it is careful about
 *
 * - **The buffer is bounded twice**: by distinct fingerprints and by total
 *   occurrences, so a page stuck in a throw loop cannot exhaust memory.
 * - **Nothing is trusted from the wire.** Every field is coerced, truncated and
 *   re-scrubbed server-side — the client *says* it removed tokens and emails, and
 *   the server does not take its word for it.
 * - **One bug is one row.** Sightings of the same fingerprint fold together and
 *   keep the first and last time, so "500 errors on /batches in the last hour" is
 *   a single line, not 500.
 * - **Credit is bounded.** A source address can report at most a few times a
 *   minute; beyond that it is ignored rather than throttled with an error, because
 *   a client that is throwing does not need an HTTP 429 on top of it.
 */

/** Distinct faults kept. Six buckets per page view, so this is many pages. */
const FAULTS_MAX = 80;
/** Total occurrences counted across all faults. */
const OCCURRENCES_MAX = 5000;
/** A fault older than this is not "right now" any more. */
const FAULT_TTL_MS = 6 * 60 * 60 * 1000;
/** Distinct faults in the last `RECENT_MS` that count as a broken page. */
export const RECENT_MS = 15 * 60 * 1000;
/** How many reports one address may make per window. */
const REPORTS_PER_WINDOW = 20;
const REPORT_WINDOW_MS = 60 * 1000;

/**
 * @type {Map<string, {
 *   fingerprint: string, kind: string, message: string, source: string,
 *   page: string, build: string, detail: string,
 *   count: number, first: number, last: number, pages: Map<string, number>
 * }>}
 */
const faults = new Map();
/** address → { n, at } for the report throttle. */
const reporters = new Map();
/** Total occurrences ever counted into the buffer (not the total ever seen). */
let occurrences = 0;
/** Rejected reports, for the panel's honesty line. */
let rejected = 0;
/** Reports accepted. */
let reports = 0;

const clean = (value, max) => {
  const text = String(value == null ? "" : value)
    // The client claims to have done this; the server does it again rather than
    // trusting a caller that is, by definition, malfunctioning.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[token]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, "[email]")
    .replace(/(\/[a-z0-9._~%/-]*)\?[^\s"')]*/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};

/** Trim expired faults and rebuild the occurrence total. */
function prune(now = Date.now()) {
  for (const [key, fault] of faults) {
    if (now - fault.last > FAULT_TTL_MS) faults.delete(key);
  }
  let total = 0;
  for (const fault of faults.values()) total += fault.count;
  occurrences = total;
}

/**
 * Accept one report from a browser.
 *
 * Returns a receipt: how many faults were counted and how many were dropped. The
 * client does not act on it — it is there so the route can answer honestly and so
 * a test can assert what happened rather than guessing.
 */
export function ingest(payload, { address = "", now = Date.now() } = {}) {
  const key = String(address || "").slice(0, 60) || "unknown";
  const seen = reporters.get(key);
  if (seen && now - seen.at < REPORT_WINDOW_MS) {
    if (seen.n >= REPORTS_PER_WINDOW) {
      rejected += 1;
      return { accepted: 0, dropped: 0, throttled: true };
    }
    seen.n += 1;
  } else {
    reporters.set(key, { n: 1, at: now });
  }

  const list = Array.isArray(payload && payload.faults) ? payload.faults.slice(0, 8) : [];
  // The report carries the page once and each fault may refine it. Reading only
  // the per-fault value made every fault land on "/" — which turned the one field
  // that says *where* the site is broken into a constant.
  const reportPage = clean(payload && payload.page, 120);
  let accepted = 0;
  let dropped = 0;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      continue;
    }
    const message = clean(raw.message, 240);
    // A fault with no message is not a fault we can act on.
    if (!message) {
      dropped += 1;
      continue;
    }
    const kind = clean(raw.kind, 24) || "error";
    const source = clean(raw.source, 140);
    const page = clean(raw.page, 120) || reportPage || "/";
    const print = clean(raw.fingerprint, 200) || `${kind}|${message}|${source}`;
    const count = Math.max(1, Math.min(500, Number(raw.count) || 1));

    let fault = faults.get(print);
    if (!fault) {
      // Newest first is the panel's order; a Map is insertion-ordered, so the
      // oldest is evicted from the front when the buffer is full.
      if (faults.size >= FAULTS_MAX) {
        const oldest = faults.keys().next().value;
        faults.delete(oldest);
      }
      fault = {
        fingerprint: print,
        kind,
        message,
        source,
        page,
        build: clean(raw.build, 40),
        detail: clean(raw.detail, 160),
        count: 0,
        first: now,
        last: now,
        pages: new Map(),
      };
      faults.set(print, fault);
    }

    fault.count += count;
    fault.last = now;
    fault.message = message;
    fault.page = page;
    if (raw.detail) fault.detail = clean(raw.detail, 160);
    const onPage = fault.pages.get(page) || 0;
    fault.pages.set(page, onPage + count);
    accepted += 1;
  }

  prune(now);
  // Bound the total as well as the distinct count: one fingerprint in a throw
  // loop is still one row, but its count must not grow without limit.
  if (occurrences > OCCURRENCES_MAX) {
    const over = occurrences - OCCURRENCES_MAX;
    for (const fault of faults.values()) {
      if (over <= 0) break;
      const cut = Math.min(over, Math.floor(fault.count / 2));
      fault.count -= cut;
      occurrences -= cut;
    }
  }
  reports += 1;

  return { accepted, dropped, throttled: false };
}

/**
 * What the healer asks: is the browser broken, how badly, and where.
 *
 * `recent` is deliberately narrow — the last fifteen minutes. An error that was
 * fixed this morning is history; an error that is still counting is a fault, and
 * the difference is what decides whether the healer reports or repairs.
 */
export function clientFaults({ now = Date.now(), limit = 40 } = {}) {
  prune(now);
  const open = [...faults.values()]
    .filter((f) => now - f.last <= FAULT_TTL_MS)
    .sort((a, b) => b.last - a.last);

  const recent = open.filter((f) => now - f.last <= RECENT_MS);
  const byPage = new Map();
  for (const fault of recent) {
    for (const [page, count] of fault.pages) {
      byPage.set(page, (byPage.get(page) || 0) + count);
    }
  }

  return {
    at: new Date(now).toISOString(),
    open: open.slice(0, limit).map((f) => ({
      fingerprint: f.fingerprint,
      kind: f.kind,
      message: f.message,
      source: f.source,
      detail: f.detail,
      page: f.page,
      build: f.build,
      count: f.count,
      firstAt: new Date(f.first).toISOString(),
      lastAt: new Date(f.last).toISOString(),
      ageMs: now - f.first,
    })),
    recent: recent.map((f) => ({
      fingerprint: f.fingerprint,
      kind: f.kind,
      message: f.message,
      page: f.page,
      count: f.count,
    })),
    counts: {
      distinct: open.length,
      recentDistinct: recent.length,
      recentOccurrences: recent.reduce((sum, f) => sum + f.count, 0),
      occurrences: occurrences,
      reports,
      rejected,
    },
    /* The pages where it is happening, worst first — the one thing that turns a
       list of exceptions into "the catalogue grid is broken". */
    pages: [...byPage.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([page, count]) => ({ page, count })),
    recentMs: RECENT_MS,
  };
}

/* ------------------------------------------------------------ persistence */

/**
 * Where a shared copy lives, when the project has a store configured.
 *
 * The buffer above is per warm instance, and a report that lands on one lambda is
 * invisible to the panel if the next request is served by another. The scanner
 * solved this the same way — one store document, written behind the request — and
 * it is the difference between a fault log that shows *a* lambda's view and one
 * that shows the site's.
 */
const DOC = "arsvibe:client-faults:v1";
/** One write behind at a time, and not more than once per window. */
let writing = null;
let writtenAt = 0;
const WRITE_EVERY_MS = 20000;

/** A snapshot small enough to be worth storing: fingerprints and counts only. */
function snapshot(now = Date.now()) {
  return {
    at: now,
    faults: [...faults.values()]
      .filter((f) => now - f.last <= FAULT_TTL_MS)
      .slice(-FAULTS_MAX)
      .map((f) => ({
        fingerprint: f.fingerprint,
        kind: f.kind,
        message: f.message,
        source: f.source,
        page: f.page,
        build: f.build,
        detail: f.detail,
        count: f.count,
        first: f.first,
        last: f.last,
        pages: [...f.pages.entries()].slice(0, 8),
      })),
  };
}

/**
 * Publish what this instance has seen.
 *
 * Best effort and deliberately quiet: a store that is slow, full or absent must
 * never make a bug report fail. The in-memory buffer is the source of truth for
 * this instance either way, so the only thing lost is visibility from elsewhere.
 */
export async function persistClientFaults({ force = false, now = Date.now() } = {}) {
  if (writing) return false;
  if (!force && now - writtenAt < WRITE_EVERY_MS) return false;
  writing = (async () => {
    try {
      const { writeDoc } = await import("./store.mjs");
      await writeDoc(DOC, snapshot(now));
      writtenAt = now;
      return true;
    } catch {
      return false;
    } finally {
      writing = null;
    }
  })();
  return writing;
}

/**
 * Fold in what other instances have reported.
 *
 * The merge takes the *higher* count per fingerprint and the later sighting, so a
 * fault seen by four lambdas reads as one row with the largest count rather than
 * being quadrupled by whoever read it last. A local count that has already passed
 * the stored one is kept: this instance has strictly more evidence.
 */
export async function hydrateClientFaults({ now = Date.now() } = {}) {
  try {
    const { readDoc } = await import("./store.mjs");
    const doc = await readDoc(DOC);
    if (!doc || !Array.isArray(doc.faults)) return 0;
    let merged = 0;
    for (const row of doc.faults.slice(-FAULTS_MAX)) {
      if (!row || !row.fingerprint || !row.message) continue;
      if (now - (row.last || 0) > FAULT_TTL_MS) continue;
      const local = faults.get(row.fingerprint);
      if (!local) {
        if (faults.size >= FAULTS_MAX) continue;
        faults.set(row.fingerprint, {
          fingerprint: row.fingerprint,
          kind: clean(row.kind, 24) || "error",
          message: clean(row.message, 240),
          source: clean(row.source, 140),
          page: clean(row.page, 120) || "/",
          build: clean(row.build, 40),
          detail: clean(row.detail, 160),
          count: Math.max(1, Number(row.count) || 1),
          first: Number(row.first) || now,
          last: Number(row.last) || now,
          pages: new Map(Array.isArray(row.pages) ? row.pages.slice(0, 8) : []),
        });
        merged += 1;
        continue;
      }
      if ((Number(row.count) || 0) > local.count) local.count = Number(row.count);
      if ((Number(row.last) || 0) > local.last) local.last = Number(row.last);
      merged += 1;
    }
    if (merged) {
      let total = 0;
      for (const fault of faults.values()) total += fault.count;
      occurrences = total;
    }
    return merged;
  } catch {
    return 0;
  }
}

/** Tests and a redeploy: forget what this instance has seen. */
export function resetClientFaults() {
  faults.clear();
  reporters.clear();
  occurrences = 0;
  rejected = 0;
  reports = 0;
}

/**
 * One line for the panel, and the same decision the healer uses.
 *
 * A single visitor hitting a single exception is not a broken site. The same
 * fingerprint three times, or two different faults on the same page, is — that is
 * what a bad deploy looks like from the browser's side.
 */
export function clientFaultVerdict(report = clientFaults()) {
  const { recentDistinct, recentOccurrences } = report.counts;
  if (!recentDistinct) return { level: "ok", page: "", summary: "no script errors reported" };
  const worst = report.pages[0];
  if (recentOccurrences >= 5 || recentDistinct >= 2) {
    return {
      level: "bad",
      page: worst ? worst.page : "",
      summary: `${recentDistinct} distinct script error(s), ${recentOccurrences} in the last ${Math.round(RECENT_MS / 60000)} minutes${worst ? ` — worst on ${worst.page}` : ""}`,
    };
  }
  return {
    level: "warn",
    page: worst ? worst.page : "",
    summary: `${recentOccurrences} script error(s) in the last ${Math.round(RECENT_MS / 60000)} minutes`,
  };
}
