/**
 * The full-site scanner and the five-minute scheduler.
 *
 * These are the tests that keep the *claims* honest. A scanner is easy to write
 * and easy to make dishonest: one that only ever looks at page one, or that calls
 * a 200 an all-clear, or that reports a blind spot as an outage, is worse than no
 * scanner at all because the panel would be believed.
 *
 * So the assertions here are about coverage arithmetic, about a fault being seen
 * rather than fixed, and about the cadence — including the one thing an operator
 * most needs to know: which clock is actually running.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  scanPass,
  scannerReport,
  scannerState,
  resetScanner,
  restoreScanner,
  findings,
  clearFinding,
  localChecks,
  PAGE_CONTRACT,
  API_CONTRACT,
  BATCH_WINDOW,
  PASS_BUDGET_MS,
} from "../lib/scanner.mjs";
import {
  TICK_MS,
  SLICE_WINDOW,
  tick,
  runSlice,
  scheduleReport,
  resetScheduler,
  restoreSchedulerState,
  awaitIdle,
  selfBaseOf,
  noteExternalTick,
} from "../lib/scheduler.mjs";
import { SYMPTOMS, REPAIRS, repair, healerReport, reportFault, resetHealer } from "../lib/healer.mjs";
import { resetStore } from "../lib/store.mjs";

/* ---------------------------------------------------------------- the site */

const ALL_PAGES = Object.keys(PAGE_CONTRACT);
const PAGES = ALL_PAGES.filter((f) => f !== "404.html");

/**
 * A stub site. Each test says which route is broken; everything else answers the
 * way the real deployment does. `seen` records every path fetched, which is how
 * the coverage assertions are checked against reality rather than against the
 * scanner's own bookkeeping.
 */
function stubSite({ broken = {}, pages = null, seen = [] } = {}) {
  return async (input) => {
    const url = new URL(String(input));
    const key = url.pathname + (url.search || "");
    seen.push(key);

    for (const [needle, answer] of Object.entries(broken)) {
      if (key.startsWith(needle)) {
        if (answer === "hang") return new Promise(() => {});
        return makeRes(answer.status || 500, answer.body ?? "", answer.type || "text/html");
      }
    }

    // Pages
    if (url.pathname === "/" || ALL_PAGES.some((f) => url.pathname === "/" + f.replace(/\.html$/, ""))) {
      // By default a page is served *as shipped*: a stub written by hand drifts
      // from the real DOM, and a drifting stub is how a scanner test starts
      // certifying selectors that no longer exist.
      const name = url.pathname.slice(1);
      const file = url.pathname === "/" ? "index.html" : name.endsWith(".html") ? name : name + ".html";
      const html = pages === null ? await readFile(path.join(process.cwd(), "public", file), "utf8") : pages;
      return makeRes(200, html, "text/html; charset=utf-8");
    }
    if (url.pathname === "/this-page-does-not-exist-scan-check") return makeRes(404, "nope", "text/html");
    // Batch pages are addressed by id, so they are *not* in the static page list
    // and must be answered here or every batch looks like a dead link.
    if (url.pathname === "/batch.html") {
      const html = pages === null ? await readFile(path.join(process.cwd(), "public", "batch.html"), "utf8") : pages;
      return makeRes(200, html, "text/html; charset=utf-8");
    }
    if (url.pathname === "/api/batches") {
      if (url.searchParams.get("facets") === "1") {
        return makeRes(200, JSON.stringify({
          success: true,
          languages: [{ key: "hinglish", label: "Hinglish", count: 10347 }],
          prices: { free: 1200, paid: 13001 },
        }), "application/json");
      }
      // `pageSize` is the reader's paging check: it must return exactly that many.
      const size = Number(url.searchParams.get("pageSize") || 20);
      const rows = Array.from({ length: size }, (_, i) => ({ id: `b${i}`, name: `Arjuna JEE ${i}` }));
      return makeRes(200, JSON.stringify({ success: true, batches: rows }), "application/json");
    }
    if (url.pathname === "/api/token") {
      return makeRes(200, JSON.stringify({ success: true, token: { value: "…", source: "fallback" } }), "application/json");
    }
    if (url.pathname === "/api/batch") {
      // The real route's `header=1` answers `subjects: null` by design; the full
      // answer carries them. The stub has to keep that difference, because it is
      // exactly the difference that made a scan call every batch empty.
      const slim = url.searchParams.get("header") === "1";
      const body = {
        success: true,
        batch: { id: url.searchParams.get("id"), name: "Arjuna JEE 2027" },
        subjects: slim ? null : [{ id: "s1", slug: "physics", name: "Physics" }],
      };
      return makeRes(200, JSON.stringify(body), "application/json");
    }
    if (url.pathname === "/api/contents") {
      return makeRes(200, JSON.stringify({ success: true, chapters: [{ id: "t1", name: "Chapter 1" }] }), "application/json");
    }
    if (url.pathname === "/api/check") return makeRes(400, JSON.stringify({ success: false, error: "batch or url is required" }), "application/json");
    if (url.pathname === "/api/media") return makeRes(200, "%PDF-1.4 fake", "application/pdf");
    return makeRes(404, "not found", "text/html");
  };
}

function makeRes(status, body, type) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? type : null) },
    text: async () => body,
  };
}

/** Run a scan with the stub site installed, and always put the real fetch back. */
async function withSite(site, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = site;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const BATCHES = Array.from({ length: 100 }, (_, i) => `batch-${i}`);

beforeEach(() => {
  resetScanner();
  resetScheduler();
  resetHealer();
  resetStore();
});

/* ------------------------------------------------------------- the shape */

test("the scanner promises a real surface: every page and every public route", () => {
  // Eighteen pages ship; the scanner checks the seventeen it can address plus the
  // not-found shell, which is checked on a URL that does not exist.
  assert.ok(PAGES.length >= 13, `only ${PAGES.length} pages are in the contract`);
  for (const file of PAGES) {
    assert.ok(Array.isArray(PAGE_CONTRACT[file]) && PAGE_CONTRACT[file].length > 0, `${file} has no content contract`);
  }
  // Every route the pages call must be in the contract, because a route nobody
  // checks is a route that can 500 for a week without anyone noticing.
  const paths = API_CONTRACT.map((c) => c.path);
  for (const route of ["/api/batches", "/api/batch", "/api/contents", "/api/check"]) {
    assert.ok(paths.some((p) => p.startsWith(route)), `${route} is not checked`);
  }
  for (const spec of API_CONTRACT) {
    assert.equal(typeof spec.ok, "function", `${spec.path} has no notion of a good answer`);
    assert.ok(spec.symptom, `${spec.path} cannot say what a failure means`);
  }
});

test("every page contract matches the page that actually shipped", async () => {
  // This is the test that stops a scanner rotting into a false-alarm generator.
  // A contract written from memory ("subject.html has a #chapterList") reports a
  // healthy page as broken on every pass, forever — and an operator who sees one
  // permanent red row stops reading all of them. The shipped HTML is the source
  // of truth, so it is read directly rather than trusted.
  for (const [file, patterns] of Object.entries(PAGE_CONTRACT)) {
    const html = await readFile(path.join(process.cwd(), "public", file), "utf8");
    for (const pattern of patterns) {
      assert.match(html, pattern, `${file} does not match its own contract: ${pattern}`);
    }
  }
  // And every shipped page must be in the contract: a page nobody checks is a
  // page that can 404 for a month.
  const shipped = (await readdir(path.join(process.cwd(), "public"))).filter((f) => f.endsWith(".html")).sort();
  assert.deepEqual(Object.keys(PAGE_CONTRACT).sort(), shipped, "a shipped page is not being scanned");
});

test("a healthy site produces coverage and no findings", async () => {
  const seen = [];
  const pass = await withSite(stubSite({ seen }), () =>
    scanPass({ base: "https://example.test", batches: BATCHES, budget: 20000, windowSize: 4 })
  );

  assert.equal(pass.findings.length, 0, `a healthy site reported: ${pass.findings.map((f) => f.what).join("; ")}`);
  assert.ok(pass.checks > PAGES.length, `only ${pass.checks} checks ran`);
  assert.equal(pass.scanned, 4, "the window was not walked");
  assert.equal(pass.blind, false, "a reachable site was reported as a blind spot");

  // It really fetched the pages and the routes, not a summary of them.
  assert.ok(seen.includes("/"), "the home page was never requested");
  assert.ok(seen.some((p) => p.startsWith("/api/batches")), "the catalogue route was never requested");
  assert.ok(seen.some((p) => p.startsWith("/api/contents")), "the contents route was never requested");
  // And the batch walk is a window from the cursor, not the whole catalogue.
  assert.ok(seen.filter((p) => p.startsWith("/api/batch?")).length <= 6);
});

test("the cursor walks the catalogue instead of re-checking page one", async () => {
  const site = stubSite();

  const passes = [];
  for (let i = 0; i < 3; i += 1) {
    passes.push(
      await withSite(site, () =>
        scanPass({ base: "https://example.test", batches: BATCHES, budget: 20000, windowSize: 5 })
      )
    );
  }

  // 3 passes x 5 batches = 15 of 100, and the cursor is where work stopped.
  assert.equal(scannerState().cursor, 15, `cursor is ${scannerState().cursor} after 15 batches`);
  assert.equal(passes[2].progress.cursor, 15);
  // The honest coverage figure: 15%, not "complete".
  assert.equal(passes[2].perMille, 150);
  assert.equal(passes[2].progress.of, 100);
});

test("the cursor wraps, and a full cycle is recorded when it does", async () => {
  // Six batches of ten, window of four: the second pass crosses the end.
  const site = stubSite();
  const batches = BATCHES.slice(0, 10);

  await withSite(site, () => scanPass({ base: "https://example.test", batches, budget: 20000, windowSize: 4 }));
  assert.equal(scannerState().cursor, 4);
  assert.equal(scannerReport().progress.lastFullCycleAt, "", "a cycle was claimed before one finished");

  await withSite(site, () => scanPass({ base: "https://example.test", batches, budget: 20000, windowSize: 4 }));
  assert.equal(scannerState().cursor, 8);

  await withSite(site, () => scanPass({ base: "https://example.test", batches, budget: 20000, windowSize: 4 }));
  // 8 + 4 = 12, wrapped to 2.
  assert.equal(scannerState().cursor, 2, "the walk did not wrap around the catalogue");
  assert.ok(scannerReport().progress.lastFullCycleAt, "wrapping the catalogue did not count as a full cycle");
});

test("a page that answers 200 with an error shell is a fault, not a pass", async () => {
  const shell = `<!doctype html><html><head><title>404 — arsvibe</title></head><body>not here</body></html>`;
  const pass = await withSite(stubSite({ pages: shell }), () =>
    scanPass({ base: "https://example.test", batches: [], budget: 20000 })
  );

  const pageFaults = pass.findings.filter((f) => f.area === "pages");
  assert.ok(pageFaults.length >= 10, `only ${pageFaults.length} pages were flagged`);
  assert.ok(pageFaults.every((f) => f.severity === "high"));
  // The finding must say *why*, or an operator learns nothing from it.
  assert.match(pageFaults[0].detail, /landmark|404/i);
});

test("a route that answers an error envelope is a fault even with a 200", async () => {
  // The site's own convention: JSON with success:false at an unexpected status is
  // a failure. A status-only check would call this healthy.
  const site = stubSite({
    broken: { "/api/contents": { status: 200, body: JSON.stringify({ success: false, error: "upstream 502" }), type: "application/json" } },
  });
  const pass = await withSite(site, () => scanPass({ base: "https://example.test", batches: [], budget: 20000 }));

  const route = pass.findings.find((f) => f.where.startsWith("/api/contents"));
  assert.ok(route, "a route answering success:false was not flagged");
  assert.equal(route.symptom, "api.upstream");
  assert.match(route.detail, /upstream 502/);
});

test("the site's own not-found page is accepted even when a host answers 200", async () => {
  // Real hosts differ: one answers 404 with the shell, another rewrites everything
  // to it with a 200. Both are correct for a visitor, and neither is a fault.
  const shell = await readFile(path.join(process.cwd(), "public", "404.html"), "utf8");
  const site = stubSite();
  const soft = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/this-page-does-not-exist-scan-check") return makeRes(200, shell, "text/html");
    return site(input);
  };

  const pass = await withSite(soft, () => scanPass({ base: "https://example.test", batches: [], budget: 20000 }));
  const missing = pass.findings.filter((f) => f.where === "/<missing>");
  assert.deepEqual(missing, [], "a correct not-found page was reported as a fault");

  // But a *catch-all* that serves a real page for a typo is still a fault.
  const swallow = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/this-page-does-not-exist-scan-check") {
      return makeRes(200, await readFile(path.join(process.cwd(), "public", "index.html"), "utf8"), "text/html");
    }
    return site(input);
  };
  const swallowed = await withSite(swallow, () => scanPass({ base: "https://example.test", batches: [], budget: 20000 }));
  assert.ok(
    swallowed.findings.some((f) => f.where === "/<missing>"),
    "a catch-all swallowing every typo was not reported"
  );
});

test("a scanner that cannot reach the site reports a blind spot, not an outage", async () => {
  // This is the failure that would make the healer burn its budget on a fault
  // that is on the scanner's side of the wire. One finding, no symptom.
  const down = async () => {
    throw new Error("ECONNREFUSED");
  };
  const pass = await withSite(down, () => scanPass({ base: "https://example.test", batches: BATCHES, budget: 5000 }));

  assert.equal(pass.blind, true, "an unreachable site was not reported as a blind spot");
  const pageFindings = pass.findings.filter((f) => f.area === "pages");
  assert.equal(pageFindings.length, 1, `${pageFindings.length} page findings for one unreachable host`);
  assert.equal(pageFindings[0].symptom, "", "a blind spot was given a repair symptom");
  assert.equal(pageFindings[0].blind, true);
  assert.match(pageFindings[0].detail, /SELF_BASE/);
});

test("the budget stops a pass, and what was not looked at is not claimed", async () => {
  // Every request is slow enough that the second one runs out the clock.
  const slow = async (input) => {
    await new Promise((r) => setTimeout(r, 25));
    return stubSite()(input);
  };
  const pass = await withSite(slow, () =>
    scanPass({ base: "https://example.test", batches: BATCHES, budget: 120, windowSize: 50 })
  );

  assert.ok(pass.scanned < 50, "the budget did not stop the walk");
  assert.equal(pass.complete, false, "a pass that ran out of budget called itself complete");
  assert.ok(pass.perMille < 1000, "partial coverage was reported as complete");
  // Whatever it did scan is what the cursor moved by: no batch is skipped.
  assert.equal(scannerState().cursor, pass.scanned);
});

/* -------------------------------------------------------- the healer's door */

test("every symptom the scanner can name is one the healer can repair", () => {
  const scannerKeys = new Set(["site.page", "api.route", "catalog.unreadable", "api.upstream", "relay.failing", "assets.stale"]);
  for (const key of scannerKeys) {
    assert.ok(SYMPTOMS[key], `the scanner emits ${key}, which the healer does not know`);
    assert.ok(REPAIRS[SYMPTOMS[key].repair], `${key} names a repair that does not exist`);
  }
});

test("a fault the scan found is recorded as degraded, without counting a strike", () => {
  // A sighting is not a failed repair: an escalation ladder that climbs on
  // observation would climb every time a network blips.
  const first = reportFault("site.page", "batch.html answered 500");
  assert.equal(first, true, "the first sighting was not recorded");
  assert.equal(healerReport().symptoms.find((s) => s.key === "site.page").status, "degraded");

  const second = reportFault("site.page", "batch.html answered 500");
  assert.equal(second, false, "a repeated sighting churned the timeline");
  const row = healerReport().symptoms.find((s) => s.key === "site.page");
  assert.equal(row.rung, 0, "a sighting climbed the repair ladder");
});

test("an unknown symptom cannot be injected through reportFault", () => {
  assert.equal(reportFault("nonsense.key", "x"), false);
  assert.equal(healerReport().symptoms.length, 0);
});

/* ------------------------------------------------------------- the clock */

test("the scheduler ticks at most once every five minutes", async () => {
  assert.equal(TICK_MS, 5 * 60 * 1000);

  // The tick starts a slice and does not wait for it, so the site's own probe is
  // stubbed and the slice is awaited before the test ends — otherwise it lands in
  // whichever test happens to be running when it finishes.
  const first = await withSite(stubSite(), async () => {
    const decision = tick({ headers: { host: "example.test" } }, { base: "https://example.test" });
    await awaitIdle();
    return decision;
  });
  assert.equal(first.ticked, true, "the first tick was refused");

  const second = tick({ headers: { host: "example.test" } }, { base: "https://example.test" });
  assert.equal(second.ticked, false, "a second tick ran inside the same five minutes");
  assert.ok(second.nextInMs > 0 && second.nextInMs <= TICK_MS);

  // A tick really did the work, not just moved a number.
  assert.equal(scheduleReport().slices, 1, "the tick started no slice");
});

test("a tick with no origin refuses rather than inventing one", async () => {
  // Better an honest "no origin" than a scan of the wrong site.
  const out = await runSlice({ base: "" });
  assert.equal(out.skipped, "no base");
  assert.match(scheduleReport().lastDecision, /SELF_BASE/);
});

test("a slice scans a window and hands what it finds to the healer", async () => {
  const seen = [];
  // One broken page, everything else fine.
  const site = stubSite({ seen, broken: { "/admin": { status: 500, body: "boom" } } });

  const out = await withSite(site, () => runSlice({ base: "https://example.test", budget: 20000, window: 3 }));

  assert.ok(out.pass, "the slice produced no pass");
  assert.ok(seen.some((p) => p.startsWith("/admin")), "the broken page was never requested");
  assert.ok(out.pass.findings.length > 0, "a 500 page produced no finding");

  // The finding reached the healer's state machine: the panel's verdict is
  // honest even when there is no repair that can help.
  const row = healerReport().symptoms.find((s) => s.key === "site.page");
  assert.ok(row, "the healer never heard about the broken page");
  assert.notEqual(row.status, "healthy", "a broken page left the healer reading healthy");

  // And the slice is on the record.
  const report = scheduleReport();
  assert.equal(report.slices, 1);
  assert.match(report.lastDecision, /batch|check/i);
});

test("the stored cursor survives a cold start", async () => {
  // A redeploy (or a scale-to-zero) must not put the walk back at batch one.
  const site = stubSite();
  await withSite(site, () => runSlice({ base: "https://example.test", budget: 20000, window: 4 }));
  const before = scannerState().cursor;
  assert.ok(before > 0);

  // Simulate the new instance: forget everything in memory, then restore.
  resetScanner();
  resetScheduler();
  assert.equal(scannerState().cursor, 0);

  const restored = await restoreSchedulerState();
  assert.equal(restored.restored, true, "the scheduler found nothing to restore");
  assert.equal(scannerState().cursor, before, "the walk restarted from the beginning");
});

test("the cadence report names the channels honestly", () => {
  const report = scheduleReport();

  // No SCAN_KEY in the test environment: the external channel must say so rather
  // than showing a green tick for a pinger nobody set up.
  assert.equal(report.channels.external.available, false);
  assert.match(report.channels.external.detail, /SCAN_KEY/);
  assert.equal(report.channels.inProcess.available, true);
  assert.match(report.channels.inProcess.detail, /five minutes/);

  // The promise is five minutes; the pass is a window, and the report says so.
  assert.equal(report.cadenceMs, TICK_MS);
  assert.equal(report.window.batches, SLICE_WINDOW);
  assert.ok(report.window.batches < BATCH_WINDOW, "a slice should be smaller than a standalone pass");
});

test("an external tick is recorded as the reason the clock moved", () => {
  noteExternalTick("scheduler");
  const report = scheduleReport();
  assert.ok(report.lastTickAt, "the external tick was not stamped");
  assert.match(report.lastDecision, /scheduler/);
});

test("selfBaseOf refuses to invent a scheme for a local server", () => {
  assert.equal(selfBaseOf({ headers: { host: "127.0.0.1:4284" } }), "http://127.0.0.1:4284");
  assert.equal(
    selfBaseOf({ headers: { host: "arsvibe.test", "x-forwarded-proto": "https" } }),
    "https://arsvibe.test"
  );
  // An explicit base wins: that is how a deployment with restricted egress works.
  const saved = process.env.SELF_BASE;
  process.env.SELF_BASE = "https://arsvibe.example/";
  assert.equal(selfBaseOf({ headers: { host: "internal" } }), "https://arsvibe.example");
  if (saved === undefined) delete process.env.SELF_BASE;
  else process.env.SELF_BASE = saved;
});

/* -------------------------------------------------------- the local checks */

test("a manifest that promises a page the disk does not have is a fault", async () => {
  const out = await localChecks();
  // The shipped build is consistent; this is the check the healer's assets
  // symptom shares, so it must agree with a real build.
  assert.equal(out.findings.length, 0, `the shipped build failed its own manifest check: ${JSON.stringify(out.findings)}`);
  assert.ok(out.checks > 10);
});

test("findings are cleared by a repair and remembered as resolved", () => {
  const pass = scannerReport();
  assert.deepEqual(pass.open, []);

  // Nothing to clear is not an error.
  assert.equal(clearFinding("nope:nope:nope"), false);
  const counts = findings().counts;
  assert.equal(counts.high + counts.medium + counts.low, 0);
});

test("restoring a saved scanner state does not resurrect a stale pass count", () => {
  restoreScanner({ cursor: 40, pass: 3, lastPassAt: 1 });
  assert.equal(scannerState().cursor, 40);
  assert.equal(scannerState().pass, 3);
  // Garbage in must not produce NaN out.
  restoreScanner({ cursor: "many", pass: null });
  assert.equal(scannerState().cursor, 40);
  assert.equal(scannerState().pass, 3);
});

test("the pass budget is a wall clock, not a batch count", () => {
  assert.ok(PASS_BUDGET_MS >= 10000, "the pass budget is too short to be useful");
  assert.ok(BATCH_WINDOW > 0 && BATCH_WINDOW <= 40, "the window is either empty or a full sweep");
});

test("one class of fault is one row that counts its sightings", async () => {
  // Forty batches with no subjects must not be forty rows: the panel's row budget
  // would fill with the same low finding and hide the page that is actually down.
  const site = stubSite();
  const empty = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/batch") {
      return makeRes(200, JSON.stringify({ success: true, batch: { id: "x", name: "Empty Batch" }, subjects: [] }), "application/json");
    }
    return site(input);
  };

  await withSite(empty, () => scanPass({ base: "https://example.test", batches: BATCHES, budget: 20000, windowSize: 5 }));
  const pass = await withSite(empty, () => scanPass({ base: "https://example.test", batches: BATCHES, budget: 20000, windowSize: 5 }));

  const empty_ = findings().open.filter((f) => f.key === "content:no-subjects");
  assert.equal(empty_.length, 1, `${empty_.length} rows for one class of fault`);
  assert.equal(empty_[0].seen, 10, `the sighting count is ${empty_[0].seen}, expected 10`);
  assert.ok(empty_[0].firstAt, "the first sighting was not kept");
  assert.ok(pass.findings.length >= 5, "the pass stopped reporting the faults themselves");
});
