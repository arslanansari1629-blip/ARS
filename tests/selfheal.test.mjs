/**
 * Self-healing tests.
 *
 * The site fixes itself quietly: unhealthy signers are demoted out of the way,
 * poisoned plans are dropped, and a dead guest token is refreshed — all without
 * a visitor ever seeing a control, a badge or an error caused by the repair
 * machinery itself. These tests pin the two halves of that promise:
 *
 *   1. it *acts* — the ladder re-orders, the caches empty, the token refreshes;
 *   2. it stays bounded — deduped, capped per hour, and decaying back to health
 *      so a bad minute cannot turn into a stuck "everything is broken" state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recordSignerResult,
  signerWeight,
  rankSigners,
  signerHealth,
  recordRelayFailure,
  relayHealth,
  registerCaches,
  reportPlaybackFailure,
  repairs,
  selfHealReport,
  resetSelfHeal,
} from "../lib/selfheal.mjs";

const HOSTS = ["a.example.org", "b.example.org", "c.example.org"];

function fresh() {
  resetSelfHeal();
}

/* ---------------------------------- signers ------------------------------- */

test("a signer that has not failed is trusted fully", () => {
  fresh();
  assert.equal(signerWeight("a.example.org"), 1);
  assert.deepEqual(rankSigners(HOSTS), HOSTS);
});

test("two failures demote a signer without quarantining it", () => {
  fresh();
  recordSignerResult("b.example.org", false, { status: 403 });
  recordSignerResult("b.example.org", false, { status: 403 });

  const weight = signerWeight("b.example.org");
  assert.ok(weight < 1, `expected a demoted weight, got ${weight}`);
  assert.ok(weight > 0, "a demoted signer is still tried, just last");

  // Still usable: it is ordered after the healthy hosts, not removed.
  assert.deepEqual(rankSigners(HOSTS).slice(-1), ["b.example.org"]);
  assert.equal(rankSigners(HOSTS).length, 3);

  assert.ok(
    repairs().some((r) => r.action === "signer.demote"),
    "the demotion is on the ledger"
  );
  assert.ok(!signerHealth().find((s) => s.host === "b.example.org").quarantined);
});

test("three failures quarantine a signer and drop it to the bottom", () => {
  fresh();
  for (let i = 0; i < 3; i += 1) recordSignerResult("c.example.org", false, { error: "unreachable" });

  assert.equal(signerWeight("c.example.org"), 0);
  assert.deepEqual(rankSigners(HOSTS).slice(-1), ["c.example.org"]);

  const health = signerHealth().find((s) => s.host === "c.example.org");
  assert.equal(health.quarantined, true);
  assert.ok(health.quarantineLeft > 0 && health.quarantineLeft <= 300);
  assert.ok(repairs().some((r) => r.action === "signer.quarantine"));
});

test("one success restores a quarantined signer's trust", () => {
  fresh();
  for (let i = 0; i < 3; i += 1) recordSignerResult("a.example.org", false, {});
  assert.equal(signerWeight("a.example.org"), 0);

  recordSignerResult("a.example.org", true);
  assert.equal(signerWeight("a.example.org"), 1);
  assert.deepEqual(rankSigners(HOSTS), HOSTS);
  assert.ok(repairs().some((r) => r.action === "signer.recovered"));
});

test("ranking is stable for equally healthy hosts", () => {
  fresh();
  recordSignerResult("b.example.org", false, {});
  const once = rankSigners(HOSTS);
  assert.deepEqual(rankSigners(HOSTS), once);
  assert.deepEqual(once.slice(0, 2), ["a.example.org", "c.example.org"]);
});

/* ---------------------------------- relay --------------------------------- */

test("repeated manifest failures drop the cached playback plans", () => {
  fresh();
  const plans = new Map([["folder-1", { url: "/api/sign" }]]);
  const renditions = new Map([["folder-1", ["720"]]]);
  let tokenResets = 0;
  registerCaches({
    plans,
    renditions,
    token: () => {
      tokenResets += 1;
    },
  });

  for (let i = 0; i < 4; i += 1) recordRelayFailure({ relay: "hls", kind: "manifest" });
  assert.equal(plans.size, 1, "four failures are not yet a pattern");

  recordRelayFailure({ relay: "hls", kind: "manifest" });
  assert.equal(plans.size, 0, "the fifth drops the plan cache");
  assert.ok(repairs().some((r) => r.action === "cache.plans"));
  assert.equal(tokenResets, 0, "a manifest failure is not a token problem");
});

test("repeated segment failures drop renditions, not plans", () => {
  fresh();
  const plans = new Map([["f", {}]]);
  const renditions = new Map([["f", []]]);
  registerCaches({ plans, renditions });

  for (let i = 0; i < 5; i += 1) recordRelayFailure({ relay: "hls", kind: "segment" });
  assert.equal(renditions.size, 0);
  assert.equal(plans.size, 1);
  assert.ok(repairs().some((r) => r.action === "cache.renditions"));
});

test("repeated signature failures refresh the guest token", () => {
  fresh();
  let resets = 0;
  registerCaches({
    token: () => {
      resets += 1;
    },
  });

  for (let i = 0; i < 5; i += 1) recordRelayFailure({ relay: "sign", kind: "signature" });
  assert.equal(resets, 1);
  assert.ok(repairs().some((r) => r.action === "token.refresh"));
});

test("network failures are recorded but do not touch any cache", () => {
  fresh();
  const plans = new Map([["f", {}]]);
  registerCaches({ plans });

  for (let i = 0; i < 5; i += 1) recordRelayFailure({ relay: "sign", kind: "unreachable" });
  assert.equal(plans.size, 1, "dropping a good plan would not fix a bad network");
  assert.ok(repairs().some((r) => r.action === "relay.throttle"));
  assert.equal(relayHealth().worst[0], "unreachable");
});

test("a single failure of each kind repairs nothing", () => {
  fresh();
  const plans = new Map([["f", {}]]);
  registerCaches({ plans, renditions: new Map(), token: () => assert.fail("no token reset") });

  for (const kind of ["manifest", "segment", "signature", "unreachable"]) {
    recordRelayFailure({ relay: "hls", kind });
  }
  assert.equal(plans.size, 1);
  assert.equal(repairs().length, 0);
});

/* ------------------------------ player reports ---------------------------- */

test("a player report drops that folder's plan so the retry re-probes", () => {
  fresh();
  const plans = new Map([
    ["dead", { url: "stale" }],
    ["alive", { url: "fresh" }],
  ]);
  const renditions = new Map([["dead", ["720"]]]);
  registerCaches({ plans, renditions });

  const out = reportPlaybackFailure({ folder: "dead", kind: "manifest", detail: "403" });
  assert.equal(out.repaired, true);
  assert.equal(out.dropped, true);
  assert.equal(plans.has("dead"), false);
  assert.equal(plans.has("alive"), true, "one dead folder must not flush every plan");
  assert.equal(renditions.has("dead"), false);
  assert.ok(repairs().some((r) => r.action === "plan.drop"));
});

test("a report for an uncached folder still forces a fresh probe", () => {
  fresh();
  registerCaches({ plans: new Map() });
  const out = reportPlaybackFailure({ folder: "never-cached", kind: "stall" });
  assert.equal(out.repaired, true);
  assert.equal(out.dropped, false);
  assert.ok(repairs().some((r) => r.action === "plan.unstick"));
});

test("a report without a folder is ignored", () => {
  fresh();
  registerCaches({ plans: new Map([["f", {}]]) });
  assert.deepEqual(reportPlaybackFailure({ folder: "", kind: "manifest" }), { repaired: false });
  assert.equal(repairs().length, 0);
});

test("healing works with no caches registered (cold serverless start)", () => {
  fresh();
  assert.doesNotThrow(() => {
    for (let i = 0; i < 5; i += 1) recordRelayFailure({ relay: "hls", kind: "manifest" });
    reportPlaybackFailure({ folder: "f", kind: "manifest" });
  });
  assert.ok(repairs().length > 0);
});

/* --------------------------------- bounds --------------------------------- */

test("identical repairs are deduped inside the window", () => {
  fresh();
  for (let i = 0; i < 3; i += 1) recordSignerResult("a.example.org", false, {});
  const demotions = repairs(40).filter((r) => r.action === "signer.demote");
  assert.equal(demotions.length, 1, "one flapping host is one entry, not three");
});

test("the hourly budget caps repairs instead of thrashing", () => {
  fresh();
  // Twenty different hosts so dedupe cannot absorb any of them.
  for (let i = 0; i < 20; i += 1) {
    recordSignerResult(`host-${i}.example.org`, false, {});
    recordSignerResult(`host-${i}.example.org`, false, {});
    recordSignerResult(`host-${i}.example.org`, false, {});
  }
  const report = selfHealReport();
  assert.ok(
    report.budget.usedLastHour <= report.budget.cap + 1,
    `budget overspent: ${report.budget.usedLastHour} > ${report.budget.cap}`
  );
  assert.ok(
    repairs(40).some((r) => r.action === "budget.exhausted"),
    "hitting the cap is itself reported, so a human knows to look"
  );
});

test("the ledger is bounded so a long-lived instance cannot grow forever", () => {
  fresh();
  for (let i = 0; i < 120; i += 1) {
    recordSignerResult(`h${i}.example.org`, false, {});
    recordSignerResult(`h${i}.example.org`, false, {});
  }
  assert.ok(repairs(200).length <= 40);
});

test("the report has everything the admin panel draws", () => {
  fresh();
  recordSignerResult("a.example.org", false, {});
  recordRelayFailure({ relay: "sign", kind: "manifest" });

  const report = selfHealReport();
  assert.ok(Array.isArray(report.signers));
  assert.ok(Array.isArray(report.repairs));
  assert.equal(typeof report.relay.failures10m, "number");
  assert.ok(report.budget.cap > 0);
  assert.equal(typeof report.budget.usedLastHour, "number");
});

test("the report never leaks a full URL where a host will do", () => {
  fresh();
  recordSignerResult("https://vidcloud.eu.org", false, {});
  const host = selfHealReport().signers[0].host;
  assert.equal(host, "vidcloud.eu.org");
  assert.ok(!host.includes("://"));
});

test("reset returns a clean slate for the next test", () => {
  fresh();
  // A single failure is noise and is deliberately not on the ledger; the second
  // is what proves the signer is in trouble.
  recordSignerResult("a.example.org", false, {});
  assert.equal(repairs().length, 0, "one failure is not an incident");
  recordSignerResult("a.example.org", false, {});
  assert.ok(repairs().length > 0);
  resetSelfHeal();
  assert.equal(repairs().length, 0);
  assert.equal(selfHealReport().signers.length, 0);
  assert.equal(selfHealReport().budget.usedLastHour, 0);
});
