/**
 * The browser-report route, end to end.
 *
 * `/api/client-error` is the only route in the project that accepts input from a
 * page rather than from an operator or an upstream, so it gets its own harness
 * with its own server. Two reasons not to bolt it onto `admin.test.mjs`:
 *
 *   · That file signs in repeatedly, and sign-in is rate limited by design — a
 *     test that runs after a dozen others inherits a 429 and fails for a reason
 *     that has nothing to do with what it asserts.
 *   · This route must be provably *unauthenticated*. Sharing a harness with the
 *     session tests would make it far too easy to write a test that passes
 *     because a cookie leaked into it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4294;
const FIXPORT = 4295;
const BASE = `http://127.0.0.1:${PORT}`;

const TEST_USER = "client-report-user";
const TEST_PASS = "client-report-pass";

const children = [];

function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function waitFor(url, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

before(async () => {
  start(["scripts/fixture-upstream.mjs"], { FIXTURE_PORT: String(FIXPORT) });
  await waitFor(`http://127.0.0.1:${FIXPORT}/AllBatches?page=1`);
  start(["scripts/dev.mjs"], {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PW_UPSTREAM_BASE: `http://127.0.0.1:${FIXPORT}`,
    ADMIN_USERNAME: TEST_USER,
    ADMIN_PASSWORD: TEST_PASS,
  });
  await waitFor(`${BASE}/admin.html`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

const report = (faults, page = "/batches") =>
  fetch(`${BASE}/api/client-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page, build: "test-build", faults }),
  });

/* ------------------------------------------------------------- the route */

test("a browser's fault report is accepted without any session", async () => {
  const res = await report([
    {
      kind: "error",
      message: "Cannot read properties of undefined (reading 'map')",
      source: "/assets/batches.js",
      count: 3,
      fingerprint: "e2e-1",
    },
  ]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.accepted >= 1, "the fault was not counted");
});

test("the receipt says nothing about other visitors' faults", async () => {
  await report([{ kind: "error", message: "private detail", source: "/assets/x.js", fingerprint: "e2e-private" }]);
  const res = await report([{ kind: "error", message: "mine", fingerprint: "e2e-mine" }]);
  const body = await res.json();
  const dump = JSON.stringify(body);

  // An anonymous write endpoint that echoes what it has stored is a readable log
  // of everyone else's broken pages.
  assert.equal(dump.includes("private detail"), false, "another visitor's fault was echoed back");
  assert.equal("faults" in body, false);
  assert.equal("open" in body, false);
  assert.equal("pages" in body, false);
});

test("a GET is refused rather than quietly accepted", async () => {
  const res = await fetch(`${BASE}/api/client-error`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST, OPTIONS");
});

test("a preflight is answered without touching the log", async () => {
  const res = await fetch(`${BASE}/api/client-error`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

test("a body that cannot be read is not an error the page has to handle", async () => {
  // The caller is a page that is already broken. A 400 would add a second failed
  // request to a console that is already the problem.
  const res = await fetch(`${BASE}/api/client-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.ok(res.status === 204 || res.status === 200, `unexpected ${res.status}`);
});

test("the route is not cacheable", async () => {
  const res = await fetch(`${BASE}/api/client-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ faults: [] }),
  });
  assert.match(String(res.headers.get("cache-control")), /no-store/);
});

/* ----------------------------------------------------------- what the panel sees */

test("the panel is told what the browsers saw, and where", async () => {
  await report(
    [
      { kind: "error", message: "the catalogue grid failed to render", source: "/assets/app.js", count: 6, fingerprint: "e2e-grid" },
      { kind: "rejection", message: "fetch failed", source: "/assets/data.js", count: 2, fingerprint: "e2e-fetch" },
    ],
    "/batches"
  );

  const login = await fetch(`${BASE}/api/admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();

  const res = await fetch(`${BASE}/api/admin?action=stats`, { headers: { "x-admin-token": token } });
  assert.equal(res.status, 200);
  const stats = await res.json();

  assert.ok(stats.browser, "the stats route must carry the browser's report");
  assert.ok(stats.browser.counts.recentDistinct >= 2);
  assert.ok(
    stats.browser.pages.some((p) => p.page === "/batches"),
    "the panel has to be able to say *which* page is broken"
  );
  assert.equal(stats.browser.verdict.level, "bad", "six occurrences on one page is a broken page");

  // The healer now has a probe that fails on exactly this evidence, and a symptom
  // with a bounded repair ladder behind it.
  const probe = (stats.heal.probes || []).find((p) => p.id === "client-errors");
  assert.ok(probe, "the healer must expose the browser-fault probe");
  assert.equal(probe.skipped, false, "a skipped probe reads as healthy and hides the fault");
  assert.equal(probe.ok, false, "the probe is passing while pages are throwing");
  assert.equal(probe.which, "client.errors");

  const symptom = (stats.heal.symptoms || []).find((s) => s.key === "client.errors");
  assert.ok(symptom, "the browser fault must appear as a known symptom");
  assert.notEqual(symptom.status, "healthy", "a failing probe left its symptom healthy");
  assert.equal(symptom.repair, "client.recover", "a symptom with no repair cannot climb");
  assert.ok(symptom.rungs >= 2, "the repair ladder must have rungs to climb");
});

test("a clean site reports a healthy browser probe", async () => {
  // The healer's other probe covers "no faults at all": this asserts the assertion
  // is falsifiable, so a probe that is hard-wired to fail cannot pass the above.
  const { clientFaults, clientFaultVerdict, resetClientFaults } = await import("../lib/client-errors.mjs");
  resetClientFaults();
  assert.equal(clientFaultVerdict(clientFaults()).level, "ok");
  const healer = await import("../lib/healer.mjs");
  healer.registerHealerDependencies({ client: () => clientFaults() });
  const probe = healer.PROBES.find((p) => p.id === "client-errors");
  const reading = await probe.run();
  assert.equal(reading.ok, true, "an empty log must read healthy");
  assert.equal(reading.skipped, undefined, "an empty log is a reading, not a skip");
});

/* --------------------------------------------------- every page carries it */

test("every shipped page loads the telemetry module", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const PUBLIC = path.join(ROOT, "public");
  const pages = (await readdir(PUBLIC)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 18, `only ${pages.length} pages found`);

  for (const page of pages) {
    const html = await readFile(path.join(PUBLIC, page), "utf8");
    assert.match(
      html,
      /<script type="module" src="\/assets\/telemetry\.js"><\/script>/,
      `${page} does not load the browser telemetry module`
    );
  }
});

test("the telemetry module is served as a real module, not 404", async () => {
  const res = await fetch(`${BASE}/assets/telemetry.js`);
  assert.equal(res.status, 200, "the module a page loads must exist");
  const text = await res.text();
  assert.match(text, /unhandledrejection/, "the shipped module must actually listen");
  assert.match(text, /sendBeacon|keepalive/, "it must be able to send a report");
});

/**
 * A `Blob` that keeps its parts.
 *
 * The module posts a Blob to `sendBeacon`, and a Blob from jsdom's realm cannot be
 * read from this process's realm. Substituting the constructor is not a cheat: the
 * thing under test is *which events the listeners catch and what they put in the
 * body*, not the Blob specification, which the browser owns.
 */
function capturingBlob() {
  return class TestBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = (options && options.type) || "";
    }
    text() {
      return Promise.resolve(this.parts.join(""));
    }
  };
}

/* -------------------------------------------- the listeners, in a real DOM */

/*
 * Everything above tests the *logic*. This tests the wiring, in a DOM that
 * dispatches the events a browser actually dispatches — because the failure a
 * wiring bug produces is the one this whole round exists to fix: nothing happens,
 * and nothing anywhere says so.
 *
 * jsdom does not execute module scripts, so the module body is evaluated in the
 * window's own realm with its `export` keywords stripped. That keeps `window`,
 * `document` and `navigator` genuine, which is the entire point: a test that
 * substitutes them would prove nothing about what ships.
 */
test("a thrown exception, a rejected promise and a dead module all reach the server", async () => {
  const { JSDOM } = await import("jsdom");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(ROOT, "public/assets/telemetry.js"), "utf8");

  const dom = new JSDOM(`<!doctype html><html><head><meta name="build" content="sim-1"></head><body></body></html>`, {
    url: `${BASE}/batches`,
    runScripts: "outside-only",
  });
  const { window } = dom;

  const sent = [];
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: (url, body) => {
      sent.push({ url, body });
      return true;
    },
    configurable: true,
  });
  window.Blob = capturingBlob();

  window.eval(source.replace(/^export /gm, ""));

  // 1. An uncaught exception, as a page raises it.
  const err = new window.Error("Cannot read properties of undefined (reading 'map')");
  window.dispatchEvent(
    new window.ErrorEvent("error", {
      message: err.message,
      filename: `${BASE}/assets/batches.js`,
      lineno: 88,
      colno: 12,
      error: err,
    })
  );

  // 2. An unhandled rejection. jsdom has no `PromiseRejectionEvent` constructor, so
  // the event is built by hand — the module reads only `reason`, which is the one
  // property a browser guarantees.
  const rejection = new window.Event("unhandledrejection");
  rejection.reason = new window.Error("the catalogue request failed");
  window.dispatchEvent(rejection);

  // 3. A module that failed to load: `error` on the element, capture phase only,
  // because a resource error does not bubble.
  const dead = window.document.createElement("script");
  dead.src = `${BASE}/assets/does-not-exist.js`;
  window.document.body.appendChild(dead);
  dead.dispatchEvent(new window.Event("error"));

  // The module batches for 1.2s; give it that, then read what it sent.
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(sent.length, 1, `expected one batched beacon, got ${sent.length}`);
  assert.equal(sent[0].url, "/api/client-error");

  const text = await sent[0].body.text();
  const payload = JSON.parse(text);
  const messages = payload.faults.map((f) => f.message).join(" | ");

  assert.match(messages, /Cannot read properties of undefined/);
  assert.match(messages, /catalogue request failed/);
  assert.match(messages, /failed to load/);
  assert.equal(payload.page, "/batches", "the report must name the page it happened on");
  assert.equal(payload.build, "sim-1", "the report must be tieable to a deploy");

  // The dead module is identified by path, which is what turns "something broke"
  // into "this file is not on the server".
  const resource = payload.faults.find((f) => f.kind === "resource");
  assert.ok(resource, "the failed module was not reported");
  assert.match(resource.source, /does-not-exist\.js/);

  dom.window.close();
});

test("a page that throws a hundred times still sends one beacon", async () => {
  const { JSDOM } = await import("jsdom");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(ROOT, "public/assets/telemetry.js"), "utf8");

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `${BASE}/batches`,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const sent = [];
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: (url, body) => {
      sent.push(body);
      return true;
    },
    configurable: true,
  });
  window.Blob = capturingBlob();
  window.eval(source.replace(/^export /gm, ""));

  for (let i = 0; i < 100; i += 1) {
    window.dispatchEvent(
      new window.ErrorEvent("error", {
        message: "the same failure every time",
        filename: `${BASE}/assets/batches.js`,
        lineno: 88,
        colno: 12,
        error: new window.Error("the same failure every time"),
      })
    );
  }

  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(sent.length, 1, "a throw loop must not become a request flood");
  const payload = JSON.parse(await sent[0].text());
  assert.equal(payload.faults.length, 1, "one bug is one bucket");
  assert.equal(payload.faults[0].count, 50, "the count is capped, the bucket is not");
  dom.window.close();
});

/* -------------------------------------------------- the panel paints it */

test("the panel shows the faults, the pages and an honest empty state", async () => {
  const { JSDOM } = await import("jsdom");
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(path.join(ROOT, "public/admin.html"), "utf8");
  const dom = new JSDOM(html, { url: `${BASE}/admin.html`, pretendToBeVisual: true });
  const { window } = dom;

  // The panel module wants a few browser globals the admin page provides; only the
  // renderer matters here, so the rest is stubbed to the minimum it touches.
  // The panel starts a poll interval on boot, and an interval that outlives the
  // test keeps Node alive for ever — the whole file would pass and then hang.
  const timers = new Set();
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...rest) => {
    const handle = realSetInterval(fn, ms, ...rest);
    timers.add(handle);
    return handle;
  };

  // The panel imports site-absolute paths; the loader shim maps them onto public/.
  const { register } = await import("node:module");
  register("./loader.mjs", import.meta.url);

  window.sessionStorage.setItem("arsvibe.admin.token", "test-token");
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.sessionStorage = window.sessionStorage;

  // A payload shaped exactly like `/api/admin?action=stats` returns.
  const client = {
    at: new Date().toISOString(),
    open: [],
    recent: [
      { fingerprint: "a", kind: "error", message: "the catalogue grid failed to render", page: "/batches", count: 6 },
      { fingerprint: "b", kind: "rejection", message: "fetch failed", page: "/viewer", count: 2 },
    ],
    counts: { distinct: 2, recentDistinct: 2, recentOccurrences: 8, occurrences: 8, reports: 3, rejected: 0 },
    pages: [{ page: "/batches", count: 6 }],
    recentMs: 900000,
    verdict: { level: "bad", page: "/batches", summary: "2 distinct script error(s), 8 in the last 15 minutes — worst on /batches" },
  };

  // The panel boots through `whoami` before it renders anything, and `render()`
  // paints *every* section, so the sample has to be a complete stats payload. A
  // thin one throws halfway through and this test would then be asserting on a
  // page that never rendered — which is precisely the bug that used to be silent.
  const sample = {
    success: true,
    ok: true,
    generatedAt: new Date().toISOString(),
    uptimeSeconds: 120,
    health: [{ kind: "index", name: "catalogue-index", ok: true, ms: 4, count: 14201, detail: "" }],
    traffic: {
      requests: 10,
      apiRequests: 8,
      pages: 2,
      bytesOut: 1000,
      errors: 0,
      errorRate: 0,
      byStatus: { 200: 10 },
      byRoute: { admin: 10 },
      byPage: { "site-home": 2 },
      series: [1, 2, 3],
      slowest: [],
      lastErrors: [],
      liveSessions: 1,
    },
    token: { source: "relay", cached: true, expiresIn: 300, prefix: "eyJ…", usable: true },
    credentials: [],
    release: { commit: "", commitShort: "", ref: "test", env: "test", region: "local", node: "v22", deployment: "" },
    runtime: { memoryMb: 100, heapMb: 20, pid: 1 },
    catalogue: { batches: 14201, source: "test" },
    trafficNote: "",
    client: { ip: "127.0.0.1", ua: "node" },
    browser: client,
    heal: { probes: [], symptoms: [], counts: {} },
    scan: null,
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.includes("action=whoami") ? { success: true, signedIn: true } : sample;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  await import(`/assets/admin.js?v=client-panel-${Date.now()}`);

  const until = async (check, what, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  await until(
    () => /catalogue grid failed to render/.test(window.document.getElementById("clientFaults").textContent || ""),
    "the fault list to paint"
  );

  const faults = window.document.getElementById("clientFaults").textContent;
  assert.match(faults, /catalogue grid failed to render/);
  assert.match(faults, /6×/, "the count has to be visible or the list is unreadable");
  assert.match(faults, /\/batches/);

  const pages = window.document.getElementById("clientPages").textContent;
  assert.match(pages, /\/batches/, "the panel must say which page is broken");

  const kv = window.document.getElementById("clientKv").textContent;
  assert.match(kv, /pages themselves/, "the instrument must be named, not implied");
  assert.match(kv, /15 minutes/, "the window must be stated");

  // And a quiet instance says so rather than rendering an empty box.
  const quiet = {
    at: new Date().toISOString(),
    open: [],
    recent: [],
    counts: { distinct: 0, recentDistinct: 0, recentOccurrences: 0, occurrences: 0, reports: 0, rejected: 0 },
    pages: [],
    recentMs: 900000,
    verdict: { level: "ok", page: "", summary: "no script errors reported" },
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.includes("action=whoami")
      ? { success: true, signedIn: true }
      : { ...sample, browser: quiet };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  await import(`/assets/admin.js?v=client-panel-empty-${Date.now()}`);
  await until(
    () => /No page has reported a script error/.test(window.document.getElementById("clientFaults").textContent || ""),
    "the empty state to paint"
  );

  for (const handle of timers) clearInterval(handle);
  globalThis.setInterval = realSetInterval;
  dom.window.close();
});
