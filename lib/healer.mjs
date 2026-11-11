/**
 * The healer: self-healing as a *state machine*, not a pile of special cases.
 *
 * `lib/selfheal.mjs` knows how to react to a fault that a request happened to
 * report. This module is the layer above it, and it answers the two questions
 * that file deliberately does not:
 *
 *   1. **Is anything actually wrong?** It runs its own probe suite — the
 *      catalogue index, the token ladder, every signer host, the playback relay,
 *      the error rate, this instance's memory, the asset manifest — so a fault
 *      is found by *looking*, not only by waiting for a visitor to trip over it.
 *   2. **What is the smallest thing that fixes it?** Each symptom maps to a
 *      named repair with a fixed escalation ladder. A repair runs at the lowest
 *      rung that can possibly help, and only climbs when the same symptom comes
 *      back after a repair failed to hold it.
 *
 * The lifecycle of every symptom is the same five states:
 *
 *      healthy → degraded → repairing → repaired → (healthy)
 *                              ↓
 *                          escalated → failed → (operator)
 *
 * and the rules that keep a self-repairing system from becoming a hazard:
 *
 *   • **Probe first, act second.** A repair needs evidence from at least one
 *     probe, never a hunch. (The reactive path in `selfheal.mjs` keeps its own
 *     evidence counters.)
 *   • **Bounded.** Every repair has a maximum rung, a cooldown, and a per-hour
 *     budget shared with the reactive ledger. Nothing runs in a loop.
 *   • **Self-reverting.** Every action touches a cache or a preference this
 *     process owns. Nothing deletes data, nothing deploys code, nothing edits a
 *     credential.
 *   • **Accountable.** Every transition lands on the ledger with the probe
 *     reading that caused it, so the panel can show *why*, not just *what*.
 *
 * A repair that would need a deploy is not a repair. It is reported as
 * `needsOperator`, with the exact rung that was reached, and then left alone.
 */

import * as selfheal from "./selfheal.mjs";

/* ---------------------------------------------------------------- */
/* Time                                                              */
/* ---------------------------------------------------------------- */

/**
 * The clock is injectable so a test can age a cooldown, a probe or the budget
 * window without sleeping for an hour. Everything in this module asks `nowMs()`
 * — never `Date.now()` directly — and `setNow()` is the single seam.
 */
let clock = () => Date.now();
export function setNow(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}
export function nowMs() {
  return clock();
}

/* ---------------------------------------------------------------- */
/* The health graph                                                  */
/* ---------------------------------------------------------------- */

/**
 * The symptoms this system knows how to recognise. Each one is a *class* of
 * fault with several possible causes, which is why detection is a list of hints
 * rather than a single test: "the catalogue is unreadable" and "the catalogue
 * index is empty" are the same symptom from an operator's point of view and the
 * same repair from the healer's.
 */
export const SYMPTOMS = {
  "catalog.unreadable": {
    label: "Catalogue index unreadable",
    severity: "high",
    blurb: "The shipped batch index failed to load, so search and browse cannot answer.",
    repair: "catalog.reload",
  },
  "catalog.empty": {
    label: "Catalogue index empty",
    severity: "high",
    blurb: "The index loaded but carries no batches — the worst possible state, because it looks healthy.",
    repair: "catalog.reload",
  },
  "token.exhausted": {
    label: "No usable guest token",
    severity: "high",
    blurb: "Every credential on the ladder was empty or rejected, so upstream calls would 401.",
    repair: "token.remint",
  },
  "token.expiring": {
    label: "Guest token expiring",
    severity: "low",
    blurb: "The token has under two minutes left: a re-mint now is invisible, a 401 later is not.",
    repair: "token.remint",
  },
  "signer.degraded": {
    label: "Signer ladder degraded",
    severity: "medium",
    blurb: "One or more signing hosts are failing, so resolution spends its budget on dead mirrors.",
    repair: "signer.quarantine",
  },
  "relay.failing": {
    label: "Playback relay failing",
    severity: "medium",
    blurb: "The byte relays are reporting repeated failures, which usually means poisoned caches.",
    repair: "cache.plans",
  },
  "traffic.errors": {
    label: "Error rate above threshold",
    severity: "medium",
    blurb: "A large share of requests are failing. The healer cannot see why, but it can clear what it owns.",
    repair: "cache.plans",
  },
  "runtime.memory": {
    label: "Instance memory high",
    severity: "medium",
    blurb: "Heap is close to the function's limit; a cold start is imminent if it is not relieved.",
    repair: "cache.trim",
  },
  "assets.stale": {
    label: "Asset manifest mismatch",
    severity: "low",
    blurb: "The build manifest and the shipped files disagree, so a browser may request a file that is not there.",
    repair: "assets.verify",
  },
  "site.page": {
    label: "A page is not being served",
    severity: "high",
    blurb: "The scanner asked for a page the build promises and got a 404 or an error page instead of the page.",
    repair: "site.recheck",
  },
  "api.upstream": {
    label: "The upstream is refusing a route",
    severity: "high",
    blurb: "A data route answered an error or a failure envelope, so the page behind it has nothing to show.",
    repair: "upstream.recover",
  },
  "api.route": {
    label: "An API route is misbehaving",
    severity: "medium",
    blurb: "A route answered something other than the contract's shape — an error envelope, a 500, or a hang.",
    repair: "route.recheck",
  },
};

/** Every repair, in the order its rungs are tried. */
export const REPAIRS = {
  "catalog.reload": {
    label: "Reload the catalogue index",
    rungs: [
      { id: "drop-cache", label: "Drop the memoised index" },
      { id: "rebuild", label: "Re-read and rebuild it from the shipped file" },
    ],
    needsOperator: "The index file itself is missing or corrupt; that needs a deploy.",
  },
  "token.remint": {
    label: "Re-mint the guest token",
    rungs: [
      { id: "drop-token", label: "Discard the cached token" },
      { id: "remint", label: "Ask the signer for a fresh one" },
    ],
    needsOperator: "Every credential source is refusing; the deployment's token needs attention.",
  },
  "signer.quarantine": {
    label: "Take failing signers out of rotation",
    rungs: [
      { id: "reset-ladder", label: "Clear the failure counters so the ladder re-orders from evidence" },
      { id: "quarantine", label: "Reprobe every host and quarantine the dead ones" },
    ],
    needsOperator: "Every signer is refusing; no mirror is left to fail over to.",
  },
  "cache.plans": {
    label: "Drop poisoned playback plans",
    rungs: [
      { id: "drop-plans", label: "Empty the plan cache so the next request re-probes" },
      { id: "drop-renditions", label: "Empty the rendition cache as well" },
      { id: "drop-both", label: "Drop both and the guest token with them" },
    ],
    needsOperator: "Plans keep poisoning after a full cache drop; the resolver itself is wrong.",
  },
  "cache.trim": {
    label: "Trim what this instance is holding",
    rungs: [
      { id: "trim-plans", label: "Drop plan entries and suggest a collection" },
      { id: "trim-all", label: "Drop every cache the healer owns" },
    ],
    needsOperator: "Heap stays above the limit after every cache is emptied.",
  },
  "assets.verify": {
    label: "Verify the shipped asset manifest",
    rungs: [{ id: "check-manifest", label: "Compare build.json against the files on disk" }],
    needsOperator: "A promised file is missing; only a deploy can put it back.",
  },
  "site.recheck": {
    label: "Re-request the page that failed",
    rungs: [
      { id: "reload-catalog", label: "Rebuild the catalogue index the page renders from" },
      { id: "re-request", label: "Request the page again and believe the second answer" },
    ],
    needsOperator: "The page is still missing after two attempts; the deployment is serving the wrong tree.",
  },
  "upstream.recover": {
    label: "Recover the upstream call path",
    rungs: [
      { id: "fresh-token", label: "Re-mint the guest token a refused call would have used" },
      { id: "drop-caches", label: "Drop the cached answers, then re-mint again" },
      { id: "reweight-signers", label: "Reset the signer evidence so the ladder re-orders" },
    ],
    needsOperator: "Every credential and every mirror is being refused; the upstream is down or blocking this deployment.",
  },
  "route.recheck": {
    label: "Clear what this instance is holding, then re-request",
    rungs: [
      { id: "drop-caches", label: "Drop the plan and rendition caches a bad answer may be cached in" },
      { id: "remint-token", label: "Re-mint the guest token and drop the caches again" },
    ],
    needsOperator: "The route keeps failing with every cache cleared and a fresh token; the upstream is refusing us.",
  },
};

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

/**
 * One record per symptom. `status` is the lifecycle state, `rung` is how far up
 * the repair ladder this symptom has had to climb, and `strikes` counts how many
 * times a repair has failed to hold it — the escalation signal.
 */
const state = new Map();
/** action+host → when the cooldown ends, shared across symptoms. */
const cooldowns = new Map();
/** symptom key → consecutive failed repairs. */
const strikes = new Map();

const COOLDOWN_MS = {
  low: 10 * 60 * 1000,
  medium: 3 * 60 * 1000,
  high: 60 * 1000,
};

/** Rungs tried at once is bounded; so is how far a symptom may climb. */
const MAX_STRIKES = 4;
/** History for the timeline; the ledger in `selfheal.mjs` holds the repairs. */
const TIMELINE_MAX = 120;

/** @type {Array<{at:number, key:string, from:string, to:string, note:string}>} */
const timeline = [];

function record(key, from, to, note = "") {
  const at = nowMs();
  timeline.unshift({ at, key, from, to, note });
  timeline.length = Math.min(timeline.length, TIMELINE_MAX);
}

function recordFor(key) {
  let s = state.get(key);
  if (!s) {
    s = {
      key,
      status: "healthy",
      rung: 0,
      lastCheck: 0,
      lastRepairAt: 0,
      lastRepairOk: null,
      readings: [],
      detail: "",
      since: nowMs(),
      firstSeen: 0,
    };
    state.set(key, s);
  }
  return s;
}

/**
 * The last N readings for a symptom, kept so the panel can draw a sparkline and
 * so an operator can see the shape of a fault rather than one number.
 */
const READING_KEEP = 24;

function noteReading(key, value, ok) {
  const s = recordFor(key);
  s.readings.push({ at: nowMs(), value: Math.round(Number(value) || 0), ok: Boolean(ok) });
  if (s.readings.length > READING_KEEP) s.readings.splice(0, s.readings.length - READING_KEEP);
}

/* ---------------------------------------------------------------- */
/* The dependency register                                           */
/* ---------------------------------------------------------------- */

/**
 * Everything the healer is allowed to touch, registered by the modules that own
 * it. The same trick `selfheal.mjs` uses: a one-way dependency keeps the ESM
 * graph acyclic, and it makes the *blast radius* of a repair reviewable in one
 * place — if it is not registered here, a repair cannot reach it.
 */
const deps = {
  catalog: null, // { reload(): Promise<{count}|throws> }
  token: null, // { reset(), resolve(fresh): Promise<{token}> }
  signers: null, // { hosts(), weight(host), quarantine(host), probe(): Promise<...> }
  caches: {
    plans: null,
    renditions: null,
  },
  assets: null, // { verify(): Promise<{missing:string[]}> }
  traffic: null, // () => { requests, errors, errorRate, … }
  startedAt: nowMs(),
  version: "",
};

export function registerHealerDependencies(next = {}) {
  for (const name of ["catalog", "token", "signers", "assets"]) {
    if (next[name]) deps[name] = next[name];
  }
  if (next.caches) Object.assign(deps.caches, next.caches);
  if (next.version) deps.version = String(next.version);
}

function sizeOf(map) {
  try {
    return map && typeof map.size === "number" ? map.size : 0;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- */
/* Probes                                                            */
/* ---------------------------------------------------------------- */

/**
 * A probe is a *reading*, not a decision: it returns a value, a unit, whether it
 * counts as healthy, and the severity to use if it does not. Keeping them that
 * flat is what lets the panel draw the whole suite in one table, and lets the
 * healer decide with rules instead of each probe deciding for itself.
 */
export const PROBES = [
  {
    id: "catalog-index",
    label: "Catalogue index",
    symptoms: ["catalog.unreadable", "catalog.empty"],
    /** Which symptom, if any, this specific reading reports. */
    which: (r) => (r.error ? "catalog.unreadable" : r.value === 0 ? "catalog.empty" : ""),
    async run() {
      if (!deps.catalog) return { value: 0, unit: "batches", ok: true, skipped: true };
      const t = nowMs();
      const out = await deps.catalog.load();
      const value = Number(out?.count) || 0;
      return {
        value,
        unit: "batches",
        ok: value > 100,
        ms: nowMs() - t,
        detail: value > 0 ? "" : "the index is empty",
      };
    },
  },
  {
    id: "token-ladder",
    label: "Guest token",
    symptoms: ["token.exhausted", "token.expiring"],
    // An empty ladder and a nearly-expired token are different faults: the first
    // cannot be fixed by waiting, the second should never be allowed to become
    // the first. The probe reports both, so the check is on the ladder.
    which: (r) => {
      if (r.skipped || r.ok) return "";
      if (!r.usableCount) return "token.exhausted";
      return r.seconds !== null && r.seconds < 120 ? "token.expiring" : "token.exhausted";
    },
    async run() {
      if (!deps.token) return { value: 0, unit: "s left", ok: true, skipped: true };
      const out = await deps.token.state();
      const seconds = Number.isFinite(out?.expiresIn) ? out.expiresIn : null;
      const usableCount = Number(out?.usableCount) || 0;
      return {
        value: seconds === null ? 0 : seconds,
        seconds,
        usableCount,
        unit: "s left",
        ok: usableCount > 0 && (seconds === null || seconds > 120),
        detail: usableCount ? out?.source || "" : "no credential on the ladder is usable",
      };
    },
  },
  {
    id: "signers",
    label: "Signing hosts",
    symptoms: ["signer.degraded"],
    which: (r) => (!r.skipped && r.degraded > 0 ? "signer.degraded" : ""),
    async run() {
      if (!deps.signers) return { value: 0, unit: "hosts", ok: true, skipped: true };
      const rows = deps.signers.health();
      const total = rows.length;
      const degraded = rows.filter((r) => r.weight < 0.75).length;
      const healthy = rows.filter((r) => r.weight >= 0.75).length;
      return {
        value: total,
        unit: "hosts",
        healthy,
        degraded,
        total,
        ok: total === 0 || healthy > 0,
        detail: degraded ? `${degraded} of ${total} are failing` : "",
      };
    },
  },
  {
    id: "relay",
    label: "Playback relay",
    symptoms: ["relay.failing"],
    which: (r) => (r.value >= 20 ? "relay.failing" : ""),
    async run() {
      const relay = selfheal.relayHealth();
      return {
        value: relay.failures10m,
        unit: "faults/10m",
        ok: relay.failures10m < 20,
        detail: relay.worst ? `mostly ${relay.worst[0]}` : "",
        extra: relay.byKind,
      };
    },
  },
  {
    id: "error-rate",
    label: "Request error rate",
    symptoms: ["traffic.errors"],
    which: (r) => (r.value >= 5 ? "traffic.errors" : ""),
    run() {
      if (!deps.traffic) return { value: 0, unit: "%", ok: true, skipped: true };
      const stats = deps.traffic();
      return {
        value: Number(stats?.errorRate) || 0,
        unit: "%",
        ok: (Number(stats?.errorRate) || 0) < 5,
        detail: stats ? `${stats.errors} of ${stats.requests} requests` : "",
      };
    },
  },
  {
    id: "memory",
    label: "Heap in use",
    symptoms: ["runtime.memory"],
    which: (r) => (r.value >= 85 ? "runtime.memory" : ""),
    run() {
      const mem = typeof process !== "undefined" && process.memoryUsage ? process.memoryUsage() : null;
      if (!mem) return { value: 0, unit: "%", ok: true, skipped: true };
      // Vercel's default is 1 GB per function: 85% of it is the point where the
      // next cold start is a better outcome than the risk of an OOM kill.
      const pct = Math.round((mem.rss / (1024 * 1024 * 1024)) * 100);
      return {
        value: Math.min(100, pct),
        unit: "% heap",
        ok: pct < 85,
        detail: `${Math.round(mem.rss / 1048576)} MB resident`,
      };
    },
  },
];

/**
 * Run a promise with a deadline, and *always* clear the timer.
 *
 * The first version only unref'd the timer, which let a lambda go quiet while a
 * hung probe still had a live promise hanging off it: in a test the process ran
 * out of work and every later assertion failed with "the event loop has already
 * resolved", and in production the same shape leaks a timer per sweep.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    // The deadline must be allowed to fire even when nothing else is pending —
    // a probe that hangs is exactly the case with no other work in the loop. So
    // the timer is *not* unref'd here; `finally` clears it instead.
  });
  return Promise.race([promise, deadline]).finally(() => {
    // …and it must not outlive the race either, whichever side won.
    if (timer) clearTimeout(timer);
  });
}

/**
 * Run every probe, one pass, bounded so the panel is not slow exactly when it
 * is most needed. A probe that throws becomes a failed reading — never a
 * crash — because a monitoring system that dies on the fault it monitors is the
 * oldest joke in the file.
 *
 * Probes are read-only. Deciding what a reading *means* is `sweep()`'s job, and
 * keeping them apart is what lets the page show raw readings to an operator who
 * wants to disagree with the healer's judgement.
 */
export async function runProbes({ timeout = 6000 } = {}) {
  const started = nowMs();
  const results = await Promise.all(
    PROBES.map(async (probe) => {
      const t = nowMs();
      try {
        const out = await withTimeout(Promise.resolve().then(() => probe.run()), timeout, probe.id);
        return { ...out, id: probe.id, label: probe.label, at: nowMs(), ms: nowMs() - t };
      } catch (err) {
        return {
          id: probe.id,
          label: probe.label,
          value: 0,
          unit: "",
          ok: false,
          error: err?.message || "probe failed",
          at: nowMs(),
          ms: nowMs() - t,
        };
      }
    })
  );
  return { results, ms: nowMs() - started, at: new Date(nowMs()).toISOString() };
}

/* ---------------------------------------------------------------- */
/* Repair execution                                                  */
/* ---------------------------------------------------------------- */

/**
 * The rung implementations. Each one is *only* allowed to touch `deps` (the
 * registered handles) and the caches `selfheal.mjs` exposes; it never reaches
 * into a module directly. It returns a short human sentence, because that
 * sentence is what the operator ends up reading.
 */
const RUNGS = {
  "catalog.reload": {
    "drop-cache": async () => {
      // There is no separate memo to drop: `loadCatalogIndex` memoises the
      // promise. Clearing it is `deps.catalog.reload()`'s job, which both drops
      // and re-reads — the rung exists so the escalation is visible even when
      // the first and second rungs are the same call.
      return "dropped the memoised index";
    },
    rebuild: async () => {
      const out = await deps.catalog.reload();
      return `re-read the index (${Number(out?.count) || 0} batches)`;
    },
  },
  "token.remint": {
    "drop-token": async () => {
      deps.token.reset();
      return "discarded the cached guest token";
    },
    remint: async () => {
      const out = await deps.token.resolve(true);
      return `minted a fresh token (${out?.source || "unknown source"})`;
    },
  },
  "signer.quarantine": {
    "reset-ladder": async () => {
      const n = deps.signers.reset();
      return `cleared the failure counters on ${n} host(s)`;
    },
    quarantine: async () => {
      const out = await deps.signers.probe();
      const bad = (out?.hosts || []).filter((h) => !h.ok);
      for (const host of bad) deps.signers.quarantine(host.host);
      return bad.length
        ? `reprobed the ladder and quarantined ${bad.length} dead host(s)`
        : "reprobed every signer; all of them answered";
    },
  },
  "cache.plans": {
    "drop-plans": async () => {
      const n = sizeOf(deps.caches.plans);
      if (deps.caches.plans) deps.caches.plans.clear();
      return `dropped ${n} cached playback plan(s)`;
    },
    "drop-renditions": async () => {
      const n = sizeOf(deps.caches.renditions);
      if (deps.caches.renditions) deps.caches.renditions.clear();
      return `dropped ${n} cached rendition list(s)`;
    },
    "drop-both": async () => {
      const a = sizeOf(deps.caches.plans);
      const b = sizeOf(deps.caches.renditions);
      deps.caches.plans?.clear();
      deps.caches.renditions?.clear();
      deps.token?.reset?.();
      return `dropped ${a} plan(s), ${b} rendition list(s) and the token`;
    },
  },
  "cache.trim": {
    "trim-plans": async () => {
      const n = sizeOf(deps.caches.plans);
      deps.caches.plans?.clear();
      if (typeof globalThis.gc === "function") globalThis.gc();
      return `released ${n} plan(s) and asked for a collection`;
    },
    "trim-all": async () => {
      const n = sizeOf(deps.caches.plans) + sizeOf(deps.caches.renditions);
      deps.caches.plans?.clear();
      deps.caches.renditions?.clear();
      deps.token?.reset?.();
      if (typeof globalThis.gc === "function") globalThis.gc();
      return `released every cache (${n} entries)`;
    },
  },
  "site.recheck": {
    "reload-catalog": async () => {
      const out = await deps.catalog.reload();
      return `rebuilt the catalogue index (${out?.count ?? 0} batches) before asking for the page again`;
    },
    "re-request": async () => {
      // Deliberately not a fetch: a repair runs inside a request, and spending
      // that request's budget on another round trip is how a slow page becomes a
      // timed-out one. What the repair can do is make sure everything the page
      // renders from is fresh, and let the next scanner pass be the judge.
      const out = await deps.catalog.load().catch(() => null);
      void out;
      deps.token?.reset?.();
      return "refreshed the index and the guest token; the next scan pass will re-request the page";
    },
  },
  "upstream.recover": {
    "fresh-token": async () => {
      const out = await deps.token.resolve(true);
      return `minted a fresh token (${out?.source || "unknown source"}) for the refused call`;
    },
    "drop-caches": async () => {
      const n = sizeOf(deps.caches.plans) + sizeOf(deps.caches.renditions);
      deps.caches.plans?.clear();
      deps.caches.renditions?.clear();
      const out = await deps.token.resolve(true);
      return `dropped ${n} cached answer(s) and minted a fresh token (${out?.source || "unknown source"})`;
    },
    "reweight-signers": async () => {
      const n = deps.signers.reset();
      const out = await deps.token.resolve(true);
      void out;
      return `cleared the evidence on ${n} signer(s) and minted a fresh token`;
    },
  },
  "route.recheck": {
    "drop-caches": async () => {
      const n = sizeOf(deps.caches.plans) + sizeOf(deps.caches.renditions);
      deps.caches.plans?.clear();
      deps.caches.renditions?.clear();
      return `dropped ${n} cached answer(s) across plans and renditions`;
    },
    "remint-token": async () => {
      deps.caches.plans?.clear();
      deps.caches.renditions?.clear();
      deps.token?.reset?.();
      const out = await deps.token.resolve(true);
      return `minted a fresh token (${out?.source || "unknown source"}) and dropped the caches`;
    },
  },
  "assets.verify": {
    "check-manifest": async () => {
      const out = await deps.assets.verify();
      const missing = out?.missing || [];
      return missing.length
        ? `the manifest promises ${missing.length} file(s) that are not on disk`
        : "every file the manifest promises is on disk";
    },
  },
};

/**
 * Run one repair, at the rung the symptom has earned.
 *
 * Returns a receipt even when it does nothing: "cooling down" is a real state,
 * and the panel shows it rather than pretending the repair ran.
 */
export async function repair(key, { reason = "probe", force = false } = {}) {
  const spec = SYMPTOMS[key];
  if (!spec) return { ok: false, ran: false, error: `unknown symptom ${key}` };

  const repairKey = spec.repair;
  const plan = REPAIRS[repairKey];
  if (!plan) return { ok: false, ran: false, error: `no repair for ${key}` };

  const s = recordFor(key);
  const now = nowMs();

  // Out of rungs and already failed: the site has stopped trying. Only an
  // operator (force) or a recovery can move it from here — an automatic repair
  // loop is how a healer becomes the outage.
  if (s.status === "failed" && !force) {
    return { ok: false, ran: false, stopped: true, error: "out of rungs — this needs an operator" };
  }

  // Cooldown: the same repair twice in a minute is not a repair, it is a loop.
  const coolKey = `${repairKey}:${key}`;
  const coolUntil = cooldowns.get(coolKey) || 0;
  if (!force && now < coolUntil) {
    return {
      ok: false,
      ran: false,
      cooling: true,
      until: new Date(coolUntil).toISOString(),
      error: `cooling down for ${Math.ceil((coolUntil - now) / 1000)}s`,
    };
  }

  // The fault is back after a repair already ran: the last rung did not hold it,
  // so the ladder climbs *before* we try again. This is the escalation signal —
  // a repair that throws is a strike too, but a repair that quietly fails to
  // fix anything is the more common and more dangerous case.
  if (s.lastRepairAt > 0 && s.lastRepairOk === true && s.rung < plan.rungs.length - 1) {
    strikes.set(key, (strikes.get(key) || 0) + 1);
    s.rung += 1;
  }

  const stair = Math.min(s.rung, plan.rungs.length - 1);
  const rung = plan.rungs[stair];
  const impl = RUNGS[repairKey]?.[rung.id];
  if (!impl) return { ok: false, ran: false, error: `rung ${rung.id} has no implementation` };

  const from = s.status;
  s.status = "repairing";
  s.detail = `running ${rung.label.toLowerCase()}`;
  record(key, from, "repairing", `${reason}: ${rung.label}`);

  const started = nowMs();
  let summary = "";
  let error = "";
  try {
    summary = await impl();
  } catch (err) {
    error = err?.message || "the repair threw";
  }
  const ms = nowMs() - started;

  // Every repair also lands on the reactive ledger, so the panel has one list of
  // everything the site has done to itself — reactive and deliberate together.
  selfheal.perform(`heal.${repairKey}`, `${spec.label}: ${error ? `failed — ${error}` : summary}`, {
    symptom: key,
    rung: rung.id,
    reason,
    ms,
  });

  s.lastRepairAt = nowMs();
  s.lastRepairOk = !error;

  if (error) {
    strikes.set(key, (strikes.get(key) || 0) + 1);
    s.status = strikes.get(key) >= MAX_STRIKES ? "failed" : "escalated";
    s.rung = Math.min(s.rung + 1, plan.rungs.length - 1);
    s.detail = `the repair failed: ${error}`;
    record(key, "repairing", s.status, error);
    cooldowns.set(coolKey, nowMs() + COOLDOWN_MS[spec.severity]);
    return { ok: false, ran: true, error, ms, rung: rung.id };
  }

  s.status = "repaired";
  s.detail = summary;
  record(key, "repairing", "repaired", summary);
  cooldowns.set(coolKey, nowMs() + COOLDOWN_MS[spec.severity]);
  return { ok: true, ran: true, summary, ms, rung: rung.id };
}

/**
 * Record a fault that was *seen* but not (yet) repaired — the scanner's way in.
 *
 * The probes watch the machinery and the scanner watches the site, so the healer
 * needs a door for "someone looked and this is broken" that is not `repair()`.
 * Marking it degraded is what makes the panel's verdict honest: a scan that found
 * a dead page and could not fix it must not leave the site looking healthy.
 *
 * It deliberately does *not* count a strike. A sighting is not a failed repair,
 * and an escalation ladder that climbs on observation is a ladder that nukes the
 * caches every time a network blips.
 */
export function reportFault(key, detail = "", { at = null } = {}) {
  const spec = SYMPTOMS[key];
  if (!spec) return false;
  const s = recordFor(key);
  s.lastCheck = at === null ? nowMs() : at;
  noteReading(key, 1, false);
  if (!s.firstSeen) s.firstSeen = s.lastCheck;
  // Already known to be broken: refresh the note, do not churn the timeline.
  if (s.status === "degraded" || s.status === "escalated" || s.status === "repairing") {
    s.detail = detail || s.detail;
    return false;
  }
  const from = s.status;
  s.status = "degraded";
  s.detail = detail;
  s.since = nowMs();
  record(key, from, "degraded", detail);
  return true;
}

/**
 * Put a symptom back to healthy — and, crucially, *lower its rung*. Recovery is
 * the only thing that resets the escalation, so a system that had a bad Tuesday
 * is not permanently primed to nuke its caches on Wednesday.
 */
export function markHealthy(key, detail = "") {
  if (!SYMPTOMS[key]) return false;
  const s = recordFor(key);
  // Already healthy *with this note*: nothing changed, so nothing is recorded.
  // Without the note check, every sweep would append a timeline row per probe.
  if (s.status === "healthy" && s.detail === detail) return false;
  const from = s.status;
  s.status = "healthy";
  s.rung = 0;
  s.detail = detail;
  s.since = nowMs();
  strikes.delete(key);
  record(key, from, "healthy", detail);
  return true;
}

/* ---------------------------------------------------------------- */
/* The loop                                                          */
/* ---------------------------------------------------------------- */

/** A guard so two overlapping panel refreshes cannot run two repair passes. */
let passInFlight = null;

/**
 * The last pass's readings, kept so `healerReport()` can be called from anywhere
 * — including a route that only wants the state — without paying for a second
 * round of probes. `sweep()` is the only writer.
 */
let lastPass = null;

/**
 * One full pass: probe, decide, repair, record. Returns the receipt of the pass
 * rather than throwing, because this is called from a dashboard route whose job
 * is to answer *even when the site is broken*.
 *
 * `apply: false` makes it a dry run — the panel's default, so an operator
 * looking at the page does not trigger repairs just by looking.
 */
export async function sweep({ apply = false, now = null, timeout = 6000 } = {}) {
  if (now !== null) setNow(typeof now === "function" ? now : () => now);
  if (passInFlight) return passInFlight;

  passInFlight = (async () => {
    const probed = await runProbes({ timeout });
    const actions = [];
    const failing = new Set();

    for (const reading of probed.results) {
      const probe = PROBES.find((p) => p.id === reading.id);
      if (!probe) continue;

      // A probe that could not run at all is not evidence either way. It is
      // reported as a failed reading, but it never triggers a repair: acting on
      // "I could not look" is how a healer becomes a vandal.
      if (reading.skipped || reading.error) {
        noteReading(`${reading.id}.error`, 0, false);
        continue;
      }

      const key = probe.which ? probe.which(reading) : "";
      noteReading(key || `${reading.id}.ok`, reading.value, reading.ok);

      if (!key) {
        // Nothing wrong from this probe: clear any of its symptoms that were up,
        // which is what makes the whole system self-reverting.
        for (const candidate of probe.symptoms) {
          const s = state.get(candidate);
          if (s && (s.status === "degraded" || s.status === "escalated" || s.status === "repaired")) {
            markHealthy(candidate, "the probe passes again");
          }
        }
        continue;
      }

      failing.add(key);
      const spec = SYMPTOMS[key];
      const s = recordFor(key);
      if (!s.firstSeen) s.firstSeen = nowMs();
      s.lastCheck = nowMs();
      s.detail = reading.detail || spec.blurb;

      if (s.status !== "degraded" && s.status !== "repairing") {
        const from = s.status;
        s.status = "degraded";
        s.since = nowMs();
        record(key, from, "degraded", reading.detail || `${reading.value}${reading.unit}`);
      }

      if (!apply) continue;

      const receipt = await repair(key, {
        reason: `probe ${reading.id}: ${reading.detail || `${reading.value}${reading.unit}`}`,
      });
      actions.push({ symptom: key, ...receipt });
    }

    lastPass = { at: nowMs(), results: probed.results };
    return {
      at: new Date(nowMs()).toISOString(),
      ms: probed.ms,
      applied: Boolean(apply),
      readings: probed.results,
      symptoms: symptomList(),
      actions,
      ok: failing.size === 0,
    };
  })().finally(() => {
    passInFlight = null;
  });

  return passInFlight;
}

/* ---------------------------------------------------------------- */
/* Reporting                                                         */
/* ---------------------------------------------------------------- */

function symptomList() {
  return [...state.entries()]
    .filter(([key]) => SYMPTOMS[key])
    .map(([key, s]) => {
      const spec = SYMPTOMS[key];
      const plan = REPAIRS[spec.repair];
      return {
        key,
        label: spec.label,
        severity: spec.severity,
        blurb: spec.blurb,
        status: s.status,
        repair: spec.repair,
        repairLabel: plan?.label || spec.repair,
        rung: s.rung,
        rungs: plan?.rungs.length || 1,
        rungLabel: plan?.rungs[Math.min(s.rung, (plan?.rungs.length || 1) - 1)]?.label || "",
        firstSeen: s.firstSeen ? new Date(s.firstSeen).toISOString() : "",
        since: new Date(s.since).toISOString(),
        lastCheck: s.lastCheck ? new Date(s.lastCheck).toISOString() : "",
        lastRepairAt: s.lastRepairAt ? new Date(s.lastRepairAt).toISOString() : "",
        lastRepairOk: s.lastRepairOk,
        needsOperator: s.status === "failed" ? plan?.needsOperator || "" : "",
        detail: s.detail,
        strikes: strikes.get(key) || 0,
        readings: s.readings.slice(-READING_KEEP),
      };
    })
    .sort((a, b) => {
      const rank = { failed: 0, escalated: 1, degraded: 2, repairing: 3, repaired: 4, healthy: 5 };
      return (rank[a.status] ?? 6) - (rank[b.status] ?? 6);
    });
}

/** The state machine, as a diagram the operator can read in one line. */
export const LIFECYCLE = ["healthy", "degraded", "repairing", "repaired", "escalated", "failed"];

/** Everything the panel needs about the healer, in one shape. */
export function healerReport() {
  const rows = symptomList();
  const counts = { healthy: 0, degraded: 0, repairing: 0, repaired: 0, escalated: 0, failed: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;

  const repaired = [...state.values()].filter((s) => s.status === "repaired").length;
  const needsOperator = rows.filter((r) => r.status === "failed");

  return {
    at: new Date(nowMs()).toISOString(),
    // Whether this report describes a real probe pass or only remembered state.
    // The panel says so, because "no faults" from a sweep that never ran and "no
    // faults" from a sweep that just passed every probe are very different claims.
    swept: Boolean(lastPass),
    probeAt: lastPass ? new Date(lastPass.at).toISOString() : "",
    uptimeSeconds: Math.round((nowMs() - deps.startedAt) / 1000),
    version: deps.version,
    lifecycle: LIFECYCLE,
    counts,
    symptoms: rows,
    repairedRecently: repaired,
    // The headline the panel puts in the hero. It is ordered by how much the
    // operator needs to do about it, and it never claims "all clear" while a
    // probe is still reading badly — "repaired" means *a repair ran*, not that
    // the fault has gone away, and conflating the two is how a status page lies.
    verdict: needsOperator.length
      ? `${needsOperator.length} fault${needsOperator.length === 1 ? "" : "s"} need an operator`
      : rows.some((r) => r.status === "degraded" || r.status === "repairing")
        ? "Repairing — a fault is being handled"
        : rows.some((r) => r.status === "escalated")
          ? "Escalating — a repair did not hold"
          : rows.some((r) => r.status === "repaired")
            ? "Repaired — a fault was fixed and is being watched"
            : "Every probe passes",
    needsOperator,
    repairs: REPAIRS,
    // The raw readings, so an operator can disagree with the healer's judgement
    // instead of only seeing its conclusion.
    probes: (lastPass?.results || []).map((r) => {
      const probe = PROBES.find((p) => p.id === r.id);
      return {
        id: r.id,
        label: r.label,
        value: r.value,
        unit: r.unit,
        ok: Boolean(r.ok),
        skipped: Boolean(r.skipped),
        error: r.error || "",
        detail: r.detail || "",
        ms: r.ms || 0,
        seconds: Number.isFinite(r.seconds) ? r.seconds : null,
        which: probe?.which ? probe.which(r) || "" : "",
        symptoms: probe?.symptoms || [],
      };
    }),
    symptomsKnown: Object.keys(SYMPTOMS).length,
    timeline: timeline.slice(0, 30).map((t) => ({
      ...t,
      at: new Date(t.at).toISOString(),
      ago: Math.max(0, Math.round((nowMs() - t.at) / 1000)),
    })),
    // The reactive ledger, which the healer shares: one list of every action the
    // site has taken on itself.
    ledger: selfheal.repairs(20),
    budget: selfheal.selfHealReport().budget,
    caches: {
      plans: sizeOf(deps.caches.plans),
      renditions: sizeOf(deps.caches.renditions),
    },
  };
}

/**
 * `GET /api/admin?action=heal` — the operator's manual control.
 *
 * `sweep=1` probes and repairs; `repair=<symptom>` forces one rung (the panel's
 * "fix now", which is how an operator confirms a diagnosis instead of waiting
 * for the next fault). Both return the full report so the panel repaints from
 * the answer rather than guessing.
 */
export async function healAction({ sweepNow = false, symptom = "" } = {}) {
  const actions = [];
  if (symptom) {
    if (!SYMPTOMS[symptom]) {
      // A typo must not silently become "sweep everything": the operator asked
      // to fix one thing, and answering a different question is how a console
      // loses its operator's trust.
      return {
        ...healerReport(),
        actions: [],
        swept: false,
        error: `unknown symptom "${symptom}" — known: ${Object.keys(SYMPTOMS).join(", ")}`,
      };
    }
    const receipt = await repair(symptom, { reason: "operator", force: true });
    actions.push({ symptom, ...receipt });
  }
  if (sweepNow || symptom) {
    const pass = await sweep({ apply: true });
    actions.push(...pass.actions);
  }
  return { ...healerReport(), actions, swept: Boolean(sweepNow || symptom) };
}

/** Tests (and a redeploy) start from a clean slate. */
export function resetHealer() {
  state.clear();
  cooldowns.clear();
  strikes.clear();
  timeline.length = 0;
  deps.catalog = null;
  deps.token = null;
  deps.signers = null;
  deps.assets = null;
  deps.traffic = null;
  deps.caches.plans = null;
  deps.caches.renditions = null;
  deps.startedAt = nowMs();
  deps.version = "";
  lastPass = null;
  passInFlight = null;
  setNow(Date.now);
}

/** Traffic is registered separately: `lib/admin.mjs` owns those counters. */
export function registerTraffic(fn) {
  if (typeof fn === "function") deps.traffic = fn;
}
