/* =========================================================================
   ArsVibe — XP, daily streak and the leaderboard
   -------------------------------------------------------------------------
   One small client-side record of what a student has actually done, and the
   three things a student needs to see about it: points, a streak that is
   honest about being broken, and where they stand.

   The rule that decides everything in this file: **the client never awards
   itself points.** XP is a function of the finished attempts stored here and on
   the server (see `earnedXp`), the streak is a function of the dates those
   attempts happened, and the leaderboard — the shared, competitive part — is
   computed in one place on the server and cannot be edited by opening a browser
   console. The local copy of this file only says "here is my finished attempt";
   it never says "give me 400 points".

   What counts, and how much:

     a marked DPP paper   +50  once per paper, per day
     per correct answer    +6  (so a hard paper is worth more than a short one)
     first paper of a day  +30  (the streak's own reward — it rewards showing up)
     a finished lecture   +15  once per lecture
     reading a class note  +8  once per note
     20 minutes in a lecture +20  (once per lecture, and only really watched)
     a 100% paper          +40  (and it is rare enough to be worth naming)

   Nothing here can be earned twice by re-opening a page: every award carries a
   natural key, and a key that is already in the ledger is refused.
   ========================================================================= */

const KEY = "arsvibe.progress";

/** The events that award XP. Anything else in the ledger is ignored. */
export const AWARDS = {
  dpp: { label: "DPP paper", points: 50 },
  daily: { label: "first paper of the day", points: 30 },
  lecture: { label: "lecture finished", points: 15 },
  note: { label: "class note read", points: 8 },
  watch20: { label: "20 minutes watched", points: 20 },
};

/**
 * What a marked paper adds on top of the base 50.
 *
 * These are *components* of one award, not awards of their own. That distinction
 * is the whole defence against farming: an earlier version keyed the correct
 * answers separately, so re-sitting the same paper the same evening with two
 * more right paid again. One paper, one day, one entry — the marks inside it.
 */
export const PAPER_BONUS = { perCorrect: 6, perfect: 40 };

/** How a marked paper's points are made up, for the interface to explain. */
export function paperPoints({ correct = 0, scored = 0 } = {}) {
  const answers = Math.max(0, Number(correct) || 0) * PAPER_BONUS.perCorrect;
  const perfect = Number(scored) > 0 && Number(correct) >= Number(scored);
  return {
    base: AWARDS.dpp.points,
    answers,
    perfect: perfect ? PAPER_BONUS.perfect : 0,
    points: AWARDS.dpp.points + answers + (perfect ? PAPER_BONUS.perfect : 0),
    isPerfect: perfect,
  };
}

/**
 * The names a level gets. Deliberately the site's own register — a technician's
 * ladder, not a game's — and deliberately short: past the top level the badge
 * reads "Level 12" and stops inventing titles.
 */
const TITLES = [
  "Starting sheet",
  "Set square",
  "Sharp pencil",
  "Steady hand",
  "Draftsman",
  "Draftsman II",
  "Surveyor",
  "Surveyor II",
  "Engineer",
  "Engineer II",
  "Chief engineer",
  "Master of the sheet",
];

/* ------------------------------------------------------------------ storage */

function readRaw() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function empty() {
  return {
    v: 1,
    /* Every award, once. `id` is the natural key: "dpp:<url>:<day>". */
    ledger: [],
    /* Per-day activity, so the streak can be shown as a calendar, not a claim. */
    days: {},
  };
}

/**
 * The record, always in a shape the rest of the file can trust.
 *
 * A corrupt value is repaired rather than thrown away: a student's streak is
 * the one thing on this site that cannot be re-fetched.
 */
function read() {
  const data = readRaw();
  if (!data) return empty();
  return {
    v: 1,
    ledger: Array.isArray(data.ledger) ? data.ledger.filter((e) => e && e.id) : [],
    days: data.days && typeof data.days === "object" ? data.days : {},
  };
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent("progress:change", { detail: snapshot(data) }));
    return true;
  } catch {
    /* private mode: the dashboard reads what it can and says so */
    return false;
  }
}

/* -------------------------------------------------------------------- dates */

/** The student's local calendar day, as YYYY-MM-DD. */
export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return dayKey(new Date());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days between two YYYY-MM-DD keys (b − a). Parsed as local midnights. */
export function daysBetween(a, b) {
  const parse = (key) => {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1).getTime();
  };
  return Math.round((parse(b) - parse(a)) / 86_400_000);
}

export function shiftDay(key, delta) {
  const [y, m, d] = String(key).split("-").map(Number);
  return dayKey(new Date(y, (m || 1) - 1, (d || 1) + delta));
}

/* ---------------------------------------------------------------------- xp */

/**
 * The XP a ledger is worth — recomputed, never stored.
 *
 * Storing a running total means a reload can disagree with the ledger (a write
 * that half-succeeded, a hand-edited key), and then the site shows two numbers
 * for one student. Deriving it means the number is always the ledger.
 */
export function earnedXp(data = read()) {
  let total = 0;
  for (const entry of data.ledger) {
    const award = AWARDS[entry.kind];
    if (!award) continue;
    total += Number(entry.points) || award.points;
  }
  return total;
}

/**
 * Levels widen as they rise: each is 25% longer than the last, so the early
 * ones arrive while a student is still deciding to use the site and the later
 * ones mean something. Level 1 starts at 0.
 */
const STEP = 220;
const GROWTH = 1.25;

/** The XP needed to *reach* `level` (1-based). */
export function xpForLevel(level) {
  let need = 0;
  for (let l = 1; l < level; l++) need += Math.round(STEP * Math.pow(GROWTH, l - 1));
  return need;
}

export function levelOf(xp = earnedXp()) {
  let level = 1;
  // An unbounded loop would hang on a corrupted (huge) total; 99 is far past any
  // real student and keeps the maths honest.
  while (level < 99 && xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

export function levelInfo(xp = earnedXp()) {
  const level = levelOf(xp);
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const span = Math.max(1, ceil - floor);
  return {
    level,
    xp,
    floor,
    ceil,
    into: Math.max(0, xp - floor),
    span,
    percent: Math.max(0, Math.min(100, Math.round(((xp - floor) / span) * 100))),
    title: TITLES[level - 1] || `Level ${level}`,
  };
}

/* -------------------------------------------------------------------- award */

/**
 * Record one award.
 *
 * `id` is the natural key and the whole guard against double-scoring: the same
 * paper on the same day, the same lecture ever, the same note ever. Returns the
 * entry when it was new, or `null` when it was already in the ledger — callers
 * use that to know whether to celebrate.
 */
export function award(kind, id, { points, day = dayKey(), meta = null } = {}) {
  const awardDef = AWARDS[kind];
  if (!awardDef || !id) return null;
  const data = read();
  if (data.ledger.some((e) => e.id === id)) return null;

  const entry = {
    kind,
    id,
    points: Number.isFinite(points) ? points : awardDef.points,
    day,
    at: Date.now(),
    ...(meta ? { meta } : {}),
  };
  data.ledger.push(entry);

  const dayEntry = data.days[day] || { dpp: 0, correct: 0, lectures: 0, notes: 0, xp: 0 };
  if (kind === "dpp") {
    dayEntry.dpp += 1;
    dayEntry.correct += Number(meta?.correct) || 0;
  }
  if (kind === "lecture") dayEntry.lectures += 1;
  if (kind === "note") dayEntry.notes += 1;
  dayEntry.xp += entry.points || 0;
  data.days[day] = dayEntry;

  write(data);
  return entry;
}

/**
 * A finished DPP paper, in one call.
 *
 * The caller passes what the server marked — it does not pass points. Everything
 * below is derived from the result, which is the point: a console cannot ask for
 * more marks than the paper awarded.
 */
export function recordPaper({ url, correct = 0, scored = 0, percent = 0, at = null, title = "" }) {
  if (!url) return { xp: 0, awards: [], streak: getStreak(), breakdown: paperPoints({ correct, scored }) };

  const when = at ? new Date(at) : new Date();
  const day = dayKey(when);
  const breakdown = paperPoints({ correct, scored });
  const awards = [];

  // One paper, one reward, one day. Retrying it the same evening is practice,
  // and the ledger already holds today's entry — so this returns null and the
  // interface says "already counted" rather than paying again.
  const paperAward = award("dpp", `dpp:${url}:${day}`, {
    day,
    points: breakdown.points,
    meta: {
      url,
      title,
      correct: Number(correct) || 0,
      scored: Number(scored) || 0,
      percent: Number(percent) || 0,
      breakdown,
    },
  });
  if (paperAward) awards.push(paperAward);

  // Showing up is the habit the streak is about, so it is paid once a day, on
  // the first paper, and the ledger records which day it already paid.
  const before = getStreak(when);
  const daily = award("daily", `daily:${day}`, { day });
  if (daily) awards.push(daily);
  const after = getStreak(when);

  return {
    xp: awards.reduce((sum, a) => sum + (a.points || 0), 0),
    awards,
    streak: after,
    streakStarted: after.current > before.current,
    breakdown,
    percent: Number(percent) || 0,
  };
}

/* ------------------------------------------------------------------ streak */

/**
 * The streak, as of `now`.
 *
 * The honest part: a streak that was not continued today is *not* still running
 * — it is at risk until midnight. So `current` counts back from today when today
 * has a paper, and from yesterday when it does not, and `atRisk` says which of
 * those it is. A dashboard that shows "7 days" all day after the streak broke
 * last Tuesday is the bug this exists to avoid.
 *
 * `longest` is read from the day map, not kept as a number, so it cannot drift.
 */
export function getStreak(now = new Date(), data = read()) {
  const today = dayKey(now);
  const active = (key) => Number(data.days[key]?.dpp) > 0;

  const studiedToday = active(today);
  // Where the run is measured from: today when there is a paper today, else
  // yesterday — and only if yesterday was studied at all.
  let cursor = studiedToday ? today : shiftDay(today, -1);
  let current = 0;
  if (active(cursor)) {
    while (active(cursor) && current < 3650) {
      current += 1;
      cursor = shiftDay(cursor, -1);
    }
  }

  // Longest run over the days actually recorded.
  const days = Object.keys(data.days).filter(active).sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    run = prev && daysBetween(prev, day) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }

  return {
    current,
    longest,
    studiedToday,
    /** True when the run exists but today is still empty. */
    atRisk: current > 0 && !studiedToday,
    today,
    lastDay: days.length ? days[days.length - 1] : "",
  };
}

/**
 * The last `n` days, oldest first — for the little calendar on the dashboard and
 * on the leaderboard page.
 */
export function recentDays(n = 14, now = new Date(), data = read()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = shiftDay(dayKey(now), -i);
    const entry = data.days[day];
    out.push({
      day,
      dpp: Number(entry?.dpp) || 0,
      xp: Number(entry?.xp) || 0,
      active: Number(entry?.dpp) > 0,
      isToday: i === 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ reading */

/** Everything a page needs to render progress, in one object. */
export function progress(now = new Date()) {
  const data = read();
  const xp = earnedXp(data);
  return {
    xp,
    ...levelInfo(xp),
    streak: getStreak(now, data),
    week: recentDays(7, now, data),
    ledger: data.ledger.length,
    today: data.days[dayKey(now)] || { dpp: 0, correct: 0, xp: 0 },
  };
}

/** The raw snapshot that `progress:change` carries. */
function snapshot(data) {
  const xp = earnedXp(data);
  return { xp, ...levelInfo(xp), streak: getStreak(new Date(), data) };
}

/* --------------------------------------------------------------- milestones */

/**
 * Fixed thresholds rather than a moving target: a leaderboard you can be
 * promoted past for doing nothing is not a goal.
 */
const QUESTS = [
  { id: 100, xp: 100, label: "First 100 XP", hint: "one marked paper and a note" },
  { id: 500, xp: 500, label: "500 XP", hint: "a week of papers" },
  { id: 1000, xp: 1000, label: "1,000 XP", hint: "the grind showing" },
  { id: 2500, xp: 2500, label: "2,500 XP", hint: "serious revision" },
  { id: 5000, xp: 5000, label: "5,000 XP", hint: "a term of it" },
  { id: 10000, xp: 10000, label: "10,000 XP", hint: "the long game" },
];

export function milestones(xp = earnedXp()) {
  return QUESTS.map((q) => ({
    ...q,
    done: xp >= q.xp,
    remaining: Math.max(0, q.xp - xp),
    percent: Math.min(100, Math.round((xp / q.xp) * 100)),
  }));
}

/** The one next milestone, which is what a band should actually show. */
export function nextMilestone(xp = earnedXp()) {
  return milestones(xp).find((q) => !q.done) || null;
}

/* -------------------------------------------------------------- the name */

/**
 * The display name on the leaderboard: the student's first name and a stable
 * two-character tag derived from the whole session email.
 *
 * A hash rather than the email itself, because the board is public to everyone
 * on the site and an email address is not a username. The same student always
 * keeps the same tag, so two "Aarav"s stay distinguishable.
 */
export function displayName(session) {
  const name = String(session?.name || "Student").trim();
  const first = name.split(/\s+/)[0] || "Student";
  const seed = String(session?.email || name).toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 1296;
  const tag = hash.toString(36).padStart(2, "0").slice(-2).toUpperCase();
  return `${first} ${tag}`;
}

/** An opaque, stable id for this browser on the board. Not the email. */
export function browserId() {
  const STORE = "arsvibe.player";
  try {
    let id = localStorage.getItem(STORE);
    if (id && /^[a-z0-9-]{8,40}$/i.test(id)) return id;
    id =
      (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
        .replace(/[^a-z0-9-]/gi, "")
        .slice(0, 36);
    localStorage.setItem(STORE, id);
    return id;
  } catch {
    return "";
  }
}
