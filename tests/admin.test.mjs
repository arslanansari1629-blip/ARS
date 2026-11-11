/**
 * Admin panel — behaviour tests.
 *
 * These run against the dev server (fixture upstream) and assert the things that
 * would be dangerous if they broke: the credentials never appear in anything a
 * browser can download, a wrong password cannot get in, and the stats route
 * refuses anonymous callers.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = 4284;
const FIXPORT = 4285;
const BASE = `http://127.0.0.1:${PORT}`;

const children = [];

/**
 * The real `fetch`, captured at load time.
 *
 * Several tests replace `globalThis.fetch` with a stub to drive the panel against
 * a fixed `sample` payload. Being module-level, that stub outlives the test that
 * installed it — so a later test that needs the real server must not read
 * `globalThis.fetch` and hope.
 */
const REAL_FETCH = globalThis.fetch.bind(globalThis);

/**
 * The credentials never appear in this repository, not even in a test: the
 * source is public, so a fixture would publish them. Assertions that need a
 * *known* pair use throwaway values exported into the dev server's environment;
 * the shipped digests are still compared by lib/admin.mjs itself.
 */
const TEST_USER = "operator-test";
const TEST_PASS = "operator-test-pass";
const TEST_ENV = { ADMIN_USERNAME: TEST_USER, ADMIN_PASSWORD: TEST_PASS };

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
      /* retry */
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
    ...TEST_ENV,
  });
  await waitFor(`${BASE}/admin.html`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

const signIn = async (username = TEST_USER, password = TEST_PASS) => {
  const res = await fetch(`${BASE}/api/admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json() };
};

test("the admin page is a standalone, noindex sign-in gate", async () => {
  const html = await (await fetch(`${BASE}/admin.html`)).text();

  // It must not be reachable from the public chrome, and must not be indexed.
  assert.match(html, /name="robots" content="noindex, nofollow"/i);
  assert.match(html, /id="loginForm"/);
  assert.match(html, /id="adminPass"[^>]*type="password"/);
  assert.match(html, /id="adminUser"/);
  // Deliberately not the site shell: no nav, no sidebar, no session chip.
  assert.equal(/id="navLinks"/.test(html), false, "the admin page inherited the site nav");
  assert.equal(/shell\.mjs/.test(html), false, "the admin page loads the site shell");

  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/admin/);
});

test("the credentials are not shipped to the browser", async () => {
  // Walk everything a visitor can download and make sure neither the username
  // nor the password text appears anywhere.
  const secrets = [TEST_PASS];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "vendor") continue;
        await walk(full);
        continue;
      }
      if (!/\.(html|js|mjs|css|json|txt|svg)$/.test(entry.name)) continue;
      const text = await readFile(full, "utf8");
      for (const secret of secrets) {
        assert.equal(
          text.includes(secret),
          false,
          `${path.relative(ROOT, full)} contains the admin password`
        );
      }
    }
  }
  await walk(PUBLIC);

  // The admin page itself, as served, must not contain them either.
  const page = await (await fetch(`${BASE}/admin.html`)).text();
  for (const secret of secrets) assert.equal(page.includes(secret), false);

  // The username is only allowed to exist server-side, as a digest.
  const client = await (await fetch(`${BASE}/assets/admin.js`)).text();
  assert.equal(client.includes(TEST_USER), false, "the admin username leaked into the client");
  // This repository is public, so the module that holds the digests must not
  // hold the words either — a plaintext assignment here would publish them.
  const server = await readFile(path.join(ROOT, "lib", "admin.mjs"), "utf8");
  assert.equal(
    /const\s+(USERNAME|PASSWORD)\s*=\s*["']/.test(server),
    false,
    "lib/admin.mjs stores a credential in plaintext"
  );
  assert.equal(
    /PASSWORD|password\s*=\s*["']/.test(client),
    false,
    "the client appears to hold a credential"
  );

  // And the API must never echo a secret back, even on a failed sign-in.
  const { body } = await signIn("nobody", "nothing");
  assert.equal(JSON.stringify(body).includes(TEST_PASS), false);
});

test("a wrong password is refused and rate limited, the right one gets a session", async () => {
  const wrong = await signIn(TEST_USER, "not-the-password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.success, false);
  // One message for both fields: never confirm which half was right.
  assert.match(wrong.body.error, /Invalid username or password/i);

  const wrongUser = await signIn("someone-else", TEST_PASS);
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongUser.body.error, wrong.body.error, "the error revealed which field was wrong");

  const ok = await signIn();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);
  assert.ok(ok.body.token && ok.body.token.length > 20, "no session token was issued");
  assert.ok(ok.body.idleMinutes >= 5, "the session has no idle timeout");
});

test("stats require a session and describe the site's real state", async () => {
  const anon = await fetch(`${BASE}/api/admin?action=stats`);
  assert.equal(anon.status, 401, "live stats answered without a session");

  const { body: auth } = await signIn();
  const res = await fetch(`${BASE}/api/admin?action=stats`, {
    headers: { "x-admin-token": auth.token },
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.health) && data.health.length >= 3, "no health checks ran");

  // The catalogue check must be real: it reported 14,201 batches before this
  // route existed, so it is comparable.
  const index = data.health.find((h) => h.name === "catalogue-index");
  assert.ok(index && index.ok, "the catalogue probe is not passing");
  assert.ok(index.count > 1000, `catalogue probe saw only ${index.count} batches`);

  // Traffic is counted from real requests, not invented.
  assert.ok(data.traffic.requests > 0, "traffic was not counted");
  assert.ok(Array.isArray(data.traffic.series) && data.traffic.series.length > 1);
  assert.ok(data.release && typeof data.release.node === "string");
  assert.ok(data.runtime && data.runtime.memoryMb > 0);

  // The self-healing ledger is part of the operator's picture: it is the only
  // place the site admits it repairs itself.
  assert.ok(data.selfHeal, "the panel has no self-healing section");
  assert.ok(Array.isArray(data.selfHeal.repairs), "the repair ledger is missing");
  assert.ok(Array.isArray(data.selfHeal.signers), "the signer ladder is missing");
  assert.ok(data.selfHeal.budget.cap > 0, "the repair budget is not described");

  // The token is summarised, never dumped.
  assert.ok(data.token && typeof data.token.usable === "boolean");
  const dump = JSON.stringify(data);
  assert.equal(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.e30\.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M/.test(dump), false,
    "the upstream token was echoed in full");

  // Signing out invalidates it.
  await fetch(`${BASE}/api/admin?action=logout`, {
    method: "POST",
    headers: { "x-admin-token": auth.token },
  });
  const after = await fetch(`${BASE}/api/admin?action=stats`, {
    headers: { "x-admin-token": auth.token },
  });
  assert.equal(after.status, 401, "the session survived sign-out");
});

test("the healer answers only to a session, and a GET never repairs", async () => {
  const anon = await fetch(`${BASE}/api/admin?action=heal`);
  assert.equal(anon.status, 401, "the healer's state answered without a session");

  const { body: auth } = await signIn();

  // A read is a read: it probes, it reports, and it changes nothing.
  const read = await fetch(`${BASE}/api/admin?action=heal`, {
    headers: { "x-admin-token": auth.token },
  });
  assert.equal(read.status, 200);
  const seen = await read.json();
  assert.equal(seen.success, true);
  assert.ok(seen.heal, "the healer returned no report");
  assert.equal(seen.heal.applied, false, "a GET applied a repair");
  assert.deepEqual(seen.heal.actions, [], "a GET ran repairs");

  // The report has to be drawable: probes with readings, a lifecycle, a budget.
  assert.ok(Array.isArray(seen.heal.probes) && seen.heal.probes.length >= 4, "too few probes");
  const catalog = seen.heal.probes.find((p) => p.id === "catalog-index");
  assert.ok(catalog && catalog.ok, "the catalogue probe is not passing");
  assert.ok(catalog.value > 1000, `catalogue probe saw ${catalog.value} batches`);
  assert.deepEqual(seen.heal.lifecycle, [
    "healthy",
    "degraded",
    "repairing",
    "repaired",
    "escalated",
    "failed",
  ]);
  assert.ok(seen.heal.budget.cap > 0, "the repair budget is not described");
  assert.equal(typeof seen.heal.verdict, "string");

  // Nothing in the report may leak a token or a credential.
  const dump = JSON.stringify(seen);
  assert.equal(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.e30\./.test(dump), false, "a token was echoed");
  assert.equal(dump.includes(TEST_PASS), false);

  // The panel's own stats poll carries the healer too, so one refresh paints both.
  const stats = await (await fetch(`${BASE}/api/admin?action=stats`, {
    headers: { "x-admin-token": auth.token },
  })).json();
  assert.ok(stats.heal, "the stats poll does not carry the healer");
  assert.ok(Array.isArray(stats.heal.probes));
});

test("a sweep is a POST, is bounded, and reports what it did", async () => {
  const { body: auth } = await signIn();
  const res = await fetch(`${BASE}/api/admin?action=heal&sweep=1`, {
    method: "POST",
    headers: { "x-admin-token": auth.token },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.heal.swept, true);
  assert.equal(data.heal.applied ?? true, true, "a sweep did not apply its repairs");
  assert.ok(Array.isArray(data.heal.actions), "the sweep reported no actions");
  // A healthy fixture has nothing to repair — and must not invent work.
  assert.equal(
    data.heal.actions.filter((a) => a.ran).length,
    0,
    "a healthy system repaired something"
  );
  // Every action it *would* take is described, even the ones it did not take.
  assert.ok(Object.keys(data.heal.repairs).length >= 4, "the repair catalogue is missing");

  // An unknown symptom is refused rather than silently ignored.
  const bad = await fetch(`${BASE}/api/admin?action=heal&symptom=not-a-fault`, {
    method: "POST",
    headers: { "x-admin-token": auth.token },
  });
  const refused = await bad.json();
  assert.equal(refused.success, false, "an unknown symptom was accepted");
});

test("the panel renders its gate and its blocks from the shipped module", async () => {
  const js = await (await fetch(`${BASE}/assets/admin.js`)).text();

  // The sign-in flow talks to the same-origin route only.
  assert.match(js, /fetch\("\/api\/admin"/);
  assert.match(js, /x-admin-token/);
  // It must not keep the password anywhere after signing in.
  assert.equal(/localStorage\.setItem\([^)]*password/i.test(js), false);
  assert.equal(/sessionStorage\.setItem\(TOKEN_KEY/.test(js), true);

  const html = await (await fetch(`${BASE}/admin.html`)).text();
  for (const hook of [
    "healthList",
    "spark",
    "routeBars",
    "logList",
    "releaseKv",
    "runtimeKv",
    "heroStats",
    "refreshBtn",
    "signOutBtn",
    "auditBlock",
    "auditForm",
    "auditBatch",
    "auditTotals",
    "auditRows",
    "auditStamp",
    "auditLegend",
    "dppBlock",
    "dppForm",
    "dppBatch",
    "dppSubject",
    "dppList",
    "dppPaper",
    "dppPager",
    "dppPapers",
    "dppPapersLoad",
    "dppTestBlock",
    "dppTestQuestions",
    "dppTestClock",
  ]) {
    assert.ok(html.includes(`id="${hook}"`), `the panel is missing #${hook}`);
  }
});

test("the audit surface requires a session and refuses nonsense politely", async () => {
  // An anonymous caller must not be able to make the server sweep a batch: the
  // audit is hundreds of upstream reads and a free denial-of-service otherwise.
  const anonGet = await fetch(`${BASE}/api/admin?action=audit`);
  assert.equal(anonGet.status, 401, "the last audit is readable without a session");

  const anonPost = await fetch(`${BASE}/api/admin?action=audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batch: "698ad3519549b300a5e1cc6a", limit: 2 }),
  });
  assert.equal(anonPost.status, 401, "an anonymous caller started a sweep");

  const anonRescan = await fetch(`${BASE}/api/admin?action=rescan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batch: "b", subject: "s", id: "l" }),
  });
  assert.equal(anonRescan.status, 401, "an anonymous caller re-checked a lecture");

  const { body: auth } = await signIn();

  // Nothing has run yet on a cold server, and the panel is told so rather than
  // being handed a half-built report.
  const first = await fetch(`${BASE}/api/admin?action=audit`, {
    headers: { "x-admin-token": auth.token },
  });
  assert.equal(first.status, 200);
  const state = await first.json();
  assert.equal(state.success, true);
  assert.equal(typeof state.running, "boolean", "the panel cannot tell whether a sweep is live");

  // A sweep with no batch is a mistake, not a crash.
  const noBatch = await fetch(`${BASE}/api/admin?action=audit`, {
    method: "POST",
    headers: { "x-admin-token": auth.token, "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 3 }),
  });
  assert.equal(noBatch.status, 400, "a sweep ran without a batch id");

  // The limit is clamped, not trusted: an unbounded value would walk the whole
  // catalogue inside a 50 s function.
  const huge = await fetch(`${BASE}/api/admin?action=audit`, {
    method: "POST",
    headers: { "x-admin-token": auth.token, "Content-Type": "application/json" },
    body: JSON.stringify({ batch: "does-not-exist", limit: 999999 }),
  });
  assert.equal(huge.status, 200);
  const hugeBody = await huge.json();
  assert.equal(hugeBody.success, true);
  assert.ok(hugeBody.audit, "the sweep returned no report");
  assert.ok(hugeBody.audit.totals.lectures <= 200, `the limit was not clamped: ${hugeBody.audit.totals.lectures}`);
  // An unknown batch is reported as an empty sweep, not as a site outage.
  assert.ok(Array.isArray(hugeBody.audit.notes), "the report has no notes channel");

  await fetch(`${BASE}/api/admin?action=logout`, {
    method: "POST",
    headers: { "x-admin-token": auth.token },
  });
});

test("the DPP panel lists papers behind a session and explains a locked one", async () => {
  const { body: auth } = await signIn();
  const headers = { "x-admin-token": auth.token };

  // Anonymous callers get nothing: the DPP routes are operator surface too.
  for (const action of ["dpp", "dpp-paper"]) {
    const anon = await fetch(`${BASE}/api/admin?action=${action}&batch=b&subject=s&id=t`);
    assert.equal(anon.status, 401, `${action} answered without a session`);
  }

  // Missing inputs are a 400 with a sentence, not a 500.
  const noBatch = await fetch(`${BASE}/api/admin?action=dpp`, { headers });
  assert.equal(noBatch.status, 400);
  assert.match((await noBatch.json()).error, /batch and subject/i);

  // A real subject of the fixture batch, by its batch-subject id.
  const batch = await (await fetch(`${BASE}/api/batch?id=6a6b461cce4ac4e9ab51ee98`)).json();
  const subject = (batch.subjects || [])[0];
  assert.ok(subject, "the fixture batch has no subjects to ask about");

  const list = await fetch(
    `${BASE}/api/admin?action=dpp&batch=6a6b461cce4ac4e9ab51ee98&subject=${encodeURIComponent(subject.id)}`,
    { headers }
  );
  assert.equal(list.status, 200, "the DPP list route is not mounted");
  const body = await list.json();
  assert.equal(body.success, true, body.error);
  assert.ok(Array.isArray(body.items) && body.items.length > 0, "no papers came back");
  // The row shape is nested; a reader that stops a level up returns blank names.
  assert.match(body.items[0].name, /DPP/, "the paper name was not mapped");
  assert.ok(body.items[0].questions > 0, "the question count was not mapped");
  assert.ok(body.items[0].id, "the paper has no id to open");
  assert.match(body.headline, /papers?/, "the list has no headline");
  assert.ok(body.total >= body.items.length, "the total count was lost");

  // A slug resolves to the subject instead of silently returning nothing.
  const bySlug = await fetch(
    `${BASE}/api/admin?action=dpp&batch=6a6b461cce4ac4e9ab51ee98&subject=${encodeURIComponent(subject.slug)}`,
    { headers }
  );
  assert.equal(bySlug.status, 200);
  assert.ok((await bySlug.json()).items.length > 0, "a subject slug returned no papers");

  // A subject that is not in the batch is named as such.
  const wrong = await fetch(
    `${BASE}/api/admin?action=dpp&batch=6a6b461cce4ac4e9ab51ee98&subject=not-a-subject-slug`,
    { headers }
  );
  assert.equal(wrong.status, 404);
  assert.match((await wrong.json()).error, /not part of this batch/i);

  // The paper itself: the fixture answers 401 like PW does, and the panel must
  // be told "locked", not "broken".
  const paper = await fetch(`${BASE}/api/admin?action=dpp-paper&id=${encodeURIComponent(body.items[0].id)}`, {
    headers,
  });
  assert.equal(paper.status, 200);
  const paperBody = await paper.json();
  assert.equal(paperBody.locked, true, "an unreadable paper was not reported as locked");
  assert.match(paperBody.error, /paid student session/i);
  assert.equal(paperBody.questions.length, 0);

  // No id at all is the caller's mistake.
  const noId = await fetch(`${BASE}/api/admin?action=dpp-paper`, { headers });
  assert.equal(noId.status, 400);

  await fetch(`${BASE}/api/admin?action=logout`, {
    method: "POST",
    headers,
  });
});

test("the DPP paper proxy reads a real PDF and returns a runnable test", async () => {
  const { body: auth } = await signIn();
  const headers = { "x-admin-token": auth.token };

  // Anonymous callers cannot make the server download a PDF.
  const anon = await fetch(`${BASE}/api/admin?action=dpp-papers&batch=b&subject=s`);
  assert.equal(anon.status, 401, "the papers route answered without a session");

  // The papers behind a subject: real PDF URLs, one per DPP.
  const batch = await (await fetch(`${BASE}/api/batch?id=6a6b461cce4ac4e9ab51ee98`)).json();
  const subject = (batch.subjects || [])[0];
  const list = await fetch(
    `${BASE}/api/admin?action=dpp-papers&batch=6a6b461cce4ac4e9ab51ee98&subject=${encodeURIComponent(subject.id)}`,
    { headers }
  );
  assert.equal(list.status, 200, "the papers route is not mounted");
  const papers = await list.json();
  assert.equal(papers.success, true, papers.error);
  assert.ok(papers.papers.length > 0, "no DPP papers came back");
  const paper = papers.papers[0];
  assert.match(paper.url, /\.pdf$/, "the paper has no PDF url");
  assert.ok(paper.title, "the paper has no title");
  assert.ok(paper.chapter, "the paper is not attributed to a chapter");
  assert.match(papers.headline, /paper/, "the papers list has no headline");

  // And the proxy turns that PDF into questions with a key.
  const read = await fetch(`${BASE}/api/admin?action=dpp-paper&url=${encodeURIComponent(paper.url)}`, {
    headers,
  });
  assert.equal(read.status, 200, "the paper proxy could not read the fixture PDF");
  const body = await read.json();
  assert.equal(body.success, true, body.error);
  assert.equal(body.source, "pdf", "the panel cannot tell a paper from a locked quiz");
  assert.ok(body.questions.length >= 2, `only ${body.questions.length} questions were recovered`);
  assert.equal(body.stats.answerable, body.questions.filter((q) => !q.textOnly).length);

  const q1 = body.questions[0];
  assert.equal(q1.number, 1);
  assert.ok(q1.options.length === 4, "the options were not recovered");
  assert.equal(q1.options[1].letter, "B");
  assert.equal(q1.answer, "B");
  assert.equal(q1.answerIndex, 1);
  assert.equal(q1.textOnly, false);

  // The quiz route still reports a locked paper honestly.
  const quiz = await fetch(`${BASE}/api/admin?action=dpp-paper&id=6aec1d4a8cc8bedf60f3081c`, {
    headers,
  });
  const quizBody = await quiz.json();
  assert.equal(quizBody.source, "quiz");
  assert.equal(quizBody.locked, true, "a quiz the guest cannot read was not reported locked");

  // A URL that is not a PDF is refused without trying to parse it.
  const bogus = await fetch(
    `${BASE}/api/admin?action=dpp-paper&url=${encodeURIComponent("http://127.0.0.1:4285/not-a-pdf")}`,
    { headers }
  );
  assert.notEqual(bogus.status, 200, "a non-PDF URL was accepted");
  assert.match((await bogus.json()).error, /not a PDF|404|answered/i);

  // A relative URL never reaches the network.
  const relative = await fetch(
    `${BASE}/api/admin?action=dpp-paper&url=${encodeURIComponent("/etc/passwd")}`,
    { headers }
  );
  assert.equal(relative.status, 400, "a relative url was accepted");

  await fetch(`${BASE}/api/admin?action=logout`, { method: "POST", headers });
});

test("the panel paints live numbers once signed in", async () => {
  const { register } = await import("node:module");
  const { JSDOM } = await import("jsdom");
  register("./loader.mjs", import.meta.url);

  const html = await (await fetch(`${BASE}/admin.html`)).text();
  const dom = new JSDOM(html, { url: `${BASE}/admin.html`, pretendToBeVisual: true });
  const { window } = dom;

  const sample = {
    success: true,
    ok: true,
    generatedAt: new Date().toISOString(),
    uptimeSeconds: 4210,
    health: [
      { kind: "index", name: "catalogue-index", ok: true, ms: 140, count: 14201, detail: "" },
      { kind: "api", name: "batch-api", ok: true, ms: 210, status: 200, detail: "" },
      { kind: "http", name: "site-home", ok: false, ms: 9, soft: true, detail: "fetch failed — informational" },
    ],
    traffic: {
      requests: 412,
      apiRequests: 380,
      pages: 32,
      bytesOut: 5_400_000,
      errors: 3,
      errorRate: 0.73,
      byStatus: { 200: 400, 500: 3, 404: 9 },
      byRoute: { batches: 200, batch: 100, lecture: 40, admin: 6 },
      byPage: { "site-home": 32 },
      series: Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? i : 0)),
      slowest: [{ route: "stream", ms: 3100, status: 200, at: new Date().toISOString() }],
      lastErrors: [{ route: "hls", status: 500, ms: 120, at: new Date().toISOString() }],
      liveSessions: 2,
    },
    token: { source: "vidcloud relay", cached: true, expiresIn: 540, expiresAt: new Date(Date.now() + 540000).toISOString(), expiryFrom: "token exp claim", prefix: "eyJhbG…(240)", usable: true },
    credentials: [{ source: "vidcloud relay", prefix: "eyJhbG…" }],
    release: { commit: "c86836a9674c41527f6dbaba179edf4bbd07dcc4", commitShort: "c86836a", ref: "main", env: "production", region: "iad1", node: "v22.0.0", deployment: "arsvibe-pw.vercel.app" },
    runtime: { memoryMb: 180, heapMb: 64, pid: 1 },
    catalogue: { batches: 14201, source: "https://example.test/batches.json" },
    trafficNote: "Counts are per warm server instance.",
    client: { ip: "127.0.0.1", ua: "node" },
  };

  // A saved audit from an earlier sweep, in the shape `api/admin.mjs` returns.
  const previousAudit = {
    ok: true,
    batch: "698ad3519549b300a5e1cc6a",
    name: "Arjuna JEE 2027",
    checkedAt: new Date(Date.now() - 90_000).toISOString(),
    ms: 41_000,
    totals: { lectures: 40, healthy: false, plays: 31, pending: 8, "no-stream": 1, broken: 0, unknown: 0 },
    notes: ["Units and Measurement: Physics Wallah no longer serves this section at the address the catalogue points to."],
    truncated: false,
    headline: "31/40 playing · 8 not published yet · 1 refused by the signer",
    lectures: [
      { id: "lec-pending", title: "Live class 14", state: "pending", detail: 'The source marks this lecture "Not Ready" — it has not published the recording yet.', chapterName: "Units and Measurement" },
      { id: "lec-nostream", title: "Units and Measurement 07", state: "no-stream", detail: "The recording exists but every signing host refused it.", chapterName: "Units and Measurement" },
      { id: "lec-plays", title: "Units and Measurement 01", state: "plays", detail: "480 · 5 renditions", chapterName: "Units and Measurement" },
    ],
  };

  const calls = [];
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.CustomEvent = window.CustomEvent;
  window.sessionStorage.setItem("arsvibe.admin.token", "test-token");

  const nativeFetch = globalThis.fetch;
  // Restored in the `finally` at the end of this test: a stub that outlives its
  // test silently poisons every later test that needs the network.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/api/admin")) {
      // The boot path asks `whoami` first, then fetches stats, then asks whether
      // there is a previous audit to paint.
      const body = url.includes("action=whoami")
        ? { success: true, signedIn: true }
        : url.includes("action=audit")
          ? { success: true, running: false, progress: null, audit: previousAudit }
          : sample;
      return { ok: true, status: 200, json: async () => body };
    }
    return nativeFetch(url.startsWith("http") ? url : `${BASE}${url}`, init);
  };

  await import(`/assets/admin.js?v=1`);
  // The boot path verifies the stored session first, then renders.
  await new Promise((r) => setTimeout(r, 300));

  const doc = window.document;
  assert.equal(doc.getElementById("gate").hidden, true, "the sign-in gate stayed up");
  assert.equal(doc.getElementById("panel").hidden, false, "the panel did not appear");

  // Real numbers, formatted, not placeholders.
  assert.match(doc.getElementById("statusLine").textContent, /All systems operational/);
  const stats = doc.getElementById("heroStats").textContent.replace(/\s+/g, " ");
  assert.match(stats, /412/, "requests were not rendered");
  assert.match(stats, /3/, "errors were not rendered");

  // Health rows and their soft-failure handling.
  const rows = doc.querySelectorAll("#healthList .health-row");
  assert.equal(rows.length, 3, `expected 3 health rows, got ${rows.length}`);
  assert.ok(rows[2].querySelector(".health-dot.warn"), "a soft failure should not read as an outage");
  assert.match(doc.getElementById("healthSum").textContent, /3\/3/);

  // The sparkline has a real path, not an empty element.
  const d = doc.getElementById("sparkLine").getAttribute("d");
  assert.ok(/^M0/.test(d || ""), "the sparkline path was not drawn");
  assert.ok(d.split("L").length > 10, "the sparkline has too few points");

  // Route bars, deployment facts, token state.
  assert.ok(doc.querySelectorAll("#routeBars .route-bar").length >= 4);
  assert.match(doc.getElementById("releaseKv").textContent, /c86836a/);
  assert.match(doc.getElementById("tokenBox").textContent, /vidcloud relay/);
  assert.match(doc.getElementById("runtimeKv").textContent, /14,201 batches/);

  // The content audit: a saved sweep is painted on boot, without the operator
  // having to press anything.
  const totals = doc.getElementById("auditTotals").textContent.replace(/\s+/g, " ");
  assert.match(totals, /31/, "the playing total was not painted");
  assert.match(totals, /8/, "the pending total was not painted");
  assert.ok(doc.querySelectorAll("#auditTotals .audit-total").length >= 5, "some states were dropped");

  const auditRows = doc.querySelectorAll("#auditRows .audit-row");
  assert.equal(auditRows.length, 3, `expected 3 audit rows, got ${auditRows.length}`);
  // Worst first: an operator reads the top of the list, not the middle.
  assert.match(auditRows[0].textContent, /no stream|refused/i, "the worst lecture is not first");
  assert.equal(auditRows[0].getAttribute("data-id"), "lec-nostream", "rows were not sorted worst-first");
  assert.match(auditRows[2].textContent, /Units and Measurement 01/, "a playing lecture sorted ahead of a fault");

  // `pending` means "the source has not published it", which is nobody's bug.
  // It must not wear a fault colour, or operators learn to ignore red.
  const pendingRow = doc.querySelector('#auditRows .audit-row[data-id="lec-pending"] .audit-state');
  assert.ok(pendingRow, "the pending lecture has no state chip");
  assert.equal(pendingRow.classList.contains("pending"), true);
  assert.equal(pendingRow.classList.contains("broken"), false, "pending was painted as broken");
  const pendingTile = doc.querySelector('#auditTotals .audit-total.is-pending');
  assert.ok(pendingTile, "there is no pending tile");
  assert.equal(
    pendingTile.classList.contains("is-broken"),
    false,
    "the pending tile is styled as a failure"
  );

  assert.match(doc.getElementById("auditStamp").textContent, /Arjuna/, "the audit stamp lost the batch name");
  assert.match(doc.getElementById("auditNotes").textContent, /no longer serves this section/);
  // Every row can be re-checked on its own.
  assert.equal(doc.querySelectorAll("#auditRows .audit-rescan").length, 3, "some rows cannot be re-checked");

  // Signing out must clear the token and go back to the gate.
  doc.getElementById("signOutBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(doc.getElementById("panel").hidden, true, "sign out left the panel up");
  assert.equal(window.sessionStorage.getItem("arsvibe.admin.token"), null, "the token survived sign out");

  dom.window.close();
  // Hand the real network back to whatever test runs next.
  globalThis.fetch = nativeFetch;
});

test("the mounted media routes answer instead of crashing", async () => {
  // /api/sign and /api/hls are mounted inside api/admin.mjs and api/stream.mjs to
  // stay inside the plan's 12-function budget. That makes an undefined import a
  // runtime crash rather than a build error — which shipped once. A smoke check
  // that the routes answer at all is the cheap guard.
  const sign = await fetch(`${BASE}/api/sign`);
  assert.equal(sign.status, 400, "/api/sign should reject a missing videoKey");
  assert.match(JSON.parse(await sign.text()).error, /videoKey is required/);

  const hls = await fetch(`${BASE}/api/hls?folder=does-not-exist&asset=master.mpd`);
  assert.notEqual(hls.status, 500, "/api/hls crashed");
  assert.match(hls.headers.get("content-type") || "", /application\/json/);
  const body = await hls.json();
  assert.equal(body.success, false, "/api/hls should report an honest failure");

  // The host whitelist still holds for both media routes.
  const badHost = await fetch(
    `${BASE}/api/hls?folder=x&asset=master.mpd&host=${encodeURIComponent("evil.example.com")}`
  );
  const badBody = await badHost.json();
  assert.equal(badBody.success, false);
  assert.match(badBody.error, /not a media host/);

  // The player's repair line is public on purpose (the player has no session) and
  // must stay boring: a receipt, no stack trace, no ledger.
  const repair = await fetch(`${BASE}/api/repair?folder=test-folder&kind=manifest&detail=403`);
  assert.equal(repair.status, 200, "the repair line is not mounted");
  const healed = await repair.json();
  assert.equal(healed.success, true);
  assert.equal(healed.retry, true, "the player is not told whether to retry");
  assert.equal(healed.repaired, true);
  assert.equal(JSON.stringify(healed).includes("summary"), false, "the ledger leaked to a public route");
  assert.equal(JSON.stringify(healed).includes("signers"), false, "the signer ladder leaked to a public route");

  // And the route they ride on still does its own job.
  const stream = await fetch(`${BASE}/api/stream`);
  assert.notEqual(stream.status, 500, "/api/stream crashed after mounting the HLS gateway");
  assert.match(stream.headers.get("content-type") || "", /application\/json/);
});

test("the DPP test runner scores a real paper and shows the key", async () => {
  const { register } = await import("node:module");
  const { JSDOM } = await import("jsdom");
  register("./loader.mjs", import.meta.url);

  const html = await (await fetch(`${BASE}/admin.html`)).text();
  const dom = new JSDOM(html, { url: `${BASE}/admin.html`, pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;

  globalThis.window = window;
  globalThis.document = doc;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.sessionStorage = window.sessionStorage;

  const { body: auth } = await signIn();
  window.sessionStorage.setItem("arsvibe.admin.token", auth.token);

  // The panel talks to the running dev server, which is pointed at the fixture
  // upstream — a real PDF for the paper, so this exercises the whole path:
  // papers → proxy → extract → run → score.
  globalThis.fetch = (input, init) =>
    REAL_FETCH(String(input).startsWith("http") ? input : `${BASE}${input}`, init);

  await import(`/assets/admin.js?v=runner-${Date.now()}`);
  await new Promise((r) => setTimeout(r, 400));

  const click = (id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  // Wait for a condition rather than sleeping: a fixed delay loses a race with
  // the dev server whenever the rest of the suite has warmed it differently.
  const until = async (check, what, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  doc.getElementById("dppBatch").value = "6a6b461cce4ac4e9ab51ee98";
  click("dppLoadSubjects");
  await until(() => doc.getElementById("dppSubject").options.length > 2, "the subject picker");
  const picker = doc.getElementById("dppSubject");
  picker.value = picker.options[1].value;

  click("dppPapersLoad");
  await until(
    () => doc.querySelectorAll("#dppPapers .dpp-row").length > 0,
    `the DPP paper list (error: ${doc.getElementById("dppPapersError").textContent || "none"}; ` +
      `stamp: ${doc.getElementById("dppPapersStamp").textContent || "empty"})`
  );
  const rows = doc.querySelectorAll("#dppPapers .dpp-row");
  assert.ok(rows.length > 0, "no DPP papers were listed");
  assert.match(doc.getElementById("dppPapersStamp").textContent, /paper/);

  rows[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(
    () => doc.querySelectorAll("#dppTestQuestions input[type=radio]").length > 0,
    "the paper to be read into questions"
  );

  // A runnable test, not a "locked" notice.
  assert.equal(doc.getElementById("dppTestBlock").hidden, false, "the runner did not open");
  assert.match(doc.getElementById("dppTestMeta").textContent, /question/, "the runner has no question count");
  assert.notEqual(doc.getElementById("dppTestMeta").textContent, "could not read");
  assert.match(doc.getElementById("dppTestClock").textContent, /^\d{2}:\d{2}$/, "the clock did not start");

  const radios = doc.querySelectorAll("#dppTestQuestions input[type=radio]");
  assert.equal(radios.length, 8, `expected 2 questions x 4 options, got ${radios.length}`);
  assert.ok(doc.getElementById("dppTestQuestions").textContent.includes("most accurate reading"));

  // Answers are hidden until submit: no option is marked correct yet.
  assert.equal(doc.querySelectorAll(".dpp-choice.is-correct").length, 0, "the key leaked before submit");

  // Q1 correct (B), Q2 wrong (A).
  const answer = (q, letter) => {
    const input = doc.querySelector(`input[data-question="${q}"][data-letter="${letter}"]`);
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  answer(0, "B");
  answer(1, "A");
  assert.match(doc.getElementById("dppTestProgress").textContent, /2 of 2 answered/);

  doc.getElementById("dppTestForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => doc.getElementById("dppTestResult").hidden === false, "the score");

  const result = doc.getElementById("dppTestResult");
  assert.equal(result.hidden, false, "submitting showed no score");
  const score = result.textContent.replace(/\s+/g, " ");
  assert.match(score, /1 of 2 correct/, `the score is wrong: ${score}`);
  assert.match(score, /50%/);
  assert.match(doc.getElementById("dpp-q-0").querySelector(".dpp-question-note").textContent, /Correct/);
  assert.match(doc.getElementById("dpp-q-1").querySelector(".dpp-question-note").textContent, /answer is B/);
  assert.ok(doc.querySelector(".dpp-choice.is-correct"), "the right answer is not highlighted");
  assert.ok(doc.querySelector(".dpp-choice.is-wrong"), "the wrong choice is not highlighted");
  // Nothing is answerable after submitting, and the clock stops.
  assert.equal([...doc.querySelectorAll("#dppTestQuestions input")].every((i) => i.disabled), true);
  assert.equal(doc.getElementById("dppTestSubmit").disabled, true);

  /* The analysis: the panel asks the server for the marking, so `fetch` in this
     test is a live request against the dev server — the score above is the
     server's, not this file's arithmetic. The review list is what an operator
     reads afterwards, and the filters are how they find the question to fix. */
  assert.match(doc.getElementById("dppTestProgress").textContent, /submitted · 50%/);
  assert.equal(doc.getElementById("dppTestFilter").hidden, false, "no review filters");
  const review = doc.getElementById("dppTestReview");
  assert.equal(review.querySelectorAll(".dpp-rev").length, 2, "the review list is empty");
  assert.ok(review.querySelector(".dpp-rev.is-correct"), "the right answer is not in the review");
  assert.ok(review.querySelector(".dpp-rev.is-wrong"), "the wrong answer is not in the review");
  assert.match(
    review.querySelector(".dpp-rev.is-wrong").textContent,
    /key says B/,
    "the review does not say what the key was"
  );

  // "Wrong" must narrow to the one question worth reading, not repaint everything.
  doc.querySelector('#dppTestFilter [data-filter="wrong"]').dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  assert.equal(review.querySelectorAll(".dpp-rev").length, 1);
  assert.ok(review.querySelector(".dpp-rev.is-wrong"));

  // Signing out stops the panel's poller. Without it, the 20 s interval keeps the
  // Node process alive and the whole suite hangs after the last assertion — the
  // panel runs in this process, not in the window.
  click("signOutBtn");
  await new Promise((r) => setTimeout(r, 150));
  dom.window.close();
});

test("repeated bad passwords trip a cooldown", async () => {
  // Runs last: the cooldown is per client address and outlives a single request.
  let limited = false;
  let lastStatus = 0;
  for (let i = 0; i < 8; i += 1) {
    const attempt = await signIn(TEST_USER, `wrong-${i}`);
    lastStatus = attempt.status;
    if (attempt.status === 429) {
      limited = true;
      assert.match(attempt.body.error, /Try again in \d+ minute/i);
      break;
    }
  }
  assert.ok(limited, `repeated bad passwords are not rate limited (last status ${lastStatus})`);

  // Even the correct password is refused while the cooldown is active: the point
  // of a cooldown is to stop guessing, not just to stop wrong guesses.
  const correct = await signIn();
  assert.equal(correct.status, 429, "the cooldown let a correct password through");
});
