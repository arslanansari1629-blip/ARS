/**
 * Today's classes — the live-class strip on a batch page.
 *
 * ## Where the data comes from, and why it is read this way
 *
 * PW does publish a batch-level schedule after all — it is just not spelled
 * the way anyone guessed:
 *
 *     /v1/batches/<id>/todays-schedule?isNewStudyMaterialFlow=true
 *
 * That one endpoint answers a guest and carries the whole day: real
 * `startTime`/`endTime`, `status` (PENDING / COMPLETED / …), subject and
 * chapter, and it lists classes whose recording has not been published yet —
 * exactly the rows a "today" strip exists for. It is the primary source.
 *
 * The fallback is the per-subject contents listing, which is the same call
 * the chapter pages already make — every row in it carries `startTime`,
 * `lectureType` and `videoDetails.duration`. It is kept for the days the
 * schedule endpoint refuses or answers empty, and because it is the only
 * source that can name the *next* class after today.
 *
 * The listing walk is N requests for N subjects, which is why the answer is
 * cached hard (see `api/batch.mjs`) and why the subject walk is capped. A
 * batch with forty subjects must not cost forty upstream calls on every page
 * view — and on the days the schedule endpoint answers, it costs one.
 *
 * ## The clock
 *
 * PW schedules in IST. A "day" here is an IST day, computed from a `Date` so a
 * test can pin the clock instead of hoping it runs at the right hour — the
 * first version of this feature used the device's timezone, which made "Today's
 * class" wrong for anyone outside India and impossible to test.
 */

import { upstreamJson } from "./upstream.mjs";

/** Indian Standard Time — the clock every PW schedule is written against. */
export const TZ = "Asia/Kolkata";

/**
 * How many subjects a batch's day is worth reading.
 *
 * There is no batch-level schedule endpoint a guest can read, so a day costs one
 * listing per subject. Ten is the compromise: enough for every real batch (they
 * run 8–12 subjects) and bounded, because a batch with forty subjects must not
 * turn one page view into forty upstream calls. The listings themselves are
 * cached upstream-side for 90 seconds, so a page refresh is free.
 */
export const SUBJECT_CAP = Number(process.env.TODAY_SUBJECT_CAP || 10) || 10;

/** Parallel upstream reads. Enough to be quick, few enough to stay polite. */
const CONCURRENCY = 4;

/**
 * The upstream reader, swappable for a probe.
 *
 * `fetchToday` is about time, not transport, so the tests replace this rather
 * than threading a fetch through every call and testing a shape production does
 * not run. `null` restores the real reader.
 */
let readUpstream = upstreamJson;

/** Test seam: install a probe, or `null` to restore the real upstream. */
export function __setUpstream(probe) {
  readUpstream = probe || upstreamJson;
}

/** Assumed length when a class carries no duration (PW's usual slot). */
const DEFAULT_SLOT_MS = 90 * 60 * 1000;

/** `YYYY-MM-DD` for a moment, in IST. `en-CA` is the locale that spells it so. */
export function dayKey(date = new Date()) {
  if (date === undefined || date === null || date === "") return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** `hh:mm` (24h) for a moment, in IST. */
export function clockKey(date = new Date()) {
  // `new Date(null)` is the epoch, so a missing value has to be ruled out before
  // it is built — otherwise "no time" renders as 05:30 IST, which looks like a
  // schedule rather than an absence.
  if (date === undefined || date === null || date === "") return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * `"01:44:49"` → 6289000 ms.
 *
 * A duration is the honest way to decide whether a class is still running:
 * PW writes `endTime` equal to `startTime` on classes that have not happened
 * yet, so it cannot be trusted on its own.
 */
export function parseDuration(value) {
  const text = String(value || "").trim();
  // Three groups are hours:minutes:seconds (what PW sends); two are mm:ss, which
  // is how the same field is written for a short clip. Reading "45:00" as 45
  // hours put a class three days in the future.
  const three = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(text);
  if (three) return ((Number(three[1]) * 60 + Number(three[2])) * 60 + Number(three[3])) * 1000;
  const two = /^(\d{1,4}):([0-5]\d)$/.exec(text);
  if (two) return (Number(two[1]) * 60 + Number(two[2])) * 1000;
  return 0;
}

/** A row's scheduled window, in epoch ms. `end` is always after `start`. */
export function classWindow(row) {
  const start = Date.parse(row && (row.startTime || row.date)) || 0;
  if (!start) return { start: 0, end: 0 };
  const stated = Date.parse(row.endTime) || 0;
  const vd = (row && row.videoDetails) || {};
  const duration = parseDuration(vd.duration) || parseDuration(row.duration);
  // A stated end is used only when it looks like one: PW repeats the start time
  // on an unpublished class, and a class that ended the moment it began is not
  // a class that is over.
  const plausible = stated > start + 60 * 1000 && stated < start + 6 * 60 * 60 * 1000;
  const end = plausible ? stated : start + (duration || DEFAULT_SLOT_MS);
  return { start, end };
}

/** `live` while it is on, `upcoming` before, `done` after. */
export function classStatus(row, now = Date.now()) {
  const { start, end } = classWindow(row);
  if (!start) return "unknown";
  if (now < start) return "upcoming";
  if (now < end) return "live";
  return "done";
}

/**
 * Teacher names, from the ids a contents row carries.
 *
 * The listing sends `teachers: ["69ba7363…"]` — ids, not names. The batch
 * document carries the same ids with names attached, so they are read from
 * there rather than guessed at or dropped: "Mathematics · Priyam Mishra Sir"
 * is the thing that tells a student which class to attend.
 */
function teacherNames(ids, byId) {
  const out = [];
  for (const id of ids || []) {
    const key = typeof id === "string" ? id : id && (id._id || id.id);
    const name = key && byId.get(key);
    if (name) out.push(name);
  }
  return out;
}

/** One upstream row → the shape the strip renders. */
/**
 * Is this row an announcement rather than a class?
 *
 * PW cancels a class by retitling the row to "Class Cancelled: Due to some
 * issue" — it stays on its slot, keeps `lectureType: "LIVE"`, and carries no
 * status flag of any kind. Read literally it is a class starting at 16:10, so
 * the strip told a student to be there for a class that is not happening.
 *
 * Matched against the title and topic only, and only on the announcement's own
 * wording: a real class *about* something ("Chemical Reactions … Recorded")
 * never starts with the word "cancelled".
 */
export function isCancelled(row) {
  const vd = (row && row.videoDetails) || {};
  const text = [vd.name, row && row.topic].filter(Boolean).join(" ").toLowerCase();
  return /^\s*(class\s+)?(is\s+)?canc(ell)?ed\b/.test(text) || /\bcanc(ell)?ed\s*:/.test(text);
}

function toClass(row, subject, byId, now) {
  const { start, end } = classWindow(row);
  const vd = (row && row.videoDetails) || {};
  const tag = (row && Array.isArray(row.tags) && row.tags[0]) || null;
  return {
    id: row._id || "",
    title: String(vd.name || row.topic || "Class").trim(),
    subject: subject.name,
    subjectSlug: subject.slug,
    teacher: teacherNames(row.teachers, byId).join(", "),
    chapter: tag ? String(tag.name || "").trim() : "",
    chapterId: tag ? String(tag._id || "") : "",
    start: start ? new Date(start).toISOString() : "",
    end: end ? new Date(end).toISOString() : "",
    startClock: start ? clockKey(new Date(start)) : "",
    endClock: end ? clockKey(new Date(end)) : "",
    lectureType: String(row.lectureType || "").toUpperCase(),
    // A live class that has already been recorded carries a stream; one that has
    // not yet happened does not. That is the difference between "watch it" and
    // "be there", and the strip says which.
    hasStream: Boolean(vd.videoUrl || row.url),
    duration: String(vd.duration || "").trim(),
    status: classStatus(row, now),
    // A cancelled slot keeps its time, so it still sorts with the day; it just
    // stops claiming anyone should be there.
    cancelled: isCancelled(row),
  };
}

/**
 * Read one subject's listing. Never throws: a refusal is a counted outcome.
 *
 * `today=1&now=<epoch>` travel along for one reason: this read is a "what is on
 * today" query, and a fixture (or a mirror that understands it) has to know which
 * clock to answer against. The real upstream ignores both — it lists every class
 * in the subject, and the filtering happens below.
 */
async function subjectFeed(batchId, subject, nowMs) {
  const res = await readUpstream(
    `/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(
      subject.slug
    )}/contents?page=1&contentType=videos&today=1&now=${nowMs}`,
    { cacheSeconds: 90, timeout: 8000, attempts: 1 }
  );
  if (!res.ok) {
    const rows = (res.data && (res.data.data || res.data)) || null;
    return { ok: false, rows: Array.isArray(rows) ? rows : [], status: res.status || 0 };
  }
  // Two upstream generations bracket the list differently (see `fetchChapters`).
  const rows =
    (res.data && Array.isArray(res.data.data) && res.data.data) ||
    (res.data && Array.isArray(res.data.data?.data) && res.data.data.data) ||
    (Array.isArray(res.data) ? res.data : []);
  return { ok: true, rows, status: res.status || 200 };
}

/**
 * The batch's own schedule for today, in one request.
 *
 * Rows arrive as full schedule records: `batchSubjectId` names the batch's
 * subject (the join key into the batch document), `subjectId` carries the
 * generic subject, `status`/`tag` say where the class stands, and a
 * multi-cohort class appears once per cohort with a shared
 * `parentScheduleId` — one class, several rows, and the strip must show it
 * once. Never throws: a refusal is a counted outcome, and the listing walk
 * below is the fallback.
 */
async function scheduleFeed(batchId, bySubjectId, byId, ms, today) {
  const res = await readUpstream(
    // `now` travels for the same reason as on the listing read: a fixture (or a
    // mirror that understands it) has to know which clock to answer against.
    // The real upstream ignores it and answers for its own today.
    `/v1/batches/${encodeURIComponent(batchId)}/todays-schedule?isNewStudyMaterialFlow=true&now=${ms}`,
    { cacheSeconds: 30, timeout: 8000, attempts: 1 }
  ).catch(() => null);
  if (!res || !res.ok) return { ok: false, classes: [], rows: 0, cancelled: { count: 0, oldest: null } };
  const rows =
    (res.data && Array.isArray(res.data.data) && res.data.data) ||
    (Array.isArray(res.data) ? res.data : []);
  const seen = new Set();
  const classes = [];
  const cancelled = { count: 0, oldest: null };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.isVideoLecture === false) continue;
    const key = row.parentScheduleId || row._id || "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const subject = bySubjectId.get(row.batchSubjectId) || {
      name: String((row.subjectId && row.subjectId.name) || "").trim(),
      slug: "",
    };
    const cls = toClass(row, subject, byId, ms);
    // The endpoint answers for *its* today; a pinned clock (tests, a reader
    // near midnight) may be asking about another day entirely.
    if (!cls.start || dayKey(new Date(cls.start)) !== today) continue;
    if (cls.cancelled) {
      cancelled.count++;
      const start = Date.parse(cls.start);
      if (!cancelled.oldest || start < cancelled.oldest) cancelled.oldest = start;
    }
    // PW's own verdict outranks the clock: a class it marks COMPLETED/Ended
    // is over even if its stated window has not quite run out.
    if (/^(COMPLETED|ENDED|FINISHED)$/i.test(String(row.status || "")) || /^ended$/i.test(String(row.tag || ""))) {
      if (cls.status === "live") cls.status = "done";
    }
    // The schedule record leaves `videoUrl` empty even for a finished class
    // whose recording is published — the address only appears in the lecture
    // detail the player reads. "Ready" is PW saying the recording exists, so
    // a finished class with a Ready recording is a Watch link, not
    // "Recording pending". (Live/upcoming classes are untouched: the strip
    // never links those, whatever this says.)
    if (cls.status === "done" && /^ready$/i.test(String((row.videoDetails || {}).status || ""))) cls.hasStream = true;
    classes.push(cls);
  }
  return { ok: true, classes, rows: rows.length, cancelled };
}

/** Run `jobs` with at most `limit` in flight, preserving order. */
async function pool(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await job(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * A batch's classes for today, plus the next one after today.
 *
 * `state` is the verdict, and it distinguishes the four ways this can end:
 *
 *   `ok`      at least one class today (live, upcoming or finished)
 *   `empty`   the listings answered and nothing is scheduled today
 *   `error`   every subject refused — the source is not serving us, so "no class
 *             today" would be a claim we cannot make
 *   `none`    the batch has no subjects to read
 *
 * The distinction matters: a strip that says "no class today" when the upstream
 * refused is the kind of quiet lie that makes a student miss a class.
 */
export async function fetchToday(batchId, { now = new Date(), subjects = null, cap = SUBJECT_CAP } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  // `now` is a Date, an ISO string or an epoch number. An epoch number reaching
  // `new Date()` is read as *milliseconds* here — but only after the string case
  // has been ruled out, because `new Date("1794586500000")` is an Invalid Date
  // and would silently fall back to the wall clock, which is exactly the bug a
  // pinned clock exists to prevent.
  let ms;
  if (at instanceof Date && !Number.isNaN(at.getTime())) ms = at.getTime();
  else if (typeof now === "number" && Number.isFinite(now)) ms = now;
  else ms = Date.now();
  const today = dayKey(new Date(ms));

  const list = Array.isArray(subjects) ? subjects : [];
  // Notices and other resource shelves are batches within the batch: they hold
  // PDFs, not classes, and reading them would spend a request on nothing.
  const readable = list
    .filter((s) => s && s.slug && !s.isResources)
    .slice(0, Math.max(1, cap));

  if (!readable.length) {
    return {
      ok: true,
      state: "none",
      day: today,
      now: new Date(ms).toISOString(),
      classes: [],
      next: null,
      scanned: { subjects: 0, rows: 0, refused: 0 },
    };
  }

  const byId = new Map();
  for (const s of list) {
    for (const t of s.teachers || []) {
      if (!t || !t.name) continue;
      // The batch payload does not carry the teacher *id* on the normalised
      // subject, only the name — so ids are indexed from the raw ids when they
      // are there and skipped otherwise (the card simply omits the teacher).
      if (t.id) byId.set(t.id, t.name);
    }
  }

  // The batch's own schedule first: one request, the real day, classes whose
  // recordings are not published yet included. Only a refusal or an empty
  // answer earns the per-subject listing walk below (which is also the only
  // source that can name the next class after an empty day).
  const bySubjectId = new Map(list.filter((s) => s && s.id).map((s) => [s.id, s]));
  const sched = await scheduleFeed(batchId, bySubjectId, byId, ms, today);
  if (sched.ok && sched.classes.length) {
    const rank = { live: 0, upcoming: 1, done: 2, unknown: 3 };
    sched.classes.sort(
      (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || String(a.start).localeCompare(String(b.start))
    );
    return {
      ok: true,
      state: "ok",
      day: today,
      now: new Date(ms).toISOString(),
      classes: sched.classes,
      next: null,
      scanned: {
        subjects: readable.length,
        rows: sched.rows,
        refused: 0,
        fullyListed: true,
        cancelled: {
          count: sched.cancelled.count,
          oldest: sched.cancelled.oldest ? new Date(sched.cancelled.oldest).toISOString() : null,
        },
        source: "schedule",
      },
    };
  }

  const feeds = await pool(readable, CONCURRENCY, (s) =>
    subjectFeed(batchId, s, ms).catch(() => ({ ok: false, rows: [], status: 0 }))
  );

  const todayClasses = [];
  let nextClass = null;
  let rows = 0;
  let refused = 0;
  let noStart = 0;
  // Cancelled slots on any day, so `next` is not the thing just called off. A
  // slot that is cancelled *and* older than the earliest row we hold is off the
  // end of the listing, so nothing beyond that is known and a repeat of it
  // cannot be ruled out.
  const cancelled = { total: 0, oldest: null, latest: null };

  feeds.forEach((feed, i) => {
    if (!feed || !feed.ok) refused++;
    const subject = readable[i];
    for (const row of (feed && feed.rows) || []) {
      if (!row || typeof row !== "object") continue;
      const { start } = classWindow(row);
      if (!start) {
        noStart++;
        continue;
      }
      rows++;
      const cls = toClass(row, subject, byId, ms);
      if (cls.cancelled) {
        cancelled.total++;
        if (!cancelled.oldest || start < cancelled.oldest) cancelled.oldest = start;
        if (!cancelled.latest || start > cancelled.latest) cancelled.latest = start;
      }
      if (dayKey(new Date(start)) === today) {
        // `continue`, not `return`: this loop lives inside `forEach`, so a
        // `return` here abandons the rest of the subject's rows. It silently
        // listed the first class of the day and dropped every one after it.
        todayClasses.push(cls);
        continue;
      }
      if (cls.cancelled) continue;
      // Nothing today: the soonest future class is worth naming, because "next
      // class on Monday at 10:30" is useful and "nothing today" on its own is not.
      if (start > ms && (!nextClass || Date.parse(cls.start) < Date.parse(nextClass.start))) {
        nextClass = { ...cls, day: dayKey(new Date(start)) };
      }
    }
  });

  // Can we see far enough back to be sure a cancellation does not repeat a class
  // we are about to recommend? Every row here carries a start time, and one
  // cancelled slot means the listing was walked at least as far back as that
  // slot — so `next`, which is later than today, cannot be a repeat of it.
  // A row with no start time would break that reasoning, so it is not claimed.
  const fullyListed = cancelled.total === 0 || noStart === 0;

  // On air first, then the rest of the day in order: a student opening the page
  // at 10:35 wants the class that is happening, not the one that ended at 08:30.
  const rank = { live: 0, upcoming: 1, done: 2, unknown: 3 };
  todayClasses.sort(
    (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || String(a.start).localeCompare(String(b.start))
  );

  let state = "ok";
  if (!todayClasses.length) {
    // Every read refused → we do not know, and must not say "nothing today".
    if (refused === readable.length && !rows) state = "error";
    else state = "empty";
  }

  return {
    ok: true,
    state,
    day: today,
    now: new Date(ms).toISOString(),
    classes: todayClasses,
    next: nextClass,
    scanned: {
      subjects: readable.length,
      rows,
      refused,
      // `false` when a cancelled slot sits before the oldest row we hold: the
      // listing cannot be walked further back, so anything before that is
      // unknown and a repeat of that cancelled class cannot be ruled out.
      fullyListed,
      cancelled: { count: cancelled.total, oldest: cancelled.oldest ? new Date(cancelled.oldest).toISOString() : null },
      source: "listings",
    },
  };
}
