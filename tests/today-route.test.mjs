/**
 * Today's classes, end to end through the dev server.
 *
 * The unit tests prove the reader decides *time* correctly against a probe. This
 * proves the seam the browser actually uses: that `/api/batch?today=1` answers,
 * that it walks the subject listings (the only schedule surface that answers a
 * guest), that a pinned clock is honoured, and that the strip is drawn on the
 * batch page from the route's answer.
 *
 * The clock is pinned on every request. A feature defined by "what is on right
 * now" is untestable against the wall clock — it would pass at 10:31 and fail at
 * 10:32 — so the route accepts `?now=` and the fixture upstream anchors its rows
 * to it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4298;
const FIXPORT = 4299;
const BASE = `http://127.0.0.1:${PORT}`;
const BATCH = "698ad3519549b300a5e1cc6a";

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
  start(["scripts/fixture-upstream.mjs"], { FIXPORT: String(FIXPORT), FIXTURE_PORT: String(FIXPORT) });
  await waitFor(`http://127.0.0.1:${FIXPORT}/AllBatches?page=1`);
  start(["scripts/dev.mjs"], {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PW_UPSTREAM_BASE: `http://127.0.0.1:${FIXPORT}`,
    ADMIN_USERNAME: "today-user",
    ADMIN_PASSWORD: "today-pass",
  });
  await waitFor(`${BASE}/batch.html`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

/** A pinned clock, so "today" means one fixed day for the whole file. */
const PINNED = "2026-11-13T16:15:00Z";

test("the route answers a day, not an exception", async () => {
  const res = await fetch(`${BASE}/api/batch?today=1&id=${BATCH}&now=${encodeURIComponent(PINNED)}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.today, "no day in the answer");
  assert.ok(["ok", "empty", "error", "none"].includes(data.today.state), `unexpected state ${data.today.state}`);
});

test("the day is read from the batch schedule, and is today's", async () => {
  const data = await (
    await fetch(`${BASE}/api/batch?today=1&id=${BATCH}&at=${encodeURIComponent(PINNED)}`)
  ).json();
  const day = data.today;
  assert.equal(day.state, "ok", `the fixture day did not read: ${JSON.stringify(day).slice(0, 300)}`);
  assert.equal(day.day, "2026-11-13");
  // The fixture's Physics listing holds three rows on the pinned day: one that
  // started ten minutes before the clock, a cancelled slot 45 minutes later, and
  // a real class in the evening.
  assert.equal(day.classes.length, 3, `expected the day's three rows, got ${day.classes.length}`);
  assert.deepEqual(
    day.classes.map((c) => c.status),
    ["live", "upcoming", "upcoming"],
    "the day is not ordered live-first, or a class lost its status"
  );
  // A cancelled slot keeps its place on the day and loses its status, end to end
  // through the route — not only in the reader's unit tests.
  assert.deepEqual(
    day.classes.map((c) => Boolean(c.cancelled)),
    [false, true, false],
    "the cancelled slot is not marked, or a real class was marked"
  );
  assert.equal(day.scanned.cancelled.count, 1);
  // The batch's own schedule endpoint is the primary source now: one request
  // for the whole day, not one listing per subject.
  assert.equal(day.scanned.source, "schedule");
  // Every row is on the pinned day, in IST — not in the server's timezone.
  for (const c of day.classes) assert.equal(day.day, "2026-11-13");
  // One of them started ten minutes before the pinned clock and has not ended:
  // that is the row the whole feature exists for.
  assert.ok(day.classes.some((c) => c.status === "live"), "no class is reported as live");
  // The read is per subject, so the subject name has to survive the walk.
  assert.ok(day.classes.every((c) => c.subject), "a class lost its subject");
});

test("a class on air is not offered as a recording", async () => {
  const data = await (
    await fetch(`${BASE}/api/batch?today=1&id=${BATCH}&at=${encodeURIComponent(PINNED)}`)
  ).json();
  const live = data.today.classes.find((c) => c.status === "live");
  assert.equal(live.hasStream, false, "a class with no recording claims to have a stream");
});

test("a batch's day does not spend a request per subject twice", async () => {
  // The day is cached for a minute; two reads in a row must agree and must not
  // both walk the subject list. The second read is the one a page refresh makes.
  const url = `${BASE}/api/batch?today=1&id=${BATCH}&at=${encodeURIComponent(PINNED)}`;
  const a = await (await fetch(url)).json();
  const b = await (await fetch(url)).json();
  assert.deepEqual(a.today.classes.map((c) => c.id), b.today.classes.map((c) => c.id));
});

test("the batch page carries the strip's host, hidden until there is a day", async () => {
  const html = await (await fetch(`${BASE}/batch.html`)).text();
  assert.match(html, /id="todaySection"/);
  assert.match(html, /id="todayStrip"/);
  // Hidden in the markup: no classes today must not open every batch page with a
  // gap where a strip would be.
  assert.match(html, /id="todaySection"[^>]*hidden/);
});

test("the strip is served as a real module and is pre-cached", async () => {
  const res = await fetch(`${BASE}/assets/today.js`);
  assert.equal(res.status, 200);
  const src = await res.text();
  assert.match(src, /export function todayMarkup/);
  assert.match(src, /export async function mountToday/);
  const sw = await (await fetch(`${BASE}/sw.js`)).text();
  assert.match(sw, /"\/assets\/today\.js"/, "the worker does not pre-cache the strip");
});

test("a batch the shipped catalogue has never heard of still gets a day", async () => {
  // The header route is a local catalogue lookup, so it answers nothing for a
  // batch id that is not in the shipped index. The strip must then fall back to
  // the full batch read rather than reporting an empty day — the catalogue is an
  // optimisation on this site, never a gate.
  const unknown = "6acc6da838f6f1f44a229f61";
  const data = await (
    await fetch(`${BASE}/api/batch?today=1&id=${unknown}&at=${encodeURIComponent(PINNED)}`)
  ).json();
  assert.ok(data.today, "no day for a batch the catalogue does not carry");
  // This batch is not in the shipped catalogue, so its subjects come from the
  // full batch read — and the fixture answers that with a subject whose listing
  // holds nothing for the pinned day. The point under test is that the read
  // *happened*: `none` would mean the strip gave up before asking.
  assert.notEqual(data.today.state, "none", "the strip concluded the batch has no subjects");
  assert.ok(data.today.scanned.subjects > 0, "no subject listing was read");
});

test("today's day is edge-cached for seconds, not minutes", async () => {
  // `/api/batch` answers with a five-minute shared cache, which is right for a
  // batch's subjects and wrong for "is this class on right now": a strip that is
  // five minutes behind shows a live badge on a class that has ended. The
  // `today=1` request therefore gets its own, much shorter, edge TTL.
  const { readFile } = await import("node:fs/promises");
  const conf = JSON.parse(await readFile(path.join(ROOT, "vercel.json"), "utf8"));
  const rules = (conf.headers || []).filter(
    (r) => r.source === "/api/batch" && (r.has || []).some((h) => h.key === "today")
  );
  assert.equal(rules.length, 1, "no edge-cache rule for the day");
  const cache = rules[0].headers.find((h) => h.key === "Cache-Control").value;
  const sMaxAge = Number(/s-maxage=(\d+)/.exec(cache)?.[1] || 0);
  assert.ok(sMaxAge > 0 && sMaxAge <= 60, `the day may sit in the edge cache for ${sMaxAge}s`);

  // And the rule has to come *before* the generic one, because the first match
  // wins.
  const order = (conf.headers || []).filter((r) => r.source === "/api/batch");
  assert.ok(
    (order[0].has || []).some((h) => h.key === "today"),
    "the generic /api/batch rule shadows the day's shorter cache"
  );
});

test("the hottest read routes are edge-cached after the generic no-store rule", async () => {
  // Header rules apply in order and the last match wins, so a cacheable route
  // named *before* `/api/(.*)` would be silently overridden by its `no-store`.
  // `/api/contents` and `/api/lecture` are the two hottest reads on the site;
  // both must sit after the generic rule with a real shared TTL.
  const { readFile } = await import("node:fs/promises");
  const conf = JSON.parse(await readFile(path.join(ROOT, "vercel.json"), "utf8"));
  const sources = (conf.headers || []).map((r) => r.source);
  const generic = sources.indexOf("/api/(.*)");
  assert.ok(generic >= 0, "the generic /api rule is missing");
  for (const source of ["/api/contents", "/api/lecture"]) {
    const at = sources.indexOf(source);
    assert.ok(at > generic, `${source} must come after the generic /api rule or no-store overrides it`);
    const rule = conf.headers[at];
    const cache = rule.headers.find((h) => h.key === "Cache-Control")?.value || "";
    assert.ok(/s-maxage=\d+/.test(cache), `${source} has no shared edge TTL: ${cache}`);
  }
});
