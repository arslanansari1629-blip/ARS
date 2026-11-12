/**
 * Today's classes — the unit tests for the reader.
 *
 * The feature is one sentence long ("show today's classes on every batch page")
 * and every interesting part of it is a decision about *time*, not about
 * fetching:
 *
 *   1. **A day is an IST day.** PW schedules against IST; a device in another
 *      timezone must not shift a class into yesterday.
 *   2. **`endTime` cannot be trusted on a scheduled class.** PW repeats the start
 *      time, so "is it happening now" has to come from the duration. Reading
 *      `endTime` alone makes every class either permanently live or instantly
 *      finished.
 *   3. **A refusal is not a quiet day.** If every listing refuses, the answer is
 *      `error`; a strip that says "no classes today" on a refusal is the quiet
 *      lie that makes a student miss the class.
 *   4. **Notices are not classes.** A resource subject holds PDFs; reading it
 *      spends a request on nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  dayKey,
  clockKey,
  parseDuration,
  classWindow,
  classStatus,
  fetchToday,
  SUBJECT_CAP,
} from "../lib/today.mjs";

const iso = (s) => new Date(s);

/* ------------------------------------------------------------------ clock */

test("a day is an IST day, wherever the device is", () => {
  // 2026-11-12T19:30Z is 01:00 on the 13th in IST. A reader in London and a
  // reader in Lucknow must agree about which day a class falls on, and the only
  // way to promise that is to stop asking the device.
  assert.equal(dayKey(iso("2026-11-12T19:30:00Z")), "2026-11-13");
  assert.equal(dayKey(iso("2026-11-12T18:29:00Z")), "2026-11-12");
  assert.equal(clockKey(iso("2026-11-12T05:00:00Z")), "10:30");
});

test("a bad date is answered with nothing, not with NaN", () => {
  assert.equal(dayKey("not a date"), "");
  assert.equal(clockKey("not a date"), "");
  assert.equal(clockKey(null), "");
});

test("durations are read the way the source writes them", () => {
  assert.equal(parseDuration("01:30:00"), 90 * 60 * 1000);
  assert.equal(parseDuration("45:00"), 45 * 60 * 1000);
  assert.equal(parseDuration("00:42:08"), (42 * 60 + 8) * 1000);
  assert.equal(parseDuration(""), 0);
  assert.equal(parseDuration(null), 0);
});

/* --------------------------------------------------------------- windows */

test("a repeated endTime does not make a class zero minutes long", () => {
  // This is what PW actually sends on a scheduled class: `endTime` copied from
  // `startTime`. Trusting it puts the class in the past the instant it begins.
  const row = {
    startTime: "2026-11-13T10:30:00.000Z",
    endTime: "2026-11-13T10:30:00.000Z",
    videoDetails: { duration: "01:30:00" },
  };
  const { start, end } = classWindow(row);
  assert.equal(start, Date.parse(row.startTime));
  assert.equal(end - start, 90 * 60 * 1000);
});

test("a real endTime is used when it is plausible", () => {
  const row = {
    startTime: "2026-11-13T10:30:00.000Z",
    endTime: "2026-11-13T12:08:18.083Z",
    videoDetails: { duration: "01:30:00" },
  };
  const { start, end } = classWindow(row);
  assert.equal(end, Date.parse(row.endTime));
});

test("an absurd endTime falls back to the duration", () => {
  // A week-long class is a data error, not a class. The cap keeps one bad row
  // from making every later class look finished.
  const row = {
    startTime: "2026-11-13T10:30:00.000Z",
    endTime: "2026-11-20T10:30:00.000Z",
    videoDetails: { duration: "01:00:00" },
  };
  assert.equal(classWindow(row).end - classWindow(row).start, 60 * 60 * 1000);
});

test("a class with no duration is given the usual slot", () => {
  const { start, end } = classWindow({ startTime: "2026-11-13T10:30:00.000Z" });
  assert.equal(end - start, 90 * 60 * 1000);
});

test("live, upcoming and finished are decided at the minute", () => {
  // 10:30Z is 16:00 IST — the class runs 16:00–17:00 Indian time.
  const row = {
    startTime: "2026-11-13T10:30:00.000Z",
    videoDetails: { duration: "01:00:00" },
  };
  const t = (s) => Date.parse(s);
  assert.equal(classStatus(row, t("2026-11-13T10:29:00Z")), "upcoming");
  assert.equal(classStatus(row, t("2026-11-13T10:30:00Z")), "live");
  assert.equal(classStatus(row, t("2026-11-13T11:29:00Z")), "live");
  assert.equal(classStatus(row, t("2026-11-13T11:30:00Z")), "done");
});

test("a row with no start time is unknown, not upcoming", () => {
  assert.equal(classStatus({}, Date.now()), "unknown");
});

/* ------------------------------------------------------------- the reader */

/** A probe standing in for `upstreamJson`, keyed by subject slug. */
function feeds(table) {
  const asked = [];
  const call = async (path) => {
    const slug = /\/subject\/([^/]+)\/contents/.exec(path)?.[1] || "";
    asked.push(slug);
    const hit = table[slug];
    if (!hit) return { ok: true, status: 200, data: { data: [] } };
    if (hit === "refuse") return { ok: false, status: 401, data: null, error: "401" };
    return { ok: true, status: 200, data: { data: hit } };
  };
  call.asked = asked;
  return call;
}

const SUBJECTS = [
  {
    name: "Physics",
    slug: "physics",
    teachers: [{ id: "t1", name: "Saleem Ahmad Sir" }],
  },
  { name: "Notices", slug: "notices", isResources: true },
];

const NOW = iso("2026-11-13T16:15:00Z"); // 21:45 IST

/**
 * Swap the module's upstream reader for a probe.
 *
 * `fetchToday` is written against `upstreamJson`; the substitution happens at the
 * module boundary rather than by threading a fetch through every call, so the
 * shape under test is the one production runs.
 */
async function withProbe(probe, fn) {
  const today = await import("../lib/today.mjs");
  const prev = today.__setUpstream;
  assert.equal(typeof prev, "function", "the module must expose its probe seam");
  prev(probe);
  try {
    return await fn(today);
  } finally {
    prev(null);
  }
}

test("today's classes are read from the subjects, live first", async () => {
  const rows = [
    {
      _id: "a",
      topic: "Units 12",
      startTime: "2026-11-13T15:00:00.000Z", // 20:30 IST, already over
      endTime: "2026-11-13T15:00:00.000Z",
      lectureType: "RECORDED",
      teachers: ["t1"],
      tags: [{ _id: "c1", name: "Units and Dimension" }],
      url: "https://x/master.mpd",
      videoDetails: { name: "Units 12", videoUrl: "https://x/master.mpd", duration: "01:00:00" },
    },
    {
      _id: "b",
      topic: "Units 13",
      startTime: "2026-11-13T16:00:00.000Z", // 21:30 IST, on now
      endTime: "2026-11-13T16:00:00.000Z",
      lectureType: "LIVE",
      teachers: ["t1"],
      url: "",
      videoDetails: { name: "Units 13", videoUrl: "", duration: "01:30:00" },
    },
    {
      _id: "c",
      topic: "Tomorrow",
      startTime: "2026-11-14T10:30:00.000Z",
      lectureType: "RECORDED",
      videoDetails: { name: "Tomorrow", duration: "01:00:00" },
    },
  ];

  const probe = feeds({ physics: rows });
  const day = await withProbe(probe, (m) => m.fetchToday("batch-1", { now: NOW, subjects: SUBJECTS }));

  assert.equal(day.state, "ok");
  assert.equal(day.day, "2026-11-13");
  // Two of the three are today; the third is tomorrow and belongs in `next`.
  assert.deepEqual(day.classes.map((c) => c.id), ["b", "a"]);
  assert.equal(day.classes[0].status, "live");
  assert.equal(day.classes[1].status, "done");
  assert.equal(day.next.id, "c");
  assert.equal(day.next.day, "2026-11-14");

  // A teacher arrives as an id and has to leave as a person.
  assert.equal(day.classes[0].teacher, "Saleem Ahmad Sir");
  assert.equal(day.classes[0].startClock, "21:30");
  assert.equal(day.classes[0].subject, "Physics");
  // A live class that has not been recorded has nothing to open.
  assert.equal(day.classes[0].hasStream, false);
  assert.equal(day.classes[1].hasStream, true);
});

test("a resource shelf is not read at all", async () => {
  const probe = feeds({});
  const day = await withProbe(probe, (m) => m.fetchToday("batch-1", { now: NOW, subjects: SUBJECTS }));
  assert.deepEqual(probe.asked, ["physics"], "Notices was read as if it held classes");
  assert.equal(day.state, "empty");
  assert.equal(day.scanned.subjects, 1);
});

test("a quiet day says when the next class is, not just that there is none", async () => {
  const probe = feeds({
    physics: [
      {
        _id: "n",
        topic: "Next week",
        startTime: "2026-11-16T10:30:00.000Z",
        lectureType: "RECORDED",
        videoDetails: { name: "Next week", duration: "01:00:00" },
      },
    ],
  });
  const day = await withProbe(probe, (m) => m.fetchToday("batch-1", { now: NOW, subjects: SUBJECTS }));
  assert.equal(day.state, "empty");
  assert.equal(day.classes.length, 0);
  assert.equal(day.next.id, "n");
});

test("every subject refusing is an error, never a quiet day", async () => {
  const probe = feeds({ physics: "refuse" });
  const day = await withProbe(probe, (m) => m.fetchToday("batch-1", { now: NOW, subjects: SUBJECTS }));
  assert.equal(day.state, "error", "a refusal was reported as an empty schedule");
  assert.equal(day.scanned.refused, 1);
});

test("one subject answering emptily is a quiet day, not an error", async () => {
  // The distinction the strip depends on: a listing that answers *nothing on
  // today* is evidence, while a listing that refuses is not.
  const day = await withProbe(feeds({ physics: [] }), (m) =>
    m.fetchToday("batch-1", { now: NOW, subjects: SUBJECTS })
  );
  assert.equal(day.state, "empty");
  assert.equal(day.scanned.refused, 0);
});

test("a batch with only notices has no classes and spends nothing", async () => {
  const probe = feeds({});
  const day = await withProbe(probe, (m) =>
    m.fetchToday("batch-1", {
      now: NOW,
      subjects: [{ name: "Notices", slug: "notices", isResources: true }],
    })
  );
  assert.equal(day.state, "none");
  assert.deepEqual(probe.asked, []);
});

test("the subject walk is capped, so a big batch cannot cost forty requests", () => {
  assert.ok(SUBJECT_CAP > 0 && SUBJECT_CAP <= 20, `a cap of ${SUBJECT_CAP} is not a cap`);
});

/* -------------------------------------------------------------- the strip */

// The renderer imports `./app.js`, which imports site-absolute paths; the loader
// shim maps those onto public/. Same seam the Khazana tests use.
const { register } = await import("node:module");
register("./loader.mjs", import.meta.url);
const { todayMarkup, mountToday } = await import("../public/assets/today.js");

const CLASSES = [
  {
    id: "b",
    title: "Units and Dimension 13 : Dimensional Analysis",
    subject: "Physics",
    subjectSlug: "physics",
    teacher: "Saleem Ahmad Sir",
    chapter: "Units and Dimension",
    start: "2026-11-13T16:00:00.000Z",
    startClock: "21:30",
    status: "live",
    hasStream: false,
    duration: "01:30:00",
  },
  {
    id: "c",
    title: "Units and Dimension 14",
    subject: "Physics",
    subjectSlug: "physics",
    teacher: "Saleem Ahmad Sir",
    start: "2026-11-13T18:00:00.000Z",
    startClock: "23:30",
    status: "upcoming",
    hasStream: true,
    duration: "01:00:00",
  },
];

const FINISHED = {
  id: "a",
  title: "Units and Dimension 12",
  subject: "Physics",
  subjectSlug: "physics",
  start: "2026-11-13T10:00:00.000Z",
  startClock: "15:30",
  status: "done",
  hasStream: true,
};

test("a live class is named as live, and not offered as a recording", () => {
  const html = todayMarkup({ state: "ok", day: "2026-11-13", classes: CLASSES }, { batchId: "b1" });
  assert.match(html, /Live now/);
  assert.match(html, /a class is/);
  // A class that is on now or still to come is something to attend. Offering
  // "Watch" sends a student to a player holding an empty stream, so neither row
  // may carry the link.
  assert.doesNotMatch(html, /today-open/, "a class that has not finished was offered as a recording");
});

test("a finished class with a recording is the one that opens", () => {
  const html = todayMarkup({ state: "ok", day: "2026-11-13", classes: [FINISHED] }, { batchId: "b1" });
  assert.match(html, /today-open/);
  const href = /href="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
  assert.match(href, /^\/lecture\.html\?/);
  assert.match(href, /batch=b1/);
  assert.match(href, /subject=physics/);
  assert.match(href, /id=a/);
});

test("a finished class with no recording says so instead of linking", () => {
  const html = todayMarkup(
    { state: "ok", day: "2026-11-13", classes: [{ ...FINISHED, hasStream: false }] },
    { batchId: "b1" }
  );
  assert.doesNotMatch(html, /today-open/);
  assert.match(html, /Recording pending/);
});

test("the time column is IST and says so", () => {
  const html = todayMarkup({ state: "ok", day: "2026-11-13", classes: CLASSES }, { batchId: "b1" });
  assert.match(html, /21:30/);
  assert.match(html, /IST/);
});

test("a quiet day is one line that names the next class", () => {
  const html = todayMarkup({
    state: "empty",
    day: "2026-11-13",
    classes: [],
    next: { start: "2026-11-16T10:30:00.000Z", startClock: "16:00", subject: "Physics" },
  });
  assert.match(html, /No classes published for today/);
  assert.match(html, /16 Nov 2026 at 16:00/);
  assert.doesNotMatch(html, /today-class/, "a quiet day drew class rows");
});

test("an unreachable source draws no strip at all", () => {
  // The whole point: no evidence must not look like a quiet day.
  assert.equal(todayMarkup({ state: "error", classes: [] }), "");
  assert.equal(todayMarkup({ state: "none", classes: [] }), "");
});

test("reading draws the shape it will take, so the page does not jump", () => {
  const html = todayMarkup(null, { reading: true });
  assert.match(html, /today-skeleton/);
  assert.match(html, /aria-busy="true"/);
});

test("mountToday asks the route and draws the answer", async () => {
  const asked = [];
  const host = { innerHTML: "" };
  const fetchImpl = async (url) => {
    asked.push(url);
    return { json: async () => ({ success: true, today: { state: "ok", day: "2026-11-13", classes: CLASSES } }) };
  };
  await mountToday(host, { batchId: "b1", fetchImpl });
  assert.equal(asked[0], "/api/batch?today=1&id=b1");
  assert.match(host.innerHTML, /today-class/);
});

test("mountToday leaves the host empty when the route fails", async () => {
  const host = { innerHTML: "stale" };
  const day = await mountToday(host, {
    batchId: "b1",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(host.innerHTML, "");
  assert.equal(day.state, "error");
});

test("a day that is over names the next class under it", () => {
  const html = todayMarkup(
    {
      state: "ok",
      day: "2026-11-13",
      classes: [FINISHED],
      next: { start: "2026-11-14T10:30:00.000Z", startClock: "16:00", subject: "Physics" },
    },
    { batchId: "b1" }
  );
  assert.match(html, /today-after/);
  assert.match(html, /14 Nov 2026 at 16:00/);
});

test("a day still in progress does not try to sell tomorrow", () => {
  const html = todayMarkup(
    {
      state: "ok",
      day: "2026-11-13",
      classes: CLASSES,
      next: { start: "2026-11-14T10:30:00.000Z", startClock: "16:00", subject: "Physics" },
    },
    { batchId: "b1" }
  );
  assert.doesNotMatch(html, /today-after/, "tomorrow was offered while today is still running");
});
