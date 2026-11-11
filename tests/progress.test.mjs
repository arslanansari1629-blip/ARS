/**
 * XP, streaks and the leaderboard.
 *
 * Three things here are worth guarding harder than the rest, because each has a
 * failure mode that looks fine on screen:
 *
 *   1. XP must be *derived*, not stored. A stored total drifts from the ledger
 *      after a half-written save or a hand-edited key, and then one student has
 *      two numbers.
 *   2. A streak must be honest about being at risk. "7 days" all day after the
 *      run broke is the bug, not the edge case.
 *   3. The board must be the server's, validated, and clear about whether it is
 *      actually shared — a board backed by one instance's memory that says
 *      "leaderboard" is a lie a student can check.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { register } from "node:module";
import { JSDOM } from "jsdom";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  award,
  recordPaper,
  earnedXp,
  levelInfo,
  xpForLevel,
  getStreak,
  recentDays,
  dayKey,
  shiftDay,
  daysBetween,
  displayName,
  milestones,
  nextMilestone,
  browserId,
} from "../public/assets/progress.js";
import { rank, cleanName, cleanXp, rowId, board, publish, clearBoard } from "../lib/leaderboard.mjs";

register("./loader.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const join = (...parts) => path.join(...parts);
const PORT = 4302;
const FIXPORT = 4303;
const BASE = `http://127.0.0.1:${PORT}`;

const children = [];
const REAL_FETCH = globalThis.fetch.bind(globalThis);

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
    await new Promise((r) => setTimeout(r, 150));
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
  });
  await waitFor(`${BASE}/`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

/**
 * The progress module reads and writes `localStorage` directly, so every test
 * gets a clean one. jsdom gives us a real implementation rather than a stub.
 */
function freshStorage() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://arsvibe.test/" });
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.window = dom.window;
  return dom;
}

/* --------------------------------------------------------------------- xp */

test("a marked paper pays once a day, and the total is the ledger", () => {
  freshStorage();
  const url = "https://static.pw.live/paper-1.pdf";

  const first = recordPaper({ url, correct: 10, scored: 14, percent: 71 });
  assert.ok(first.xp > 0, "a marked paper earned nothing");
  const paper = first.awards.find((a) => a.kind === "dpp");
  assert.ok(paper, "the paper itself was not recorded");
  // One award carrying the paper's own arithmetic — 50 to be marked, 6 a mark.
  assert.equal(paper.points, 50 + 60);
  assert.equal(paper.meta.breakdown.answers, 60);

  const total = earnedXp();
  assert.equal(first.xp, total, "the award total and the ledger disagree");

  // The same paper again, same day: practice, not a second harvest.
  // The loophole worth naming: an earlier version keyed the correct answers
  // separately, so re-sitting the paper with two more right paid again. It must
  // not.
  const again = recordPaper({ url, correct: 14, scored: 14, percent: 100 });
  assert.equal(again.xp, 0, "retrying a paper the same day paid again");
  assert.equal(earnedXp(), total, "the ledger grew on a repeat");
  assert.equal(again.breakdown.perfect, 40, "the retry is still described honestly");
});

test("XP cannot be written into the ledger by hand — it is recomputed", () => {
  freshStorage();
  award("dpp", "dpp:manual", { day: "2026-01-01" });
  const honest = earnedXp();
  assert.equal(honest, 50);

  // Someone edits the stored total. There is no stored total: this is the ledger.
  const raw = JSON.parse(localStorage.getItem("arsvibe.progress"));
  raw.xp = 999999;
  localStorage.setItem("arsvibe.progress", JSON.stringify(raw));
  assert.equal(earnedXp(), honest, "editing the record changed the score");

  // An unknown kind contributes nothing, whatever points it claims.
  raw.ledger.push({ kind: "cheat", id: "cheat:1", points: 10_000, day: "2026-01-01" });
  localStorage.setItem("arsvibe.progress", JSON.stringify(raw));
  assert.equal(earnedXp(), honest, "an invented award was counted");
});

test("a perfect paper is named, and a bad one is still worth something", () => {
  freshStorage();
  const perfect = recordPaper({ url: "p-a", correct: 14, scored: 14, percent: 100 });
  assert.equal(perfect.breakdown.perfect, 40, "100% was not named");
  assert.ok(perfect.awards.some((a) => a.meta?.breakdown?.isPerfect), "the ledger lost the perfect paper");

  const poor = recordPaper({ url: "p-b", correct: 2, scored: 14, percent: 14 });
  assert.ok(poor.xp > 0, "a weak attempt should still pay for the correct answers");
  assert.equal(poor.breakdown.perfect, 0);
  assert.equal(poor.breakdown.answers, 12);
});

test("levels rise, cost more each time, and never lose progress", () => {
  assert.equal(xpForLevel(1), 0);
  for (let l = 1; l < 12; l++) {
    assert.ok(xpForLevel(l + 1) > xpForLevel(l), `level ${l + 1} is not longer than ${l}`);
  }
  const info = levelInfo(500);
  assert.ok(info.level >= 2, "500 XP is still level 1");
  assert.ok(info.percent >= 0 && info.percent <= 100);
  assert.ok(info.into >= 0 && info.into < info.span);
  assert.ok(info.title && !/^undefined/.test(info.title));
});

/* ----------------------------------------------------------------- streak */

test("a streak counts back from today, and calls itself at risk when today is empty", () => {
  freshStorage();
  const today = dayKey();
  const yesterday = shiftDay(today, -1);
  const before = shiftDay(today, -2);

  award("dpp", "dpp:d1", { day: before });
  award("dpp", "dpp:d2", { day: yesterday });

  // No paper today: the run exists but is not being carried forward.
  const stud = (day) => ({
    days: {
      [before]: { dpp: 1, xp: 50 },
      [yesterday]: { dpp: 1, xp: 50 },
    },
  });
  const s = getStreak(new Date(), stud());
  assert.equal(s.current, 2, `expected a 2-day run, got ${s.current}`);
  assert.equal(s.studiedToday, false);
  assert.equal(s.atRisk, true, "a run with no paper today must be flagged at risk");

  // Today's paper carries it to 3 and clears the risk.
  award("dpp", "dpp:d3", { day: today });
  const after = getStreak(new Date());
  assert.equal(after.current, 3);
  assert.equal(after.studiedToday, true);
  assert.equal(after.atRisk, false);
  assert.equal(after.longest, 3);

  // A gap of one day ends the run rather than silently continuing it.
  const gapped = getStreak(new Date(), {
    days: { [before]: { dpp: 1 }, [today]: { dpp: 1 } },
  });
  assert.equal(gapped.current, 1, "a gap did not break the streak");
});

test("the seven-day strip is real dates, oldest first, ending today", () => {
  freshStorage();
  award("dpp", "dpp:today", { day: dayKey() });
  const week = recentDays(7);
  assert.equal(week.length, 7);
  assert.equal(week[6].day, dayKey());
  assert.equal(week[6].isToday, true);
  assert.equal(week[6].active, true);
  assert.equal(week[0].active, false);
  assert.equal(daysBetween(week[0].day, week[6].day), 6);
});

/* -------------------------------------------------------------- the board */

test("a row is validated on the server, whatever the browser sends", () => {
  // Markup-ish characters go; the length cap is counted in characters, so an
  // attempt to smuggle a long name is cut the same way for every script.
  assert.equal(cleanName("<b>hi</b>"), "bhi/b");
  assert.doesNotMatch(cleanName("x".repeat(80)), /[<>"']/);
  assert.equal([...cleanName("x".repeat(80))].length, 24);
  assert.equal(cleanName("   "), "Student");
  assert.equal([...cleanName("x".repeat(80))].length, 24);
  assert.equal(cleanXp(-5), 0);
  assert.equal(cleanXp("12"), 12);
  assert.equal(cleanXp(1e12), 2_000_000);
  assert.equal(cleanXp(NaN), 0);

  // The public row id is a hash, never the browser's own string.
  const uid = rowId("browser-id-abcdef123456");
  assert.match(uid, /^[0-9a-f]{12}$/);
  assert.equal(uid, rowId("browser-id-abcdef123456"), "the same browser must keep its row");
  assert.notEqual(uid, rowId("another-browser-id-999"));
  assert.equal(rowId(""), "", "an empty id must not become a row");
});

test("the board orders by XP, keeps one row per player and ranks the caller", async () => {
  clearBoard();
  await publish({ id: "player-one-aaaaaa", name: "Aarav", xp: 120, level: 1, streak: 2 });
  await publish({ id: "player-two-bbbbbb", name: "Isha", xp: 900, level: 4, streak: 9 });
  await publish({ id: "player-three-cccc", name: "Kabir", xp: 450, level: 2, streak: 1 });

  const out = await board({ me: "player-three-cccc" });
  assert.deepEqual(out.rows.map((r) => r.name), ["Isha", "Kabir", "Aarav"]);
  assert.deepEqual(out.rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(out.me.name, "Kabir");
  assert.equal(out.me.rank, 2);
  assert.equal(out.me.uid, rowId("player-three-cccc"));

  // Publishing again updates the same row rather than adding a second one.
  await publish({ id: "player-one-aaaaaa", name: "Aarav", xp: 1500, level: 5, streak: 3 });
  const after = await board();
  assert.equal(after.rows.filter((r) => r.name === "Aarav").length, 1, "a player got two rows");
  assert.equal(after.rows[0].name, "Aarav");
  assert.equal(after.rows[0].xp, 1500);
});

test("a row never loses ground within a day, and names the store it is using", async () => {
  clearBoard();
  await publish({ id: "steady-player-xyz", name: "Meera", xp: 800, level: 3, streak: 4 });
  // A stale tab, opened before those papers, must not push the row back down.
  await publish({ id: "steady-player-xyz", name: "Meera", xp: 100, level: 1, streak: 0 });
  const out = await board();
  const row = out.rows.find((r) => r.name === "Meera");
  assert.equal(row.xp, 800, "a stale tab overwrote a better score");
  assert.equal(row.level, 3);

  // And the payload is honest about what it is.
  assert.equal(out.persistent, false, "a memory board claimed to be persistent");
  assert.equal(out.store, "memory");
  assert.match(out.note, /attach a store|store/i);
});

test("rank drops rows nobody has refreshed in a month", () => {
  const old = Date.now() - 40 * 86_400_000;
  const rows = rank({
    a: { n: "Ancient", xp: 9000, at: old },
    b: { n: "Current", xp: 10, at: Date.now() },
  });
  assert.deepEqual(rows.map((r) => r.name), ["Current"]);
});

/* ---------------------------------------------------------- the public route */

test("the board route answers anonymously, publishes, and refuses nothing that matters", async () => {
  const get = async (qs = "") => {
    const res = await REAL_FETCH(`${BASE}/api/token?route=board${qs}`);
    const body = await res.json().catch(() => ({}));
    return { res, body };
  };

  const boot = await get("&me=browser-under-test-1234&limit=10");
  assert.equal(boot.res.status, 200, "the board route is not public");
  assert.equal(boot.body.success, true);
  assert.ok(Array.isArray(boot.body.rows));
  assert.equal(typeof boot.body.persistent, "boolean");

  const published = await REAL_FETCH(`${BASE}/api/token?route=board`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "browser-under-test-1234", name: "Test Row", xp: 321, level: 2, streak: 3 }),
  });
  assert.equal(published.status, 200);
  const row = await published.json();
  assert.equal(row.success, true);
  assert.ok(row.rank >= 1);

  const after = await get("&me=browser-under-test-1234");
  assert.ok(
    after.body.rows.some((r) => r.name === "Test Row"),
    "a published row did not appear on the board"
  );

  // A body with no id is refused rather than creating an anonymous row.
  const empty = await REAL_FETCH(`${BASE}/api/token?route=board`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nobody", xp: 5 }),
  });
  assert.equal(empty.status, 400);

  // The token-state route is untouched by the board being folded into it: asked
  // without `route=board` it must not answer with a board. (It spends the
  // credential upstream, so the answer itself depends on the network; the
  // dispatch is what belongs in this test.)
  const plain = await REAL_FETCH(`${BASE}/api/token`, { signal: AbortSignal.timeout(20000) });
  const plainBody = await plain.json().catch(() => ({}));
  assert.notEqual(plain.status, 405, "/api/token stopped accepting GET");
  assert.notEqual(plain.status, 404, "/api/token disappeared");
  assert.equal(plainBody.rows, undefined, "the token route answered with a board");
});

test("the leaderboard page and the progress module are wired together", async () => {
  const html = await (await REAL_FETCH(`${BASE}/leaderboard.html`)).text();
  for (const hook of ["xpTotal", "xpLevel", "xpBar", "streakCurrent", "streakWeek", "boardList", "boardNote", "milestones", "xpRules"]) {
    assert.match(html, new RegExp(`id="${hook}"`), `the leaderboard has no #${hook}`);
  }
  assert.match(html, /route=board|leaderboard\.js/, "the page does not load its module");

  const js = await (await REAL_FETCH(`${BASE}/assets/leaderboard.js`)).text();
  assert.match(js, /route=board/, "the page never asks the board route");
  assert.match(js, /persistent/, "the page cannot tell a shared board from a local one");
  assert.match(js, /displayName/, "the page does not name the row");

  // Watching and reading pay where the work happens, not on a listing page.
  const lecture = await (await REAL_FETCH(`${BASE}/assets/lecture.js`)).text();
  assert.match(lecture, /award\("watch20"/, "20 minutes of a lecture pays nothing");
  assert.match(lecture, /award\("lecture"/, "a finished lecture pays nothing");
  const viewer = await (await REAL_FETCH(`${BASE}/assets/viewer.js`)).text();
  assert.match(viewer, /award\("note"/, "reading a note pays nothing");

  // The DPP practice page awards from the marked result, not from its own count.
  const dpp = await (await REAL_FETCH(`${BASE}/assets/dpp.js`)).text();
  assert.match(dpp, /recordPaper\(\{/, "a marked paper awards nothing");
  assert.match(dpp, /data\.result\?\.correct/, "the award does not come from the server's marking");
});

test("notes and lectures pay from where the work happens, and cannot be farmed", () => {
  freshStorage();

  // A note pays once, keyed on its address — reopening it is free.
  const first = award("note", "note:https://static.pw.live/notes/x.pdf");
  assert.equal(first.points, 8);
  assert.equal(award("note", "note:https://static.pw.live/notes/x.pdf"), null);

  // A lecture pays once, and 20 minutes of it pays once more, separately.
  assert.ok(award("lecture", "lecture:abc"));
  assert.equal(award("lecture", "lecture:abc"), null);
  assert.ok(award("watch20", "watch20:abc"));
  assert.equal(award("watch20", "watch20:abc"), null);

  assert.equal(earnedXp(), 8 + 15 + 20);

  // Watching is not a streak: the run is about papers, so these must not touch it.
  const s2 = getStreak();
  assert.equal(s2.current, 0, "watching a lecture started a streak");
  assert.equal(s2.studiedToday, false);
});

test("the dashboard shows the same record, and the name on the board is not the email", () => {
  const name = displayName({ name: "Aarav Sharma", email: "aarav@example.com" });
  assert.match(name, /^Aarav [0-9A-Z]{2}$/);
  assert.doesNotMatch(name, /@/, "the board would publish an email address");
  assert.equal(name, displayName({ name: "Aarav Sharma", email: "aarav@example.com" }), "the tag is not stable");
  assert.notEqual(name, displayName({ name: "Aarav Nair", email: "aarav.nair@example.com" }));

  // Milestones only ever move forward.
  const ms = milestones(600);
  assert.equal(ms[0].done, true);
  assert.equal(ms.at(-1).done, false);
  assert.equal(nextMilestone(600).xp, 1000);
});

test("the dashboard band is in the served HTML, not built after a redirect", async () => {
  // `/dashboard` requires a session and bounces a signed-out visitor to the
  // login page — so the served HTML is the only place the XP band can be checked
  // without a browser profile. A hidden band that only appears after sign-in
  // would mean a signed-out student never sees the record they already have.
  const log = await (await REAL_FETCH(`${BASE}/leaderboard.html`)).text();
  assert.match(log, /id="xpTotal"/, "the board page does not serve its standing");
  assert.match(log, /seven-day|streakWeek/, "the board page has no streak strip");

  const src = await (await REAL_FETCH(`${BASE}/assets/dashboard.js`)).text();
  assert.match(src, /id="xpTotal"|byId\("xpTotal"\)/, "the dashboard never paints XP");
  assert.match(src, /progress:change/, "the dashboard band never updates");

  const html = await readFile(join(ROOT, "public", "dashboard.html"), "utf8");
  assert.match(html, /id="xpBand"/, "the dashboard has no XP band");
  assert.match(html, /id="streakWeek"/, "the dashboard has no streak strip");
});

test("the browser id is stored, stable, and opaque", () => {
  freshStorage();
  const a = browserId();
  const b = browserId();
  assert.equal(a, b, "the browser id changed between reads");
  assert.match(a, /^[a-z0-9-]{8,40}$/i);
  assert.doesNotMatch(a, /@|student|test/i);
});
