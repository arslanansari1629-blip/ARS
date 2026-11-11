/**
 * Content audit — walk a batch and report what does not play.
 *
 * Every other route in this project answers a question about *one* thing:
 * `api/check` proves a lecture plays, `api/contents` lists a chapter,
 * `api/stream` resolves a plan. None of them answers the question an operator
 * actually has, which is "of these fourteen thousand batches, which lectures are
 * broken right now, and why".
 *
 * This is that answer. It walks a batch's subjects and chapters, resolves a
 * stream for each lecture through the same `resolveStream` the player uses, and
 * classifies every lecture into a state that says what to *do* about it:
 *
 *   plays      — a signed, playable plan exists
 *   pending    — the recording is not published yet (a live class, an upcoming
 *                one); nothing to fix, and the site already says so
 *   no-stream  — the lecture exists and has a video URL, but nothing signs it
 *   broken     — the lecture exists in the schedule with no usable URL
 *   unknown    — the schedule could not be read at all
 *
 * The classification matters more than the count. "412 lectures not playing"
 * is a panic; "399 pending, 0 broken, 13 signing refusals" is a work order. The
 * whole design of this module is to keep those apart.
 *
 * Cost control is the other constraint: a batch can hold hundreds of lectures,
 * and each one is three upstream calls. So an audit is bounded by `limit`, runs
 * a few lectures at a time, and reports how much of the batch it actually saw
 * rather than implying completeness.
 */

import {
  fetchBatch,
  fetchChapters,
  fetchChapterContents,
  fetchSchedule,
  resolveStream,
} from "./api-data.mjs";

/** How many lectures to resolve at once. Three is polite to the signers. */
const AUDIT_CONCURRENCY = 3;

/** The states a lecture can be in, worst last. */
export const AUDIT_STATES = ["plays", "pending", "no-stream", "broken", "unknown"];

/**
 * Why a lecture did not play, in one line an operator can act on.
 *
 * The strings come from `resolveStream`, which already distinguishes "the
 * source has not published this yet" from "the signer refused us" — the audit
 * must not collapse that distinction back into a shrug.
 */
function classify({ rawUrl, plan, scheduleError, videoStatus = "" }) {
  if (plan && plan.playable) {
    return {
      state: "plays",
      detail: "",
      quality: plan.quality || "",
      renditions: plan.renditions || [],
    };
  }

  const reason = String((plan && plan.reason) || scheduleError || "").trim();

  // No video URL at all from the schedule. That is `pending` when the source
  // says so (a live class or an unprocessed recording) and `broken` when it
  // does not — an entry with no URL and no explanation is a data problem.
  //
  // There is no resolver plan in this branch, so there is no `reason` either:
  // the only witness is the schedule's own `videoStatus`. Reading it here is the
  // difference between "412 lectures not playing" and "399 of them are simply
  // not recorded yet", and the panel is worthless without that distinction.
  if (!rawUrl) {
    const notReady = /not[\s-]?ready|unpublished|pending|upcoming|live|processing|scheduled/i.test(
      String(videoStatus || "")
    );
    const pending = notReady || /not published|upcoming|live class|processing|recording|no video/i.test(reason);
    return {
      state: pending ? "pending" : scheduleError ? "unknown" : "broken",
      detail:
        reason ||
        (notReady
          ? `The source marks this lecture "${videoStatus}" — it has not published the recording yet.`
          : "The lecture has no video URL and the source did not say why."),
      quality: "",
      renditions: [],
    };
  }

  // A URL exists. If signing refused, that is a real fault the operator can
  // chase (an expired credential, a dead mirror); if the source says the
  // recording is not ready, it is not.
  const pending = /not published|upcoming|live class|processing|not been published/i.test(reason);
  return {
    state: pending ? "pending" : "no-stream",
    detail: reason || "The lecture has a video URL but no rendition answered.",
    quality: "",
    renditions: [],
  };
}

/**
 * Audit one lecture. Never throws: a lecture that cannot be read is a result,
 * not an exception, because one bad entry must not end a batch sweep.
 */
export async function auditLecture({ batch, subject, id, title = "" }, { fresh = false } = {}) {
  let rawUrl = "";
  let scheduleError = "";
  let detail = {};

  try {
    const sched = await fetchSchedule(batch, subject, id);
    detail = (sched && sched.lecture) || {};
    rawUrl = detail.videoUrl || "";
    if (!sched.ok) scheduleError = sched.error || "The schedule could not be read.";
  } catch (err) {
    scheduleError = err?.message || "The schedule could not be read.";
  }

  let plan = null;
  if (rawUrl) {
    try {
      // Deliberately no `folder`: that argument means "I already know the video
      // folder, skip the schedule", and it short-circuits the probe into the
      // cached rendition ladder for *whatever* folder id is passed. The audit
      // has just read the real URL, so it lets the resolver read the folder out
      // of it — the same path the player takes, which is the point of an audit.
      plan = await resolveStream({ rawUrl, fresh });
    } catch (err) {
      plan = { playable: false, reason: err?.message || "The stream could not be resolved." };
    }
  }

  const verdict = classify({
    rawUrl,
    plan,
    scheduleError,
    videoStatus: detail.videoStatus || "",
  });
  return {
    id,
    title: title || detail.title || "",
    topic: detail.title || title || "",
    // `videoStatus` is what the source calls "Ready" / "Not Ready"; the audit
    // reports it verbatim so a `broken` verdict can be read against it.
    status: detail.videoStatus || "",
    duration: Number(detail.duration) || 0,
    drm: Boolean(detail.drm),
    hasVideoUrl: Boolean(rawUrl),
    ...verdict,
  };
}

/**
 * Walk a batch's subjects and chapters and audit what it contains.
 *
 * @param {object} opts
 * @param {string} opts.batch         batch id
 * @param {number} [opts.limit]       max lectures to resolve (cost control)
 * @param {string} [opts.subject]     restrict to one subject slug
 * @param {string} [opts.chapter]     restrict to one chapter id
 * @param {Function} [opts.onProgress] called after each lecture, for streaming
 * @returns {Promise<object>} a report, never a throw
 */
export async function auditBatch({
  batch,
  limit = 40,
  subject = "",
  chapter = "",
  onProgress = null,
} = {}) {
  if (!batch) {
    return { ok: false, error: "A batch id is required.", subjects: [], lectures: [] };
  }

  const max = Math.max(1, Math.min(400, Number(limit) || 40));
  const notes = [];

  let info = null;
  try {
    info = await fetchBatch(batch);
  } catch (err) {
    notes.push(`The batch details could not be read (${err?.message || "unknown error"}).`);
  }

  const subjects = (info && info.subjects) || [];
  const wanted = subject ? subjects.filter((s) => s.slug === subject) : subjects;

  if (!subjects.length) {
    // A batch whose detail call failed can still be audited if the caller named
    // a subject, because the chapter listing only needs the slug.
    if (!subject) {
      return {
        ok: false,
        batch,
        name: (info && info.name) || "",
        error: notes[0] || "No subjects were listed for this batch.",
        notes,
        subjects: [],
        lectures: [],
        totals: zeroTotals(),
      };
    }
    wanted.push({ slug: subject, name: subject, id: "" });
  }

  const lectures = [];
  const subjectReports = [];
  let stopped = false;

  for (const s of wanted) {
    if (stopped) break;
    const chapters = chapter
      ? [{ id: chapter, name: "" }]
      : await listChapters(batch, s.slug, notes);

    const subjectReport = {
      slug: s.slug,
      name: s.name || s.slug,
      chapters: chapters.length,
      lectures: 0,
      plays: 0,
      pending: 0,
    };

    for (const c of chapters) {
      if (stopped) break;
      const listed = await listLectures(batch, s.slug, c.id, notes);
      subjectReport.lectures += listed.length;

      for (const lec of listed) {
        if (lectures.length >= max) {
          stopped = true;
          break;
        }
        const result = await auditLecture({
          batch,
          subject: s.slug,
          id: lec.id,
          title: lec.title,
        });
        result.chapter = c.id;
        result.chapterName = c.name || "";
        result.subject = s.slug;
        result.subjectName = subjectReport.name;
        lectures.push(result);
        if (onProgress) {
          // A progress callback must never break the audit.
          try {
            onProgress(result, lectures.length, max);
          } catch {
            /* ignore */
          }
        }
      }
    }

    subjectReport.plays = lectures.filter(
      (l) => l.subject === s.slug && l.state === "plays"
    ).length;
    subjectReport.pending = lectures.filter(
      (l) => l.subject === s.slug && l.state === "pending"
    ).length;
    subjectReports.push(subjectReport);
  }

  const totals = zeroTotals();
  for (const l of lectures) totals[l.state] = (totals[l.state] || 0) + 1;
  totals.lectures = lectures.length;
  totals.healthy = totals.lectures > 0 && totals.plays === totals.lectures;

  // What the operator should *do*, which is the part that saves them reading
  // forty rows. Only the actionable states appear here.
  const actionable = lectures.filter((l) => l.state === "no-stream" || l.state === "broken");
  if (actionable.length) {
    const first = actionable[0];
    notes.push(
      `${actionable.length} lecture${actionable.length > 1 ? "s" : ""} need attention. ` +
        `Start with ${first.title || first.id}: ${first.detail}`
    );
  }
  if (totals.pending) {
    notes.push(
      `${totals.pending} lecture${totals.pending > 1 ? "s are" : " is"} not published yet — live classes or recordings the source has not released. Nothing to fix.`
    );
  }
  if (stopped) {
    notes.push(`Stopped after ${lectures.length} lectures (limit ${max}). Raise &limit= to audit more.`);
  }

  return {
    ok: true,
    batch,
    name: (info && info.name) || "",
    checkedAt: new Date().toISOString(),
    subjects: subjectReports,
    totals,
    lectures,
    notes,
    truncated: stopped,
  };
}

function zeroTotals() {
  const totals = { lectures: 0, healthy: false };
  for (const state of AUDIT_STATES) totals[state] = 0;
  return totals;
}

/** Chapters for a subject, degrading to a note rather than a throw. */
async function listChapters(batch, subjectSlug, notes) {
  try {
    const res = await fetchChapters(batch, subjectSlug);
    if (!res.ok) {
      notes.push(`${subjectSlug}: chapters could not be read (${res.error || "no reason given"}).`);
      return [];
    }
    return (res.chapters || []).map((c) => ({ id: c.id, name: c.name }));
  } catch (err) {
    notes.push(`${subjectSlug}: chapters could not be read (${err?.message || "unknown error"}).`);
    return [];
  }
}

/** Lectures (videos only) inside a chapter, degrading to a note. */
async function listLectures(batch, subjectSlug, chapterId, notes) {
  try {
    const res = await fetchChapterContents(batch, subjectSlug, chapterId, "videos");
    if (!res.ok) {
      // An empty chapter is normal — eight Physics chapters in the reference
      // batch are genuinely empty — so this is a note, not a fault.
      if (!res.auth) notes.push(`${chapterId}: ${res.error || "no lectures listed"}`);
      return [];
    }
    return (res.items || [])
      .filter((i) => i && i.id)
      .map((i) => ({ id: i.id, title: i.name || i.title || "" }));
  } catch (err) {
    notes.push(`${chapterId}: lectures could not be listed (${err?.message || "unknown error"}).`);
    return [];
  }
}

/** One-line summary of a report, for logs and the panel's headline. */
export function auditHeadline(report) {
  if (!report || !report.ok) return report?.error || "Audit failed.";
  const t = report.totals || {};
  if (!t.lectures) return "No lectures were found to audit.";
  const parts = [`${t.plays}/${t.lectures} playing`];
  if (t.pending) parts.push(`${t.pending} not published yet`);
  if (t["no-stream"]) parts.push(`${t["no-stream"]} refused by the signer`);
  if (t.broken) parts.push(`${t.broken} with no video`);
  if (t.unknown) parts.push(`${t.unknown} unreadable`);
  return parts.join(" · ");
}
