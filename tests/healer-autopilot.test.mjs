/**
 * The god-level layer: a playback canary, an own-signer probe, autopilot
 * repairs and the KPIs that prove any of it happened.
 *
 * The canary is the probe that would have caught the day every third-party
 * signer relay died together: the components all looked arguable while no
 * lecture could play. These tests pin the canary's symptom, its repair
 * ladder, and the rule that an *unconfigured* own worker is skipped —
 * never a fault.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  registerHealerDependencies,
  registerTraffic,
  sweep,
  healerReport,
  reportFault,
  markHealthy,
  resetHealer,
  setNow,
} from "../lib/healer.mjs";

function world({ canary, ownsigner } = {}) {
  resetHealer();
  let clock = 1_700_000_000_000;
  setNow(() => clock);
  const plans = new Map([["folder-1", { playable: true }]]);
  const renditions = new Map([["folder-1", { renditions: [] }]]);
  const calls = { reset: 0, signersReset: 0 };
  registerHealerDependencies({
    catalog: { load: async () => ({ count: 14201 }), reload: async () => ({ count: 14201 }) },
    token: {
      state: async () => ({ expiresIn: 600, source: "fake", usableCount: 1 }),
      reset() { calls.reset += 1; },
      resolve: async () => ({ token: "x".repeat(60), source: "fresh" }),
    },
    signers: {
      health: () => [{ host: "a.example.org", weight: 1, fails: 0, reason: "" }],
      reset: () => { calls.signersReset += 1; return 1; },
      quarantine: () => true,
      probe: async () => ({ ok: true, hosts: [] }),
    },
    assets: { verify: async () => ({ missing: [] }) },
    caches: { plans, renditions },
    ...(canary ? { canary } : {}),
    ...(ownsigner ? { ownsigner } : {}),
  });
  registerTraffic(() => ({ requests: 10, errors: 0, errorRate: 0 }));
  return { plans, renditions, calls, advance: (ms) => { clock += ms; } };
}

test("a failing playback canary raises playback.down and autopilot repairs it", async () => {
  const { plans } = world({
    canary: {
      run: async () => ({ ok: false, ms: 900, segments: 0, detail: "first segment would not fetch" }),
    },
  });

  const pass = await sweep({ apply: true });
  const symptom = pass.symptoms.find((s) => s.key === "playback.down");
  assert.ok(symptom, "the canary failure must surface as a symptom");
  assert.equal(symptom.status, "repaired");
  const action = pass.actions.find((a) => a.symptom === "playback.down");
  assert.ok(action?.ran, "autopilot must run the repair without an operator");
  assert.equal(action.rung, "drop-plans");
  assert.equal(plans.size, 0, "the first rung drops the cached plans");

  const report = healerReport();
  assert.equal(report.autopilot.canary.ok, false);
  assert.ok(report.autopilot.repairsLastHour >= 1, "the repair lands in the hourly KPI");
});

test("a passing canary keeps playback healthy and reports its reading", async () => {
  world({
    canary: {
      run: async () => ({ ok: true, ms: 320, segments: 1257, rendition: "480", via: "signer ladder" }),
    },
  });
  const pass = await sweep({ apply: true });
  assert.equal(pass.ok, true);
  const report = healerReport();
  assert.equal(report.autopilot.canary.ok, true);
  assert.equal(report.autopilot.canary.ms, 320);
});

test("an unconfigured own signer is skipped, never a fault", async () => {
  world({});
  const pass = await sweep({ apply: true });
  const probe = pass.readings.find((r) => r.id === "own-signer");
  assert.equal(probe.skipped, true);
  assert.equal(pass.symptoms.find((s) => s.key === "signer.own")?.status ?? "healthy", "healthy");
});

test("a dead own signer raises signer.own and fails over", async () => {
  const { calls } = world({
    ownsigner: { run: async () => ({ ok: false, ms: 4000, detail: "own worker unreachable" }) },
  });
  const pass = await sweep({ apply: true });
  const action = pass.actions.find((a) => a.symptom === "signer.own");
  assert.ok(action?.ran, "autopilot must attempt the failover");
  assert.equal(action.rung, "reset-ladder");
  assert.equal(calls.signersReset, 1);
});

test("autopilot KPIs count incidents, recoveries and mean time to repair", async () => {
  const { advance } = world({});
  reportFault("relay.failing", "relay is failing");
  advance(90 * 1000);
  markHealthy("relay.failing", "the probe passes again");
  const report = healerReport();
  assert.equal(report.autopilot.incidents, 1);
  assert.equal(report.autopilot.recoveries, 1);
  assert.equal(report.autopilot.mttrSeconds, 90);
});
