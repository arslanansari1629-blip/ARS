/**
 * The self-healing system.
 *
 * Nothing in this file is visible to a visitor: there is no badge, no banner and
 * no link. It watches the things that can break a lecture (signer health,
 * manifest and segment relay failures, CDN cache state, resolution latency),
 * and when one of them degrades it *does something about it* rather than filing
 * a report:
 *
 *   • a dead signer host is demoted    → resolution stops spending time on it
 *   • a flapping signer is quarantined → for a bounded window
 *   • a poisoned plan is dropped       → the next request re-probes
 *   • a stale guest token is discarded → the next request re-mints
 *
 * Every action is bounded and self-reverting, it is capped per hour so the site
 * cannot thrash, and each one is recorded with the evidence that triggered it.
 * The admin panel shows the ledger; a visitor never sees any of it.
 *
 * Design rules:
 *   1. Never repair what is not broken. An action needs repeated evidence.
 *   2. Never make it worse. Actions expire on their own; nothing is deleted that
 *      a later request could not rebuild.
 *   3. Never stay quiet. A healed fault is still a fault: it is in the ledger so
 *      the operator can fix the cause instead of relying on the cure.
 */

/* ---------------------------------------------------------------- */
/* The ledger                                                        */
/* ---------------------------------------------------------------- */

/** Bounded: a long-lived lambda must not grow an unbounded array. */
const LEDGER_MAX = 40;
/** The same action twice in a row is noise, not news. */
const DEDUPE_MS = 60 * 1000;
/** No more than this many repairs per hour, whatever happens. */
const ACTIONS_PER_HOUR = 12;

/** @type {Array<object>} newest first */
const events = [];
/** action key → last performed timestamp, for the hourly cap */
const performed = new Map();

/* ---------------------------------------------------------------- */
/* Signer health                                                     */
/* ---------------------------------------------------------------- */

/**
 * A signer host that fails is not permanently dead — it is usually rate limited
 * for a moment. So "unhealthy" is a *score*, not a flag: it decays back to
 * healthy on its own, and one success clears it.
 */
const SIGNER_DECAY_MS = 10 * 60 * 1000;

/** @type {Map<string, {fails: number, oks: number, lastFailAt: number, quarantinedUntil: number, reason: string}>} */
const signers = new Map();

function signerState(host, now = Date.now()) {
  let s = signers.get(host);
  if (!s) {
    s = { fails: 0, oks: 0, lastFailAt: 0, quarantinedUntil: 0, reason: "" };
    signers.set(host, s);
  }
  // Old failures stop counting: a host that failed ten minutes ago is a
  // different proposition from one that is failing right now.
  if (s.lastFailAt && now - s.lastFailAt > SIGNER_DECAY_MS) s.fails = 0;
  if (s.quarantinedUntil && now > s.quarantinedUntil) {
    s.quarantinedUntil = 0;
    s.fails = 0;
  }
  return s;
}

/**
 * How much to trust a host right now, 0 (useless) … 1 (perfect).
 * Used by the resolver to *order* the ladder rather than to skip hosts entirely —
 * a quarantined host is still tried last, because a wrong answer from it beats no
 * answer at all.
 */
export function signerWeight(host) {
  const s = signerState(host);
  const now = Date.now();
  if (s.quarantinedUntil > now) return 0;
  if (!s.fails) return 1;
  return Math.max(0.05, 1 - s.fails * 0.25);
}

/** Hosts ordered by trust, quarantined ones last. Stable within a bucket. */
export function rankSigners(hosts) {
  return [...hosts].sort((a, b) => signerWeight(b) - signerWeight(a));
}

export function recordSignerResult(host, ok, { status = 0, error = "" } = {}) {
  if (!host) return;
  const now = Date.now();
  const s = signerState(host, now);

  if (ok) {
    s.oks += 1;
    s.fails = 0;
    s.quarantinedUntil = 0;
    s.reason = "";
    perform("signer.recovered", `signer ${host} is answering again`, { host }, now);
    return;
  }

  s.fails += 1;
  s.lastFailAt = now;
  s.reason = error || (status ? `answered ${status}` : "unreachable");

  // Two consecutive failures → demote. Three → quarantine for five minutes.
  // A 403 on its own is the common case for one overloaded mirror and is not
  // enough evidence to stop asking it.
  if (s.fails >= 3) {
    s.quarantinedUntil = now + 5 * 60 * 1000;
    perform("signer.quarantine", `signer ${host} quarantined for 5 minutes (${s.reason})`, {
      host,
      fails: s.fails,
    }, now);
  } else if (s.fails === 2) {
    perform("signer.demote", `signer ${host} demoted after 2 failures (${s.reason})`, {
      host,
      fails: s.fails,
    }, now);
  }
}

/**
 * Clear the failure counters on every known host.
 *
 * The healer's first rung for a degraded ladder: if the evidence itself is stale
 * — a bad twenty minutes that ended — the ladder should re-order from *now*, not
 * from a memory of the outage. It does not clear quarantines by hand: a
 * quarantine still expires on its own schedule, so this cannot un-pause a host
 * that is still failing.
 */
export function resetSignerScores() {
  let cleared = 0;
  for (const [, s] of signers) {
    if (s.fails || s.reason) cleared += 1;
    s.fails = 0;
    s.reason = "";
  }
  return cleared;
}

/** Public, redacted view of the signer ladder. */
export function signerHealth() {
  const now = Date.now();
  return [...signers.entries()].map(([host, s]) => {
    const state = signerState(host, now);
    return {
      host: host.replace(/^https:\/\//, ""),
      weight: Number(signerWeight(host).toFixed(2)),
      fails: state.fails,
      oks: state.oks,
      quarantined: state.quarantinedUntil > now,
      quarantineLeft: state.quarantinedUntil > now ? Math.round((state.quarantinedUntil - now) / 1000) : 0,
      reason: state.reason,
    };
  });
}

/* ---------------------------------------------------------------- */
/* Relay health                                                      */
/* ---------------------------------------------------------------- */

/**
 * The two relays that serve bytes (`/api/sign`, `/api/hls`) report every failure
 * kind they see. Repeated failures of one *kind* are what justify a repair: one
 * 403 is a stale signature, fifty in a minute is a broken signing path.
 */
const relay = { window: [], counts: {}, repairs: 0 };

export function recordRelayFailure({ relay: which = "sign", kind = "unknown", detail = "" } = {}) {
  const now = Date.now();
  relay.window.push({ at: now, kind });
  // Keep ten minutes of history, bounded.
  while (relay.window.length && now - relay.window[0].at > 10 * 60 * 1000) relay.window.shift();
  if (relay.window.length > 500) relay.window.shift();

  relay.counts[kind] = (relay.counts[kind] || 0) + 1;

  const recent = relay.window.filter((e) => e.kind === kind).length;
  if (recent >= 5) {
    // Enough evidence that this class of failure is systematic, not incidental.
    healRelay(which, kind, { detail, recent }, now);
  }
}

/**
 * Apply the cure for a relay failure class.
 *
 * Deliberately limited to caches this module owns. A repair that reached into
 * the code would be a deploy, not a repair — and a deploy that fires itself on a
 * bad metric is how an outage becomes a cascade.
 */
function healRelay(which, kind, evidence, now) {
  if (/manifest|master|playlist/i.test(kind)) {
    const n = dropPlanCache();
    perform(
      "cache.plans",
      `dropped ${n} cached playback plan(s) after repeated ${kind} failures`,
      { kind, ...evidence },
      now
    );
    return;
  }
  if (/segment|key/i.test(kind)) {
    const n = dropRenditionCache();
    perform(
      "cache.renditions",
      `dropped ${n} cached rendition list(s) after repeated ${kind} failures`,
      { kind, ...evidence },
      now
    );
    return;
  }
  if (/signature|expired|403/i.test(kind)) {
    const n = dropToken();
    perform("token.refresh", `asked for a fresh guest token after repeated ${kind} failures`, {
      kind,
      ...evidence,
    }, now);
    void n;
    return;
  }
  if (/unreachable|timeout|502|network/i.test(kind)) {
    perform("relay.throttle", `relay ${which} is failing at the network layer (${kind})`, {
      kind,
      ...evidence,
    }, now);
  }
}

export function relayHealth() {
  const now = Date.now();
  const last10 = relay.window.filter((e) => now - e.at <= 10 * 60 * 1000);
  const byKind = {};
  for (const e of last10) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    failures10m: last10.length,
    byKind,
    repairs: relay.repairs,
    worst:
      Object.entries(byKind).sort((a, b) => b[1] - a[1])[0] || null,
  };
}

/* ---------------------------------------------------------------- */
/* Caches the healers are allowed to touch                           */
/* ---------------------------------------------------------------- */

/**
 * `lib/api-data.mjs` registers its caches here instead of this module importing
 * it. That keeps the dependency one-way: the data layer may report to the healer,
 * but the healer never reaches into the data layer at import time (which would
 * make a cycle, and cycles in an ESM graph fail at load, not at call).
 */
const caches = {
  plans: null,
  renditions: null,
  token: null,
};

export function registerCaches({ plans, renditions, token } = {}) {
  if (plans) caches.plans = plans;
  if (renditions) caches.renditions = renditions;
  if (token) caches.token = token;
}

function dropPlanCache() {
  try {
    const size = caches.plans ? caches.plans.size : 0;
    if (caches.plans) caches.plans.clear();
    return size;
  } catch {
    return 0;
  }
}

function dropRenditionCache() {
  try {
    const size = caches.renditions ? caches.renditions.size : 0;
    if (caches.renditions) caches.renditions.clear();
    return size;
  } catch {
    return 0;
  }
}

function dropToken() {
  try {
    if (caches.token) caches.token();
    return 1;
  } catch {
    return 0;
  }
}

/* ---------------------------------------------------------------- */
/* Plan poisoning                                                    */
/* ---------------------------------------------------------------- */

/**
 * A plan that resolved but never played is worse than no plan: it is cached, so
 * every retry within its TTL re-delivers the same dead URL. When the player
 * reports a manifest failure for a folder, the plan for that folder is dropped
 * so the next attempt starts from a fresh probe.
 */
export function reportPlaybackFailure({ folder = "", kind = "manifest", detail = "" } = {}) {
  const now = Date.now();
  if (!folder) return { repaired: false };
  const dropped = caches.plans ? caches.plans.delete(folder) : false;
  if (caches.renditions) caches.renditions.delete(folder);
  perform(
    dropped ? "plan.drop" : "plan.unstick",
    dropped
      ? `dropped a cached plan for ${folder} after the player reported a dead stream`
      : `no cached plan for ${folder}; forcing a fresh probe on the next request`,
    { folder, kind, detail },
    now
  );
  return { repaired: true, dropped };
}

/* ---------------------------------------------------------------- */
/* Recording                                                         */
/* ---------------------------------------------------------------- */

/**
 * Write one repair to the ledger.
 *
 * Returns false when the action is suppressed by the hourly cap or by the
 * dedupe window, which is itself information: a fault that keeps coming back is
 * a cause the operator has to fix.
 */
export function perform(action, summary, evidence = {}, now = Date.now()) {
  const key = `${action}:${evidence.host || evidence.folder || ""}`;
  const last = performed.get(key) || 0;
  if (now - last < DEDUPE_MS) return false;

  // The marker that reports the cap is not itself an action: counting it made a
  // spent budget read "13 of 12" in the panel, which looks like a bug in the
  // ledger rather than the deliberate stop it is.
  const thisHour = events.filter(
    (e) => now - e.at < 60 * 60 * 1000 && e.action !== "budget.exhausted"
  ).length;
  if (thisHour >= ACTIONS_PER_HOUR) {
    if (!events.some((e) => e.action === "budget.exhausted" && now - e.at < 60 * 60 * 1000)) {
      events.unshift({
        at: now,
        action: "budget.exhausted",
        summary: `repair budget reached (${ACTIONS_PER_HOUR}/hour); further faults are logged, not acted on`,
        evidence: { suppressed: action },
      });
      events.length = Math.min(events.length, LEDGER_MAX);
    }
    return false;
  }

  performed.set(key, now);
  relay.repairs += 1;
  events.unshift({ at: now, action, summary, evidence });
  events.length = Math.min(events.length, LEDGER_MAX);
  return true;
}

/** The ledger, newest first. */
export function repairs(limit = 12) {
  return events.slice(0, Math.max(1, limit)).map((e) => ({
    at: new Date(e.at).toISOString(),
    ago: Math.max(0, Math.round((Date.now() - e.at) / 1000)),
    action: e.action,
    summary: e.summary,
    evidence: e.evidence,
  }));
}

/** Everything the admin panel needs, in one shape. */
export function selfHealReport() {
  return {
    signers: signerHealth(),
    relay: relayHealth(),
    repairs: repairs(12),
    budget: {
      usedLastHour: events.filter(
        (e) => Date.now() - e.at < 60 * 60 * 1000 && e.action !== "budget.exhausted"
      ).length,
      cap: ACTIONS_PER_HOUR,
      exhausted: events.some(
        (e) => e.action === "budget.exhausted" && Date.now() - e.at < 60 * 60 * 1000
      ),
    },
  };
}

/** Used by tests to start from a clean slate. */
export function resetSelfHeal() {
  events.length = 0;
  performed.clear();
  signers.clear();
  relay.window.length = 0;
  relay.counts = {};
  relay.repairs = 0;
  caches.plans = null;
  caches.renditions = null;
  caches.token = null;
}
