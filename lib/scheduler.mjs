/**
 * The scheduler: how the site scans itself every five minutes on a plan that
 * will not allow a five-minute cron.
 *
 * ## Why this file exists
 *
 * Vercel's Hobby plan rejects any cron expression that resolves to more than one
 * run per day **at deploy time** — a `*​/5 * * * *` entry in `vercel.json` does not
 * silently run slowly, it fails the deployment. Pro allows per-minute crons. So a
 * five-minute cadence has to come from somewhere else, and this module implements
 * the three honest options in one place:
 *
 *   1. **In-process ticks.** The functions that get traffic are already awake.
 *      Any request may, at most once per `TICK_MS`, run the next scan slice. On a
 *      site with steady traffic this is a five-minute scanner with no scheduler.
 *      On an idle site it does nothing — which is correct, because there is
 *      nothing to scan for.
 *   2. **`vercel.json` crons**, on whatever cadence the plan allows. A daily floor
 *      is the one thing that works on Hobby, so it ships, and the scheduler
 *      notices when the deployment's cron is capable of more.
 *   3. **An external scheduler** — any pinger, a GitHub Action, a laptop cron —
 *      calling `POST /api/scan?key=$SCAN_KEY`. That is the only way to get a true
 *      five-minute pass on Hobby, and the panel says so with the URL to paste.
 *
 * ## What this module is strict about
 *
 * - **Ticks never throw and never wait.** A scan slice that runs inside someone's
 *   request is bounded and detached with `waitUntil` where the runtime offers it;
 *   a visitor must never be slowed down by the site checking itself.
 * - **Ticks never overlap.** One scan slice at a time per instance, enforced by a
 *   promise, not a flag that can be left set by a crash.
 * - **State survives a cold start** where a store is attached: the cursor, the
 *   findings and the repair ledger are written to the same document store the
 *   leaderboard uses, so "every five minutes" means the whole site over time
 *   rather than the first twenty batches forever.
 */

import {
  scanPass,
  scannerState,
  scannerReport,
  restoreScanner,
  noteSharedProgress,
  clearFinding,
  BATCH_WINDOW,
  PASS_BUDGET_MS,
} from "./scanner.mjs";
import { sweep, healerReport, repair, reportFault, SYMPTOMS } from "./healer.mjs";
import { loadCatalogIndex } from "./catalog.mjs";
import { readDoc, writeDoc, storeName } from "./store.mjs";

/** Five minutes, as asked. A tick is a scan slice, not a full scan. */
export const TICK_MS = 5 * 60 * 1000;

/**
 * A slice is deliberately smaller than a standalone pass: it runs beside a
 * request, so it gets half the wall clock and one batch, not the whole window.
 */
export const SLICE_BUDGET_MS = 12000;
export const SLICE_WINDOW = 3;

const DOC_KEY = "arsvibe:scanner:v1";

const state = {
  lastTickAt: 0,
  lastSliceAt: 0,
  lastSliceMs: 0,
  slices: 0,
  repairing: false,
  /** The last thing the scheduler decided, for the panel's "why" column. */
  lastDecision: "no tick yet",
  errors: [],
};

/** One slice at a time. A promise, so a throw cannot leave it permanently set. */
let inFlight = null;
/** The store has been read once this instance; a cold start restores before ticking. */
let restored = false;

/* ---------------------------------------------------------------- */
/* The site's own origin                                             */
/* ---------------------------------------------------------------- */

/**
 * A function reaching its own public URL is blocked in some environments
 * (deployment protection, restricted egress). The scheduler therefore prefers an
 * explicit `SELF_BASE`/`PUBLIC_BASE` when one is set, falls back to the forwarded
 * host, and records the failure as a blind spot instead of a site outage.
 */
export function selfBaseOf(req) {
  const explicit = process.env.SELF_BASE || process.env.PUBLIC_BASE || "";
  if (/^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, "");
  if (!req || !req.headers) return "";
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  if (!host) return "";
  const local = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|$)/.test(host);
  const proto = local
    ? "http"
    : String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}

/* ---------------------------------------------------------------- */
/* Persistence                                                       */
/* ---------------------------------------------------------------- */

export function schedulerState() {
  return {
    ...scannerState(),
    lastTickAt: state.lastTickAt,
    slices: state.slices,
    lastSliceAt: state.lastSliceAt,
    store: storeName(),
  };
}

/**
 * `store.mjs` is the leaderboard's document store reused rather than a second
 * storage layer: one table, one namespace, one thing to attach.
 */
async function persist() {
  try {
    const payload = {
      v: 1,
      scanner: scannerState(),
      findings: scannerReport().open.slice(0, 40),
      totals: scannerReport().totals,
      at: Date.now(),
    };
    await writeDoc(DOC_KEY, payload);
    noteSharedProgress(payload.at);
    return true;
  } catch {
    // A scan that cannot be remembered is still a scan that happened.
    return false;
  }
}

export async function restoreSchedulerState() {
  if (restored) return { restored: false };
  restored = true;
  try {
    const doc = await readDoc(DOC_KEY);
    if (!doc || typeof doc !== "object") return { restored: false, store: storeName() };
    restoreScanner(doc.scanner || {});
    if (doc.at) noteSharedProgress(doc.at);
    return { restored: true, store: storeName(), at: doc.at || 0 };
  } catch {
    return { restored: false, store: storeName() };
  }
}

/* ---------------------------------------------------------------- */
/* The slice                                                         */
/* ---------------------------------------------------------------- */

/**
 * Run one slice: scan a few batches, then hand what was found to the healer.
 *
 * The handoff is the whole design in one line: the scanner reports, the healer
 * decides. A finding naming a symptom goes through `repair()`, which enforces its
 * own cooldown, budget and ladder. A finding with no symptom is counted as an
 * operator's problem and left alone — the site does not guess at fixes it cannot
 * verify.
 */
export async function runSlice({ base, budget = SLICE_BUDGET_MS, window = SLICE_WINDOW, apply = true } = {}) {
  if (inFlight) return { skipped: "already running" };
  if (!base) {
    state.lastDecision = "no origin to scan from — set SELF_BASE";
    return { skipped: "no base" };
  }

  inFlight = (async () => {
    const started = Date.now();
    await restoreSchedulerState();

    let batches = [];
    try {
      const index = await loadCatalogIndex();
      batches = index.batches.map((b) => b.id).filter(Boolean);
    } catch {
      batches = [];
    }

    const pass = await scanPass({
      base,
      batches,
      budget,
      windowSize: window,
      onFinding: () => {},
    }).catch((err) => {
      state.errors.unshift({ at: Date.now(), message: err?.message || "scan threw" });
      state.errors.length = Math.min(state.errors.length, 10);
      return null;
    });

    const actions = [];
    if (pass && apply) {
      // Report before repairing. Every symptom the pass named is now a known
      // fault, so the panel's verdict is wrong-but-visible before the fix and
      // right afterwards — never quietly "healthy" because the scanner does not
      // have its own way of saying "broken".
      for (const f of pass.findings) {
        if (f.symptom && SYMPTOMS[f.symptom] && !f.blind) reportFault(f.symptom, `${f.what} — ${f.where}`);
      }

      // Only the findings that name a symptom this build knows how to repair are
      // acted on, and each repair carries its own cooldown. A pass that finds the
      // same fault five times therefore repairs once and reports five findings.
      const keys = [...new Set(pass.findings.map((f) => f.symptom).filter((s) => s && SYMPTOMS[s]))];
      for (const symptom of keys) {
        const receipt = await repair(symptom, { reason: "site scan" }).catch((err) => ({
          ok: false,
          ran: false,
          error: err?.message || "repair threw",
        }));
        actions.push({ symptom, ...receipt });
        if (receipt.ran && receipt.ok) {
          // The finding that caused a successful repair is cleared: the panel
          // shows what is still wrong, not everything that was ever wrong.
          for (const f of pass.findings.filter((x) => x.symptom === symptom)) clearFinding(f.key, { repaired: true });
        }
      }
      // One probe pass after the repairs, so the panel's readings are post-fix
      // rather than a picture of the site before it fixed itself.
      await sweep({ apply: false, timeout: 5000 }).catch(() => null);
    }

    await persist();

    state.slices += 1;
    state.lastSliceAt = Date.now();
    state.lastSliceMs = Date.now() - started;
    state.lastDecision = pass
      ? `${pass.scanned} batch(es), ${pass.checks} checks, ${pass.findings.length} finding(s), ${actions.filter((a) => a.ran).length} repair(s)`
      : "the scan threw — see errors";

    return { pass, actions, ms: state.lastSliceMs };
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/* ---------------------------------------------------------------- */
/* The tick                                                          */
/* ---------------------------------------------------------------- */

/**
 * How long a request will wait for the slice it started.
 *
 * Detached work is not guaranteed to survive the response: a function that is
 * frozen the moment it answers can cut a slice off mid-walk. `waitUntil` fixes
 * that where the runtime offers it, but it is not always there — so the request
 * that ticks also *holds* for a bounded moment. Three seconds once every five
 * minutes is a price no visitor will notice, and it is the difference between a
 * scheduler that works and one that quietly never finishes anything.
 */
export const TICK_GRACE_MS = 3000;

/**
 * Called from every function that gets traffic. It is cheap when it is not time
 * — two number comparisons — and it never throws.
 *
 * Returns the slice so the caller can hold for it; callers that must not wait a
 * millisecond can ignore the return value and the slice will still run detached.
 */
export function tick(req, { base = "" } = {}) {
  const now = Date.now();
  if (now - state.lastTickAt < TICK_MS) return { ticked: false, nextInMs: TICK_MS - (now - state.lastTickAt) };
  state.lastTickAt = now;

  const origin = base || selfBaseOf(req);
  const run = runSlice({ base: origin }).catch((err) => {
    state.errors.unshift({ at: Date.now(), message: err?.message || "tick threw" });
    state.errors.length = Math.min(state.errors.length, 10);
    return null;
  });

  // Vercel's `waitUntil` is on the request context in some runtimes and on a
  // global in others; both are worth trying, and neither is required.
  const waitUntil =
    (req && typeof req.waitUntil === "function" && req.waitUntil.bind(req)) ||
    (typeof globalThis.waitUntil === "function" && globalThis.waitUntil.bind(globalThis)) ||
    null;
  if (waitUntil) {
    try {
      waitUntil(run);
    } catch {
      /* the slice is still running detached */
    }
  }

  return { ticked: true, at: new Date(now).toISOString(), base: origin, slice: run };
}

/**
 * Wait for the slice a tick started.
 *
 * A tick is deliberately detached (it must not slow the request that triggered
 * it), which makes it racy to observe from outside. Tests need to know when the
 * work is done, and so does a shutdown path that would rather finish a slice than
 * abandon it mid-walk: this is the handle for both.
 */
export function awaitIdle() {
  return inFlight ? inFlight.catch(() => null) : Promise.resolve(null);
}

/** Record a tick that came from outside — the cron, or an operator's pinger. */
export function noteExternalTick(source = "external") {
  state.lastTickAt = Date.now();
  state.lastDecision = `${source} tick`;
}

/* ---------------------------------------------------------------- */
/* Reporting                                                         */
/* ---------------------------------------------------------------- */

/**
 * What the panel shows about the cadence. It is deliberately unflattering: if no
 * scheduler can reach the site, the panel says "idle — nothing is scanning" and
 * gives the URL to fix it, rather than showing a green tick for a scan that never
 * runs.
 */
export function scheduleReport() {
  const now = Date.now();
  const sinceTick = state.lastTickAt ? now - state.lastTickAt : null;
  const report = scannerReport();
  const healer = healerReport();

  return {
    cadenceMs: TICK_MS,
    cadence: "every 5 minutes",
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : "",
    nextTickInMs: sinceTick === null ? 0 : Math.max(0, TICK_MS - sinceTick),
    slices: state.slices,
    lastSliceMs: state.lastSliceMs,
    lastDecision: state.lastDecision,
    store: storeName(),
    errors: state.errors.slice(0, 5),
    scanner: {
      last: report.last,
      progress: report.progress,
      totals: report.totals,
      counts: report.counts,
      open: report.open,
      resolved: report.resolved,
      // The one field that can be seen from a different instance. Without it the
      // panel has nothing to show but this lambda's own silence.
      sharedAt: report.sharedAt,
    },
    healer: {
      verdict: healer.verdict,
      counts: healer.counts,
      probes: healer.probes,
      budget: healer.budget,
      caches: healer.caches,
      ledger: healer.ledger,
      timeline: healer.timeline,
      needsOperator: healer.needsOperator,
    },
    /**
     * The three ways this cadence is delivered, and whether each is available.
     * The panel renders this as a checklist; the operator can see at a glance
     * whether the site is genuinely scanning every five minutes or only when
     * someone happens to visit.
     */
    channels: {
      inProcess: {
        available: true,
        detail: `the first request after each five minutes runs a slice and holds up to ${TICK_GRACE_MS / 1000}s for it; a visitor never notices`,
        lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : "",
      },
      cron: {
        available: Boolean(process.env.VERCEL),
        detail: process.env.VERCEL
          ? "the deployment's cron floor; Hobby allows once a day, Pro allows every five minutes"
          : "not a deployment",
        capable: process.env.SCAN_CRON_EVERY || "varies by plan",
      },
      external: {
        available: Boolean(process.env.SCAN_KEY),
        detail: process.env.SCAN_KEY
          ? "POST /api/scan with the key header — the only true five-minute pass on Hobby"
          : "set SCAN_KEY to allow an external pinger (any scheduler, a GitHub Action)",
        url: process.env.SCAN_KEY ? "POST /api/scan (header: x-scan-key)" : "",
      },
    },
    window: { budgetMs: SLICE_BUDGET_MS, batches: SLICE_WINDOW, passBudgetMs: PASS_BUDGET_MS, passBatches: BATCH_WINDOW },
  };
}

/** Tests start from a clean slate; a redeploy forgets the in-memory half. */
export function resetScheduler() {
  state.lastTickAt = 0;
  state.lastSliceAt = 0;
  state.lastSliceMs = 0;
  state.slices = 0;
  state.lastDecision = "no tick yet";
  state.errors.length = 0;
  inFlight = null;
  restored = false;
}
