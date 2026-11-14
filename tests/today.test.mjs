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
  // The batch schedule is asked once, first (it is not addressed by subject);
  // the listing walk it falls back to must still never touch a resource shelf.
  assert.deepEqual(
    probe.asked.filter(Boolean),
    ["physics"],
    "Notices was read as if it held classes"
  );
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
  assert.match(href, /^\/watch\.html\?/);
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

/* ------------------------------------------------------- called-off classes */

/**
 * PW cancels a class by retitling the row. Nothing else changes: the slot keeps
 * its time, `lectureType` stays `LIVE`, and there is no status flag to read. So a
 * cancelled class is indistinguishable from a real one unless the title is read,
 * and a strip that does not read it tells a student to be somewhere at 16:10 for
 * a class that was called off — the single most expensive kind of wrong this
 * feature can be.
 */

const CANCEL_SUBJECTS = [
  {
    name: "Physics: Saleem Sir",
    slug: "physics-by-saleem-ahmad-sir-886822",
    teachers: [{ id: "t1", name: "Saleem Ahmad Sir" }],
  },
];

/** Read one physics subject's listing as if it were today's. */
const readDay = (rows, nowMs) =>
  withProbe(feeds({ "physics-by-saleem-ahmad-sir-886822": rows }), (m) =>
    m.fetchToday("anybatch", { now: nowMs, subjects: CANCEL_SUBJECTS })
  );

const row = (over) => ({
  _id: "r1",
  date: "2026-11-13T12:30:00Z",
  startTime: "2026-11-13T12:30:00Z",
  endTime: "2026-11-13T12:30:00Z",
  lectureType: "LIVE",
  topic: "Units and Dimension 11",
  videoDetails: { name: "Units and Dimension 11", duration: "01:30:00" },
  teachers: ["t1"],
  ...over,
});

test("a cancelled slot is recognised from the title, in every spelling PW uses", async () => {
  const { isCancelled } = await import("../lib/today.mjs");
  assert.equal(isCancelled(row({ topic: "Class Cancelled: Due to some issue", videoDetails: {} })), true);
  assert.equal(isCancelled(row({ topic: "Cancelled", videoDetails: {} })), true);
  assert.equal(isCancelled(row({ topic: "cancelled : due to rain", videoDetails: {} })), true);
  // A real class is not a cancellation, however the words fall.
  assert.equal(isCancelled(row({ topic: "Chemical Reactions and Equations 2 : Recorded" })), false);
  assert.equal(isCancelled(row({ topic: "Electromagnetic Induction", videoDetails: { name: "Electromagnetic Induction" } })), false);
  assert.equal(isCancelled(null), false);
});

test("a cancelled class is still listed, marked off, and keeps its slot", async () => {
  const out = await readDay(
    [
      row({ _id: "off", topic: "Class Cancelled: Due to some issue", videoDetails: { duration: "" } }),
      row({ _id: "on", startTime: "2026-11-13T13:30:00Z", date: "2026-11-13T13:30:00Z", topic: "Units 12" }),
      row({ _id: "later", startTime: "2026-11-13T15:00:00Z", date: "2026-11-13T15:00:00Z", topic: "Units 13" }),
    ],
    "2026-11-13T09:00:00Z"
  );

  assert.equal(out.state, "ok");
  assert.equal(out.classes.length, 3, "a called-off class still happened on the calendar");
  const off = out.classes.find((c) => c.id === "off");
  assert.equal(off.cancelled, true);
  assert.equal(off.startClock, "18:00", "the slot keeps its time; only the promise goes");
  // Every row is today, so there is no *later* class to name — the cancelled one
  // must not become it either.
  assert.equal(out.next, null);
  assert.equal(out.scanned.cancelled.count, 1);
  assert.equal(out.scanned.fullyListed, true);
});

test("a cancelled slot never becomes the next class", async () => {
  // Tomorrow holds a cancelled class and, later the same day, a real one. The
  // next class worth naming is the real one.
  const out = await readDay(
    [
      row({
        _id: "off",
        startTime: "2026-11-14T05:00:00Z",
        date: "2026-11-14T05:00:00Z",
        topic: "Class Cancelled: Due to some issue",
        videoDetails: { duration: "" },
      }),
      row({ _id: "real", startTime: "2026-11-14T09:30:00Z", date: "2026-11-14T09:30:00Z", topic: "Units 14" }),
    ],
    "2026-11-13T09:00:00Z"
  );
  assert.equal(out.state, "empty", "nothing today");
  assert.equal(out.next.id, "real");
  assert.equal(out.next.startClock, "15:00");
});

test("a listing that could not be walked to the start does not claim it saw every cancellation", async () => {
  // A row with no start time cannot be placed in the day, which also means the
  // listing holds something earlier than anything we read — so a class we are
  // about to recommend might be the repeat of a cancelled one. The route says so
  // rather than guessing.
  const out = await readDay(
    [
      row({ _id: "off", topic: "Class Cancelled: Due to some issue", videoDetails: { duration: "" } }),
      row({ _id: "undated", date: "", startTime: "", endTime: "", topic: "Unscheduled" }),
    ],
    "2026-11-13T09:00:00Z"
  );
  assert.equal(out.scanned.fullyListed, false);
});

test("a day of nothing but cancellations still says it had a class", async () => {
  // "No classes today" would be wrong twice over: there was a class, and it was
  // called off. The count line carries both halves.
  const out = await readDay(
    [row({ _id: "off", topic: "Class Cancelled: Due to some issue", videoDetails: { duration: "" } })],
    "2026-11-13T09:00:00Z"
  );
  const { todayMarkup } = await import("../public/assets/today.js");
  const html = todayMarkup(out, { batchId: "b" });
  assert.match(html, /1 class called off today/);
  assert.match(html, /Called off/);
  assert.doesNotMatch(html, /Upcoming/, "a called-off class must not read as upcoming");
  assert.doesNotMatch(html, /Live now/);
  assert.doesNotMatch(html, /today-open/, "no link: there is nothing to open");
});

test("the count line says both halves on a mixed day", async () => {
  const { todayMarkup } = await import("../public/assets/today.js");
  const html = todayMarkup(
    {
      state: "ok",
      day: "2026-11-13",
      classes: [
        { id: "a", title: "Units 12", status: "upcoming", startClock: "15:00" },
        { id: "b", title: "Class Cancelled: Due to some issue", status: "upcoming", startClock: "16:00", cancelled: true },
      ],
      next: null,
    },
    { batchId: "b" }
  );
  assert.match(html, /1 class published today · 1 called off/);
});

test("every class the strip can emit has a rule that draws it", async () => {
  // The failure this guards is quiet: a new tone without CSS renders as an
  // unstyled row that looks like a layout bug on fourteen thousand pages.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const css = await readFile(path.join(import.meta.dirname, "..", "public", "assets", "arsvibe.css"), "utf8");
  for (const sel of [".today-class.is-off", ".today-badge.is-off", ".today-class.is-live", ".today-after"]) {
    // Either the class itself or something scoped by it counts as a rule.
    const hit = new RegExp(`${sel.replace(/\./g, "\\.")}(\\s|\\{|,|\\.)`).test(css);
    assert.ok(hit, `${sel} has no rule`);
  }
});

test("a finished day names the next class, and an empty day does too", async () => {
  const { todayMarkup } = await import("../public/assets/today.js");
  const next = { start: "2026-11-16T05:00:00Z", startClock: "10:30", subject: "Physics", teacher: "Saleem Sir" };
  const done = todayMarkup(
    { state: "ok", day: "2026-11-13", classes: [{ id: "a", title: "Units 12", status: "done", startClock: "10:00" }], next },
    { batchId: "b" }
  );
  assert.match(done, /today-after/);
  assert.match(done, /Physics · Saleem Sir/);

  const empty = todayMarkup({ state: "empty", day: "2026-11-13", classes: [], next }, { batchId: "b" });
  assert.match(empty, /No classes published for today/);
  assert.match(empty, /Next:/, "an empty day's useful half is when the next class is");
  assert.doesNotMatch(empty, /No further classes are published/);
});

test("the batch schedule endpoint is the primary source, read once", async () => {
  // One request carries the whole day — including a class whose recording is
  // not published yet, which the listing walk can only see once PW lists it.
  // A multi-cohort class arrives once per cohort under one parentScheduleId
  // and must appear once; PW's COMPLETED verdict ends a class even inside
  // its stated window.
  const asked = [];
  const probe = async (path) => {
    asked.push(path);
    if (path.includes("/todays-schedule")) {
      return {
        ok: true,
        status: 200,
        data: {
          data: [
            {
              _id: "s1",
              parentScheduleId: "s1",
              batchSubjectId: "subj-physics",
              topic: "Units 20 : Live Class",
              startTime: "2026-11-13T16:00:00.000Z",
              endTime: "2026-11-13T16:00:00.000Z",
              lectureType: "LIVE",
              status: "PENDING",
              teachers: ["t1"],
              tags: [{ _id: "c1", name: "Units and Dimension" }],
              videoDetails: { name: "Units 20 : Live Class", videoUrl: "", duration: "01:30:00" },
              isVideoLecture: true,
            },
            {
              // Same class, second cohort: identical parent, different row id.
              _id: "s1-cohort-b",
              parentScheduleId: "s1",
              batchSubjectId: "subj-physics",
              topic: "Units 20 : Live Class",
              startTime: "2026-11-13T16:00:00.000Z",
              endTime: "2026-11-13T16:00:00.000Z",
              lectureType: "LIVE",
              status: "PENDING",
              teachers: ["t1"],
              videoDetails: { name: "Units 20 : Live Class", videoUrl: "", duration: "01:30:00" },
              isVideoLecture: true,
            },
            {
              _id: "s2",
              parentScheduleId: "s2",
              batchSubjectId: "subj-physics",
              topic: "Units 19 : Finished Early",
              startTime: "2026-11-13T15:30:00.000Z",
              endTime: "2026-11-13T17:30:00.000Z",
              lectureType: "LIVE",
              status: "COMPLETED",
              tag: "Ended",
              teachers: ["t1"],
              videoDetails: { name: "Units 19 : Finished Early", videoUrl: "", status: "Ready", duration: "02:00:00" },
              isVideoLecture: true,
            },
          ],
        },
      };
    }
    return { ok: true, status: 200, data: { data: [] } };
  };
  const subjects = [
    { id: "subj-physics", name: "Physics", slug: "physics", teachers: [{ id: "t1", name: "Saleem Ahmad Sir" }] },
  ];
  const day = await withProbe(probe, (m) => m.fetchToday("batch-1", { now: NOW, subjects }));
  assert.equal(day.state, "ok");
  assert.equal(day.scanned.source, "schedule");
  assert.equal(day.classes.length, 2, "a multi-cohort class must appear once");
  assert.equal(day.classes[0].status, "live");
  assert.equal(day.classes[0].subject, "Physics");
  assert.equal(day.classes[0].teacher, "Saleem Ahmad Sir");
  assert.equal(day.classes[1].status, "done", "PW's COMPLETED verdict must outrank the stated window");
  // The schedule record carries no videoUrl even for a published recording;
  // its "Ready" status is the tell, and it is what makes the row a Watch link.
  assert.equal(day.classes[1].hasStream, true, "a finished class with a Ready recording must be watchable");
  assert.equal(
    asked.filter((p) => p.includes("/contents")).length,
    0,
    "an answered schedule must not spend the per-subject listing walk"
  );
});

test("a refused schedule falls back to the subject listings", async () => {
  const probe = async (path) => {
    if (path.includes("/todays-schedule")) return { ok: false, status: 401, data: null, error: "401" };
    const slug = /\/subject\/([^/]+)\/contents/.exec(path)?.[1] || "";
    if (slug === "physics") {
      return {
        ok: true,
        status: 200,
        data: {
          data: [
            {
              _id: "L1",
              topic: "Units 21",
              startTime: "2026-11-13T16:00:00.000Z",
              endTime: "2026-11-13T16:00:00.000Z",
              lectureType: "LIVE",
              teachers: ["t1"],
              videoDetails: { name: "Units 21", videoUrl: "", duration: "01:30:00" },
            },
          ],
        },
      };
    }
    return { ok: true, status: 200, data: { data: [] } };
  };
  const day = await withProbe(probe, (m) => m.fetchToday("batch-1", { now: NOW, subjects: SUBJECTS }));
  assert.equal(day.state, "ok");
  assert.equal(day.scanned.source, "listings");
  assert.equal(day.classes.length, 1);
  assert.equal(day.classes[0].status, "live");
});
