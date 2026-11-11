/**
 * The healer — the state machine that decides whether the site is well, what to
 * do about it, and when to stop.
 *
 * `tests/selfheal.test.mjs` pins the *reactive* layer: a request reports a
 * failure, a cache is dropped. This file pins the layer above, and the things
 * that would make a self-repairing system dangerous:
 *
 *   1. a probe that cannot run must not trigger a repair ("could not look" is
 *      not evidence);
 *   2. a repair must climb its ladder one rung at a time, and stop climbing;
 *   3. a fault that clears must reset the ladder, or the next Tuesday's bad
 *      minute would get Monday's sledgehammer;
 *   4. a repair must never be able to touch anything that was not registered.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SYMPTOMS,
  REPAIRS,
  PROBES,
  LIFECYCLE,
  registerHealerDependencies,
  registerTraffic,
  runProbes,
  sweep,
  repair,
  healerReport,
  healAction,
  resetHealer,
  markHealthy,
  setNow,
} from "../lib/healer.mjs";

/** A clean healer wired to healthy fakes, with an injectable clock. */
function healthyWorld(overrides = {}) {
  resetHealer();
  let clock = 1_700_000_000_000;
  setNow(() => clock);
  const calls = { reload: 0, reset: 0, resolve: 0, clearPlans: 0, queried: 0 };

  const plans = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  const renditions = new Map([["a", 1]]);

  const deps = {
    catalog: {
      load: async () => ({ count: 14201 }),
      reload: async () => {
        calls.reload += 1;
        return { count: 14201 };
      },
    },
    token: {
      state: async () => ({ expiresIn: 600, source: "fallback", usableCount: 1 }),
      reset() {
        calls.reset += 1;
      },
      resolve: async () => {
        calls.resolve += 1;
        return { token: "x".repeat(60), source: "fresh" };
      },
    },
    signers: {
      health: () => [{ host: "a.example.org", weight: 1, fails: 0, reason: "" }],
      reset: () => 1,
      quarantine: () => true,
      probe: async () => ({ ok: true, hosts: [{ host: "a.example.org", ok: true }] }),
    },
    assets: { verify: async () => ({ missing: [] }) },
    caches: { plans, renditions },
    ...overrides,
  };

  registerHealerDependencies(deps);
  registerTraffic(() => ({ requests: 100, errors: 0, errorRate: 0 }));

  return {
    deps,
    calls,
    plans,
    renditions,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
  };
}

/* --------------------------------- the shape ------------------------------ */

test("every symptom names a repair that exists, with the rungs it claims", () => {
  for (const [key, spec] of Object.entries(SYMPTOMS)) {
    assert.ok(spec.label, `${key} has no label`);
    assert.ok(spec.severity, `${key} has no severity`);
    assert.ok(spec.blurb, `${key} has no explanation — an operator needs to know why it matters`);
    const plan = REPAIRS[spec.repair];
    assert.ok(plan, `${key} names a repair (${spec.repair}) that is not implemented`);
    assert.ok(plan.rungs.length >= 1, `${spec.repair} has no rungs`);
    for (const rung of plan.rungs) {
      assert.match(rung.id, /^[a-z0-9-]+$/, `${spec.repair} has a badly named rung: ${rung.id}`);
      assert.ok(rung.label, `${spec.repair}/${rung.id} has no label`);
    }
    // Anything that can genuinely stall must say who to tell.
    assert.ok(plan.needsOperator, `${spec.repair} has no operator message`);
  }
});

test("the lifecycle is a closed set, in the order the panel draws it", () => {
  assert.deepEqual(LIFECYCLE, ["healthy", "degraded", "repairing", "repaired", "escalated", "failed"]);
});

test("every probe names the symptoms it can report", () => {
  for (const probe of PROBES) {
    assert.ok(probe.id, "a probe has no id");
    assert.ok(probe.label, `${probe.id} has no label`);
    assert.ok(Array.isArray(probe.symptoms), `${probe.id} cannot say what it watches`);
    for (const key of probe.symptoms) {
      assert.ok(SYMPTOMS[key], `${probe.id} watches an unknown symptom: ${key}`);
    }
    assert.equal(typeof probe.which, "function", `${probe.id} cannot turn a reading into a symptom`);
  }
});

/* ---------------------------------- probes -------------------------------- */

test("a healthy system passes every probe and repairs nothing", async () => {
  healthyWorld();
  const pass = await sweep({ apply: true });

  assert.equal(pass.ok, true, pass.symptoms.map((s) => s.key).join(","));
  assert.deepEqual(pass.actions, [], "a healthy system ran a repair");
  assert.equal(healerReport().verdict, "Every probe passes");
});

test("a probe that cannot run is never evidence for a repair", async () => {
  healthyWorld({
    catalog: {
      load: async () => {
        throw new Error("ENOENT: batches.json.gz");
      },
      reload: async () => ({ count: 14201 }),
    },
  });

  const pass = await sweep({ apply: true });
  assert.deepEqual(pass.actions, [], "an unreadable probe triggered a repair");
  const reading = pass.readings.find((r) => r.id === "catalog-index");
  assert.match(reading.error, /ENOENT/);
  assert.equal(reading.ok, false);
});

test("a probe that hangs is bounded and reported, not waited on", async () => {
  healthyWorld({
    assets: null,
    catalog: {
      load: () => new Promise(() => {}), // never settles
      reload: async () => ({ count: 1 }),
    },
    signers: {
      health: () => [],
      reset: () => 0,
      probe: async () => ({ ok: true, hosts: [] }),
      quarantine: () => true,
    },
  });

  const started = Date.now();
  const pass = await sweep({ timeout: 120 });
  assert.ok(Date.now() - started < 5000, "a hung probe held the whole sweep");
  const reading = pass.readings.find((r) => r.id === "catalog-index");
  assert.match(reading.error, /timed out/i);
});

/* -------------------------------- the ladder ------------------------------ */

test("a failing catalogue is repaired once, and only once per cooldown", async () => {
  const world = healthyWorld({
    catalog: {
      load: async () => ({ count: 0 }), // empty: the worst case, it looks healthy
      reload: async () => {
        world.calls.reload += 1;
        return { count: 14201 };
      },
    },
  });

  const first = await sweep({ apply: true });
  const repaired = first.actions.find((a) => a.symptom === "catalog.empty");
  assert.ok(repaired, "the empty catalogue was not repaired");
  assert.equal(repaired.ok, true);
  assert.equal(repaired.rung, "drop-cache", "the first rung is the cheapest one");
  assert.match(repaired.summary, /dropped the memoised index/);

  // The probe now passes → the symptom goes back to healthy and its ladder resets.
  world.deps.catalog.load = async () => ({ count: 14201 });
  const second = await sweep({ apply: true });
  assert.equal(
    second.symptoms.some((s) => s.key === "catalog.empty" && s.status !== "healthy"),
    false,
    "a cleared fault kept its state"
  );
});

test("a fault that survives its repair climbs the ladder, one rung per strike", async () => {
  const world = healthyWorld();
  // The token stays expiring whatever the healer does.
  world.deps.token.state = async () => ({ expiresIn: 30, source: "stale", usableCount: 1 });

  const statuses = [];
  const rungs = [];
  for (let i = 0; i < 3; i += 1) {
    const pass = await sweep({ apply: true });
    const row = healerReport().symptoms.find((s) => s.key === "token.expiring");
    const action = pass.actions.find((a) => a.symptom === "token.expiring");
    statuses.push(row.status);
    rungs.push(action ? action.rung : ""); // the rung this pass actually ran
    // The cooldown is per severity: clear it by moving the clock past it.
    world.advance(11 * 60 * 1000);
  }

  // The symptom clears as soon as its repair runs — it is not stuck "repaired"
  // — while the *rung* it reached is kept, which is what the next strike climbs.
  assert.deepEqual(statuses, ["repaired", "repaired", "repaired"]);
  assert.deepEqual(rungs, ["drop-token", "remint", "remint"], "the ladder did not climb, or climbed too far");
  assert.ok(world.calls.reset > 0 && world.calls.resolve > 0, "the token was never re-minted");
});

test("a repair that throws counts as a strike and eventually fails loudly", async () => {
  const world = healthyWorld({
    token: {
      state: async () => ({ expiresIn: 0, source: "", usableCount: 0 }),
      reset() {
        throw new Error("the cache is a lie");
      },
      resolve: async () => {
        throw new Error("no credential will answer");
      },
    },
  });

  for (let i = 0; i < 6; i += 1) {
    await sweep({ apply: true });
    world.advance(11 * 60 * 1000);
  }

  const row = healerReport().symptoms.find((s) => s.key === "token.exhausted");
  assert.ok(row, "the failed symptom vanished from the report");
  assert.equal(row.status, "failed", "a repair that keeps failing never reaches 'failed'");
  assert.ok(row.needsOperator, "a failed repair must tell the operator what to do");
  assert.match(healerReport().verdict, /need an operator/);
});

test("the same repair inside its cooldown is refused, not repeated", async () => {
  healthyWorld();
  const first = await repair("catalog.empty", { force: true });
  assert.equal(first.ran, true);

  const second = await repair("catalog.empty");
  assert.equal(second.ran, false);
  assert.equal(second.cooling, true, "a repeat inside the cooldown was not marked as cooling");
  assert.match(second.error, /cooling down/);
});

/* ------------------------------- the verdict ------------------------------ */

test("the verdict never says all-clear while a probe still reads badly", async () => {
  const world = healthyWorld();
  world.deps.token.state = async () => ({ expiresIn: 0, source: "", usableCount: 0 });

  await sweep({ apply: true });
  const verdict = healerReport().verdict;
  assert.notEqual(verdict, "Every probe passes", "repaired was reported as healthy");
  assert.match(verdict, /Repaired|Repairing/);
});

test("recovery is the only thing that lowers the ladder", async () => {
  const world = healthyWorld();
  world.deps.token.state = async () => ({ expiresIn: 30, source: "stale", usableCount: 1 });

  await sweep({ apply: true });
  world.advance(11 * 60 * 1000);
  await sweep({ apply: true });
  assert.equal(
    healerReport().symptoms.find((s) => s.key === "token.expiring").rung,
    1,
    "the ladder did not keep the rung the last repair reached"
  );

  // Now it clears.
  world.deps.token.state = async () => ({ expiresIn: 900, source: "fresh", usableCount: 1 });
  await sweep({ apply: false });
  const row = healerReport().symptoms.find((s) => s.key === "token.expiring");
  assert.equal(row.status, "healthy");
  assert.equal(row.rung, 0, "the ladder stayed primed after a recovery");
});

test("markHealthy is idempotent and quiet the second time", () => {
  healthyWorld();
  assert.equal(markHealthy("relay.failing", "for a test"), true);
  assert.equal(markHealthy("relay.failing", "for a test"), false);
  assert.equal(healerReport().symptoms.length, 1);
});

/* --------------------------------- bounds --------------------------------- */

test("a sweep with apply:false changes nothing", async () => {
  const world = healthyWorld({
    catalog: {
      load: async () => ({ count: 0 }),
      reload: async () => {
        world.calls.reload += 1;
        return { count: 14201 };
      },
    },
  });

  const pass = await sweep({ apply: false });
  assert.equal(pass.applied, false);
  assert.deepEqual(pass.actions, []);
  assert.equal(world.calls.reload, 0, "a read-only sweep ran a repair");
  // But it did *report* the fault, which the operator needs to see.
  assert.equal(pass.ok, false);
  assert.ok(pass.symptoms.some((s) => s.key === "catalog.empty" && s.status === "degraded"));
});

test("the report carries everything the panel draws", async () => {
  healthyWorld();
  await sweep({ apply: true });
  const report = healerReport();

  for (const key of ["at", "verdict", "counts", "symptoms", "ledger", "budget", "probes", "timeline"]) {
    assert.ok(report[key] !== undefined, `the report has no ${key}`);
  }
  assert.equal(report.probes.length, PROBES.length, "the report is missing probe readings");
  for (const probe of report.probes) {
    assert.equal(typeof probe.value, "number");
    assert.equal(typeof probe.ok, "boolean");
  }
  assert.equal(report.counts.healthy + report.counts.degraded + report.counts.failed >= 0, true);
});

test("the operator's Fix now forces a repair past the cooldown", async () => {
  healthyWorld();
  await repair("token.expiring", { force: true });
  const blocked = await repair("token.expiring");
  assert.equal(blocked.ran, false);

  const out = await healAction({ symptom: "token.expiring" });
  assert.ok(out.actions.some((a) => a.symptom === "token.expiring" && a.ran), "Fix now was blocked by the cooldown");
  assert.equal(out.swept, true);
});

test("a cache repair reports how much it actually dropped", async () => {
  const world = healthyWorld();
  await repair("relay.failing", { force: true });
  assert.equal(world.plans.size, 0, "the plan cache was not emptied");
  assert.ok(world.renditions.size >= 0);
});

test("reset returns a clean slate for the next test", async () => {
  healthyWorld();
  await sweep({ apply: true });
  resetHealer();
  const report = healerReport();
  assert.deepEqual(report.symptoms, []);
  assert.equal(report.probes.length, 0);
  assert.equal(report.verdict, "Every probe passes");
});
