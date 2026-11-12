/* =========================================================================
   Today's classes — the live-class strip above a batch's tabs.

   Physics Wallah has no batch-wide schedule endpoint that answers a guest; every
   spelling of one was probed and refused (see `lib/today.mjs` for the list). What
   does answer is the per-subject contents listing, which carries `startTime`,
   `lectureType` and the video's real duration. The server walks those and keeps
   the rows that fall on today; this module draws them.

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
  return `
    <li class="today-class is-${esc(c.status || "upcoming")}">
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
 * What comes after today, once today is over.
 *
 * A day that has finished is still the right thing to show — it is what the page
 * is about — but on its own it leaves a student looking at three classes they
 * cannot attend and no idea when the next one is. This adds that one line, and
 * only when every class on the strip is already over: while anything is live or
 * still to come, "next" would be competing with the class that matters now.
 */
function afterDay(d, classes) {
  if (!classes.length || !classes.every((c) => c.status === "done")) return "";
  const next = d.next;
  if (!next || !next.start) return "";
  const when = `${fmtDate(next.start)}${next.startClock ? ` at ${next.startClock} ${TZ_LABEL}` : ""}`;
  const what = [next.subject, next.teacher].filter(Boolean).join(" · ");
  return `<div class="today-after">Next: <b>${esc(when)}</b>${what ? ` — ${esc(what)}` : ""}</div>`;
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
          <span class="today-count">${classes.length} class${classes.length === 1 ? "" : "es"} published today</span>
        </div>
        <ul class="today-list">${classes.map((c) => classRow(c, batchId)).join("")}</ul>
        ${afterDay(d, classes)}
      </section>`;
  }

  if (state === "empty") {
    // One line, not a panel: an empty day is ordinary, and 14,000 batch pages
    // must not each open with an apology. The next class is the useful half.
    const next = d.next;
    const when = next
      ? `Next: ${esc(fmtDate(next.start))}${next.startClock ? ` at ${esc(next.startClock)} ${TZ_LABEL}` : ""}${
          next.subject ? ` — ${esc(next.subject)}` : ""
        }`
      : // Deliberately "published", not "scheduled". The only surface a guest can
        // read lists the classes the source has *created*; a slot PW has not
        // published yet is invisible here, and claiming there is nothing else
        // would be a claim about a calendar we cannot see.
        "No further classes are published in this batch yet.";
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
export async function mountToday(host, { batchId = "", fetchImpl } = {}) {
  if (!host) return null;
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  host.innerHTML = todayMarkup(null, { reading: true });
  try {
    const res = await doFetch(`/api/batch?today=1&id=${encodeURIComponent(batchId)}`);
    const data = await res.json();
    const day = (data && data.today) || { state: "error" };
    host.innerHTML = todayMarkup(day, { batchId });
    return day;
  } catch (err) {
    host.innerHTML = "";
    return { state: "error", classes: [], error: err && err.message };
  }
}
