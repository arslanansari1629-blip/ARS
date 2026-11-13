/* =========================================================================
   Today's classes — the live-class strip above a batch's tabs.

   The server reads the batch's own schedule endpoint (with the per-subject
   contents listings as fallback — see `lib/today.mjs`) and keeps the rows
   that fall on today; this module draws them, then re-reads once a minute
   while the page is open so "Upcoming" becomes "Live now" on its own.

   Two things it deliberately does not do:

   1. **It does not guess.** A class with no published recording is "upcoming",
      not "watch" — the difference between *be there at 10:30* and *this is on
      demand* is the whole value of the strip.
   2. **It does not claim a quiet day it cannot see.** When every subject refused,
      the route says `error` and the strip stays out of the way rather than
      printing "no classes today", which would be a claim about the source made
      on no evidence.
   ========================================================================= */

import { esc, fmtDate } from "./app.js";

/** The verdicts the route can answer, worded once so the two cannot drift. */
export const TODAY_STATES = {
  ok: { tone: "good" },
  empty: { tone: "quiet" },
  error: { tone: "warn" },
  none: { tone: "quiet" },
};

/** A schedule time is always IST — say so once, in the markup, not per row. */
const TZ_LABEL = "IST";

/**
 * What the row offers: a class to attend, or a recording to open.
 *
 * Status decides first, and the stream only decides for a class that is already
 * over. A class that is on now or still to come is something to *attend* — that
 * is what its schedule means — even when the source has already published a
 * recording alongside it. Offering "Watch" on a class that has not happened
 * would send a student to a player holding an empty stream.
 */
function action(c, batchId) {
  if (c.cancelled) {
    return `<span class="today-badge is-off">Called off</span>`;
  }
  if (c.status === "live") {
    return `<span class="today-badge is-live">Live now</span>`;
  }
  if (c.status === "upcoming") {
    return `<span class="today-badge is-next">Upcoming</span>`;
  }
  if (c.hasStream) {
    const href =
      `/lecture.html?batch=${encodeURIComponent(batchId)}` +
      `&subject=${encodeURIComponent(c.subjectSlug || "")}` +
      `&id=${encodeURIComponent(c.id || "")}` +
      `&title=${encodeURIComponent(c.title || "")}`;
    return `<a class="today-open" href="${href}">Watch</a>`;
  }
  return `<span class="today-badge">Recording pending</span>`;
}

function classRow(c, batchId) {
  const who = [c.subject, c.teacher].filter(Boolean).join(" · ");
  const meta = [who, c.chapter].filter(Boolean).join(" · ");
  // A cancelled slot keeps its time but not its promise: it is drawn as the
  // announcement it is, never with a live badge and never with a Watch link.
  const tone = c.cancelled ? "off" : c.status || "upcoming";
  return `
    <li class="today-class is-${esc(tone)}">
      <span class="today-clock">
        <b>${esc(c.startClock || "")}</b>
        <i>${TZ_LABEL}</i>
      </span>
      <span class="today-body">
        <span class="today-title">${esc(c.title)}</span>
        <span class="today-meta">${esc(meta)}</span>
      </span>
      ${action(c, batchId)}
    </li>`;
}

/**
 * "Monday, 4 May at 10:30 IST — Physics · Saleem Sir", or "" when unknown.
 *
 * One builder for both places it is needed: the tail of a finished day and the
 * quiet line of an empty one. Two copies would drift apart.
 */
function nextText(next) {
  if (!next || !next.start) return "";
  const when = `${fmtDate(next.start)}${next.startClock ? ` at ${next.startClock} ${TZ_LABEL}` : ""}`;
  const what = [next.subject, next.teacher].filter(Boolean).join(" · ");
  return { when, what };
}

/**
 * What comes after today, once today is over.
 *
 * A day that has finished is still the right thing to show — it is what the page
 * is about — but on its own it leaves a student looking at three classes they
 * cannot attend and no idea when the next one is. This adds that one line, and
 * only when every class on the strip is already over: while anything is live or
 * still to come, "next" would be competing with the class that matters now.
 */
function afterDay(d, classes, state) {
  const pending = classes.some((c) => !c.cancelled && (c.status === "live" || c.status === "upcoming"));
  if (pending) return "";
  // An empty day still wants the next class — that is the useful half of it.
  if (!classes.length && state !== "empty") return "";
  const next = nextText(d.next);
  if (!next) return "";
  return `<div class="today-after">Next: <b>${esc(next.when)}</b>${next.what ? ` — ${esc(next.what)}` : ""}</div>`;
}

/**
 * How to describe the day's size.
 *
 * A day of "3 classes" where one of the three was called off overstates it, and
 * quietly dropping the cancelled one would hide the reason a student missed a
 * class. Both halves are said.
 */
function countLine(classes) {
  const off = classes.filter((c) => c.cancelled).length;
  const on = classes.length - off;
  const noun = (n) => `${n} class${n === 1 ? "" : "es"}`;
  if (!off) return `${noun(classes.length)} published today`;
  if (!on) return `${noun(off)} called off today`;
  return `${noun(on)} published today · ${off} called off`;
}

/**
 * The strip.
 *
 * `reading` draws the shape it will take, so the page does not jump when the day
 * lands. Everything else is a verdict: a list of classes, or one quiet line that
 * says there are none and when the next one is.
 */
export function todayMarkup(day, { reading = false, batchId = "" } = {}) {
  if (reading) {
    return `
      <section class="today-strip is-reading" aria-busy="true">
        <div class="today-head">
          <span class="today-eyebrow">Live · today</span>
        </div>
        <div class="today-skeleton" aria-hidden="true"></div>
      </section>`;
  }

  const d = day || {};
  const state = String(d.state || "none");
  const classes = Array.isArray(d.classes) ? d.classes : [];

  if (state === "ok" && classes.length) {
    const live = classes.filter((c) => c.status === "live").length;
    const eyebrow = live ? `Live · ${live === 1 ? "a class is" : `${live} classes are`} on now` : "Live · today";
    return `
      <section class="today-strip${live ? " is-on-air" : ""}">
        <div class="today-head">
          <span class="today-eyebrow">${esc(eyebrow)}</span>
          ${d.day ? `<span class="today-day">${esc(fmtDate(`${d.day}T00:00:00+05:30`))}</span>` : ""}
          <span class="today-count">${countLine(classes)}</span>
        </div>
        <ul class="today-list">${classes.map((c) => classRow(c, batchId)).join("")}</ul>
        ${afterDay(d, classes, state)}
      </section>`;
  }

  if (state === "empty") {
    // One line, not a panel: an empty day is ordinary, and 14,000 batch pages
    // must not each open with an apology. The next class is the useful half.
    const next = nextText(d.next);
    // Deliberately "published", not "scheduled". The only surface a guest can
    // read lists the classes the source has *created*; a slot PW has not
    // published yet is invisible here, and claiming there is nothing else would
    // be a claim about a calendar we cannot see.
    const when = next
      ? `Next: <b>${esc(next.when)}</b>${next.what ? ` — ${esc(next.what)}` : ""}`
      : "No further classes are published in this batch yet.";
    return `
      <section class="today-strip is-quiet">
        <div class="today-head">
          <span class="today-eyebrow">Live</span>
          <span class="today-day">No classes published for today</span>
          <span class="today-next">${when}</span>
        </div>
      </section>`;
  }

  // `error` and `none`: no strip. An unreachable source is not a quiet day, and
  // saying nothing is more honest than inventing an emptiness.
  return "";
}

/**
 * Fill a host element with the strip, or empty it.
 *
 * Returns the verdict it drew so the page can decide whether the section behind
 * it needs to exist at all.
 */
export async function mountToday(host, { batchId = "", fetchImpl, refreshMs = 60000 } = {}) {
  if (!host) return null;
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const read = async () => {
    const res = await doFetch(`/api/batch?today=1&id=${encodeURIComponent(batchId)}`);
    const data = await res.json();
    return (data && data.today) || { state: "error" };
  };

  host.innerHTML = todayMarkup(null, { reading: true });
  try {
    const day = await read();
    host.innerHTML = todayMarkup(day, { batchId });
    // A batch page can sit open across a class boundary: without a re-read the
    // strip would keep calling a started class "Upcoming" until a manual
    // reload — the one moment the strip exists for. Refresh quietly (no
    // skeleton, no layout jump), only while the page is actually visible,
    // and stop when the host leaves the document.
    if (refreshMs > 0 && typeof setInterval === "function") {
      if (host.__todayTimer) clearInterval(host.__todayTimer);
      host.__todayTimer = setInterval(async () => {
        if (!host.isConnected) {
          clearInterval(host.__todayTimer);
          host.__todayTimer = null;
          return;
        }
        if (typeof document !== "undefined" && document.hidden) return;
        try {
          host.innerHTML = todayMarkup(await read(), { batchId });
        } catch {
          /* a failed refresh keeps the last honest day on screen */
        }
      }, refreshMs);
      if (host.__todayTimer && typeof host.__todayTimer.unref === "function") host.__todayTimer.unref();
    }
    return day;
  } catch (err) {
    host.innerHTML = "";
    return { state: "error", classes: [], error: err && err.message };
  }
}
