/**
 * The browser's own report.
 *
 * Two modules are under test, and they are the two halves of one sense:
 *
 *   `public/assets/telemetry.js` — runs in the visitor's browser, catches what
 *   the browser throws, and sends *aggregated* evidence to the server.
 *
 *   `lib/client-errors.mjs` — receives it, distrusts it, folds it into bounded
 *   fingerprints, and tells the healer whether a page is broken.
 *
 * The properties worth pinning are not "does it record an error". They are the
 * ones that decide whether a self-reporting client is an asset or a liability:
 * nothing personal leaves the page, one bug is one bucket, a throw loop cannot
 * become a request flood, and a single exception is not a broken site.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  scrub,
  fingerprint,
  note,
  pending,
  reset as resetTelemetry,
  install,
  flush,
} from "../public/assets/telemetry.js";
import {
  ingest,
  clientFaults,
  clientFaultVerdict,
  resetClientFaults,
  RECENT_MS,
} from "../lib/client-errors.mjs";

/* ------------------------------------------------------------------ scrub */

test("a signed URL loses its query before it leaves the page", () => {
  const out = scrub("failed at https://cdn.test/stream/video.m3u8?token=SECRET&uid=991");
  assert.ok(out.includes("/stream/video.m3u8"), "the path is what identifies the bug");
  assert.ok(!out.includes("SECRET"), "the signature must not travel");
  assert.ok(!out.includes("991"), "the student id must not travel");
});

test("a same-origin path with a query is reduced to its path", () => {
  const out = scrub("GET /api/batches?id=abc&limit=20 failed");
  assert.equal(out.includes("?"), false);
  assert.ok(out.includes("/api/batches"));
});

test("tokens and email addresses are replaced, not truncated away", () => {
  const out = scrub(
    "user a.student+tag@example.co.uk sent eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl"
  );
  assert.ok(out.includes("[email]"));
  assert.ok(out.includes("[token]"));
  assert.ok(!out.includes("example.co.uk"));
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"));
});

test("scrubbing is bounded and idempotent enough to survive a repeat", () => {
  const long = "x".repeat(1000);
  assert.equal(scrub(long, 40).length, 40);
  // Running it twice must not undo the first pass: scrubbing is what the client
  // claims and what the server does anyway, so the two must reach the same place.
  const once = scrub("see /api/a?token=1", 200);
  assert.equal(once, "see /api/a");
  assert.equal(scrub(once, 200), once);
});

/* ------------------------------------------------------------ fingerprint */

test("the same bug in two page views is one fingerprint", () => {
  const a = fingerprint({ message: "Cannot read properties of undefined", source: "/assets/b.js", line: 12 });
  const b = fingerprint({ message: "Cannot read properties of undefined", source: "/assets/b.js", line: 12 });
  assert.equal(a, b);
});

test("the same message at two different places is two fingerprints", () => {
  const a = fingerprint({ message: "undefined is not a function", source: "/assets/a.js", line: 1 });
  const b = fingerprint({ message: "undefined is not a function", source: "/assets/b.js", line: 1 });
  assert.notEqual(a, b, "a message alone is too coarse to group by");
});

/* -------------------------------------------------------------- telemetry */

test("repeated faults fold into one bucket with a count", () => {
  resetTelemetry();
  for (let i = 0; i < 5; i += 1) {
    note({ message: "boom", source: "/assets/x.js", line: 3, column: 1 });
  }
  const queued = pending();
  assert.equal(queued.length, 1, "one bug is one bucket, not five");
  assert.equal(queued[0].count, 5);
});

test("a page view will not report more than its budget of distinct faults", () => {
  resetTelemetry();
  for (let i = 0; i < 40; i += 1) {
    note({ message: `failure number ${i}`, source: "/assets/x.js", line: i });
  }
  const queued = pending();
  assert.ok(queued.length <= 6, `expected a cap of 6, got ${queued.length}`);
  assert.ok(queued.length > 0, "the cap must still report something");
});

test("the per-fingerprint count is capped even inside a throw loop", () => {
  resetTelemetry();
  for (let i = 0; i < 500; i += 1) note({ message: "same", source: "/a.js", line: 1 });
  assert.equal(pending()[0].count, 50, "a loop must not produce an unbounded count");
});

test("a message that is not evidence is refused", () => {
  resetTelemetry();
  assert.equal(note({ message: "" }), false);
  assert.equal(note({ message: "Script error." }), false, "a cross-origin stub names no bug");
  assert.equal(pending().length, 0);
});

test("nothing is queued until something is wrong", () => {
  resetTelemetry();
  resetClientFaults();
  assert.equal(pending().length, 0);
  const flushCount = flush();
  assert.equal(flushCount, 0, "a clean page view must send nothing");
  assert.equal(clientFaults().counts.recentDistinct, 0);
});

test("install is idempotent and a no-op outside a browser", () => {
  resetTelemetry();
  // No `window` in this test process: installing must be a refusal, not a crash.
  assert.equal(install(), false);
});

/* ----------------------------------------------------------------- ingest */

test("a report is folded by fingerprint and keeps first and last time", () => {
  resetClientFaults();
  const now = Date.now();
  ingest(
    { page: "/batches", faults: [{ kind: "error", message: "boom", source: "/assets/b.js", count: 2, fingerprint: "f1" }] },
    { address: "10.0.0.1", now }
  );
  ingest(
    { page: "/batches", faults: [{ kind: "error", message: "boom", source: "/assets/b.js", count: 3, fingerprint: "f1" }] },
    { address: "10.0.0.2", now: now + 1000 }
  );
  const report = clientFaults({ now: now + 2000 });
  assert.equal(report.counts.distinct, 1, "one bug is one row");
  assert.equal(report.open[0].count, 5, "five sightings");
  assert.equal(report.counts.occurrences, 5);
  assert.ok(report.open[0].ageMs >= 2000 - 60, "the first sighting is remembered");
});

test("the report's own page is used when a fault does not name one", () => {
  resetClientFaults();
  ingest(
    { page: "/subject", faults: [{ kind: "error", message: "x", fingerprint: "p" }] },
    { address: "10.0.0.3" }
  );
  const report = clientFaults();
  assert.equal(report.open[0].page, "/subject");
  assert.equal(report.pages[0].page, "/subject");
});

test("the server re-scrubs what the client claimed to have scrubbed", () => {
  resetClientFaults();
  ingest(
    {
      page: "/lecture",
      faults: [{ kind: "error", message: "leak student@example.com at /api/s?token=abc", fingerprint: "leak" }],
    },
    { address: "10.0.0.4" }
  );
  const row = clientFaults().open[0];
  assert.ok(!row.message.includes("student@example.com"), "a malfunctioning client is not trusted");
  assert.ok(!row.message.includes("token=abc"));
});

test("a fault with no message is not stored", () => {
  resetClientFaults();
  const receipt = ingest({ faults: [{ kind: "error", message: "   " }, { message: "real" }] }, { address: "10.0.0.5" });
  assert.equal(receipt.accepted, 1);
  assert.equal(receipt.dropped, 1);
});

test("one address cannot flood the log", () => {
  resetClientFaults();
  let refused = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = ingest({ faults: [{ message: `e${i}`, fingerprint: `f${i}` }] }, { address: "9.9.9.9" });
    if (r.throttled) refused += 1;
  }
  assert.ok(refused > 0, "the throttle must actually engage");
  assert.ok(clientFaults().counts.distinct <= 80, "the ring buffer stays bounded");
});

test("a report cannot carry more than eight faults", () => {
  resetClientFaults();
  const faults = Array.from({ length: 20 }, (_, i) => ({ message: `fault ${i}`, fingerprint: `x${i}` }));
  const receipt = ingest({ faults }, { address: "10.0.0.6" });
  assert.equal(receipt.accepted, 8);
});

test("an old fault is not reported as current", () => {
  resetClientFaults();
  const now = Date.now();
  ingest({ faults: [{ message: "old news", fingerprint: "old" }] }, { address: "10.0.0.7", now });
  const report = clientFaults({ now: now + RECENT_MS + 5000 });
  assert.equal(report.counts.recentDistinct, 0, "a fixed bug must stop being a fault");
  assert.equal(report.counts.distinct, 1, "but it is not forgotten either");
});

/* ----------------------------------------------------------------- verdict */

test("a single exception from one visitor is not a broken site", () => {
  resetClientFaults();
  ingest({ page: "/open", faults: [{ message: "one off", fingerprint: "one", count: 1 }] }, { address: "10.0.0.8" });
  const verdict = clientFaultVerdict(clientFaults());
  assert.equal(verdict.level, "warn", "crying wolf on the first exception teaches the operator to ignore it");
});

test("one fault seen five times is a broken page", () => {
  resetClientFaults();
  ingest({ page: "/batches", faults: [{ message: "boom", fingerprint: "b", count: 5 }] }, { address: "10.0.0.9" });
  const verdict = clientFaultVerdict(clientFaults());
  assert.equal(verdict.level, "bad");
  assert.equal(verdict.page, "/batches");
});

test("two distinct faults are a broken page even at low counts", () => {
  resetClientFaults();
  ingest(
    {
      page: "/viewer",
      faults: [
        { message: "a", fingerprint: "a", count: 1 },
        { message: "b", fingerprint: "b", count: 1 },
      ],
    },
    { address: "10.0.0.10" }
  );
  assert.equal(clientFaultVerdict(clientFaults()).level, "bad");
});

test("a quiet site is quiet", () => {
  resetClientFaults();
  const verdict = clientFaultVerdict(clientFaults());
  assert.equal(verdict.level, "ok");
  assert.equal(clientFaultVerdict().summary, "no script errors reported");
});

/* ---------------------------------------------------- healer integration */

test("the healer can decide on a browser fault with its own probe", async () => {
  const healer = await import("../lib/healer.mjs");
  assert.ok(healer.SYMPTOMS["client.errors"], "the browser fault must be a known symptom");
  assert.equal(healer.SYMPTOMS["client.errors"].repair, "client.recover");

  const probe = healer.PROBES.find((p) => p.id === "client-errors");
  assert.ok(probe, "the probe must be registered");
  assert.deepEqual(probe.symptoms, ["client.errors"]);

  resetClientFaults();
  ingest({ page: "/batches", faults: [{ message: "boom", fingerprint: "z", count: 6 }] }, { address: "10.0.0.11" });
  const reading = await probe.run.call({ deps: { client: () => clientFaults() } });
  // The probe reads the dependency registry, not a global; drive it the same way.
  healer.registerHealerDependencies({ client: () => clientFaults() });
  const proper = await probe.run();
  assert.equal(proper.ok, false, "six faults in the window must fail the probe");
  assert.equal(probe.which(proper), "client.errors");
  assert.ok(proper.value >= 6);
  assert.equal(reading.unit, proper.unit);
});

test("the repairable ladder for a browser fault is bounded and ends in an operator", () => {
  return import("../lib/healer.mjs").then((healer) => {
    const ladder = healer.REPAIRS["client.recover"];
    assert.ok(ladder, "the repair must exist or the symptom cannot climb");
    assert.ok(ladder.rungs.length >= 2 && ladder.rungs.length <= 4, "a bounded ladder, not a retry loop");
    assert.ok(ladder.needsOperator, "a code fault must be handed to a person, not retried forever");
  });
});

/* ------------------------------------------------------- across instances */

/*
 * A serverless deployment is several processes. A report that lands on one is
 * invisible to the panel if the next request is served by another — the same trap
 * the scanner hit with `sharedAt`. The fault log is therefore published to the one
 * store document and hydrated on read, and these tests are what stops that seam
 * from silently rotting.
 */

test("a fault published by one instance is visible to a fresh one", async () => {
  const { persistClientFaults, hydrateClientFaults } = await import("../lib/client-errors.mjs");
  resetClientFaults();
  ingest(
    { page: "/batches", faults: [{ message: "grid failed to render", source: "/assets/app.js", count: 3, fingerprint: "shared-1" }] },
    { address: "10.0.1.1" }
  );
  assert.equal(await persistClientFaults({ force: true }), true, "the store refused the snapshot");

  // A cold instance: its own buffer is empty.
  resetClientFaults();
  assert.equal(clientFaults().counts.distinct, 0);
  const merged = await hydrateClientFaults();
  assert.ok(merged >= 1, "nothing was taken from the store");
  const report = clientFaults();
  assert.equal(report.counts.distinct, 1);
  assert.equal(report.open[0].message, "grid failed to render");
  assert.equal(report.open[0].page, "/batches", "the page survives the round trip");
});

test("merging two instances does not double-count the same fault", async () => {
  const { persistClientFaults, hydrateClientFaults } = await import("../lib/client-errors.mjs");
  resetClientFaults();
  ingest({ faults: [{ message: "boom", fingerprint: "dup", count: 4 }] }, { address: "10.0.1.2" });
  await persistClientFaults({ force: true });

  // The same instance hydrates its own snapshot back: four, not eight.
  await hydrateClientFaults();
  assert.equal(clientFaults().counts.occurrences, 4, "hydrating its own snapshot doubled the count");
});

test("a local count that exceeds the stored one is not reduced", async () => {
  const { persistClientFaults, hydrateClientFaults } = await import("../lib/client-errors.mjs");
  resetClientFaults();
  ingest({ faults: [{ message: "boom", fingerprint: "grow", count: 2 }] }, { address: "10.0.1.3" });
  await persistClientFaults({ force: true });

  // This instance has seen it three more times since publishing.
  ingest({ faults: [{ message: "boom", fingerprint: "grow", count: 3 }] }, { address: "10.0.1.3" });
  await hydrateClientFaults();
  assert.equal(clientFaults().counts.occurrences, 5, "the fresher local evidence was overwritten by an older snapshot");
});

test("an expired fault is not resurrected from the store", async () => {
  const { persistClientFaults, hydrateClientFaults, RECENT_MS } = await import("../lib/client-errors.mjs");
  resetClientFaults();
  ingest({ faults: [{ message: "old", fingerprint: "stale", count: 2 }] }, { address: "10.0.1.4" });
  await persistClientFaults({ force: true });
  resetClientFaults();
  // Far enough in the future that the stored row is past its lifetime.
  await hydrateClientFaults({ now: Date.now() + 12 * 60 * 60 * 1000 });
  assert.equal(clientFaults({ now: Date.now() + 12 * 60 * 60 * 1000 }).counts.distinct, 0);
  assert.ok(RECENT_MS > 0);
});
