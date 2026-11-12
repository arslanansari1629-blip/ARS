/* =========================================================================
   The Khazana tab.

   Khazana is Physics Wallah's archive of *older* lecture sets, bundled inside
   newer batches — the same syllabus taught in a previous year, kept so a chapter
   can be revised from a different teacher. Every batch document points at it:

       /v3/batches/<id>/details → "khazanaProgramId": "62cc7a…"

   The pointer is free; the content is not. Khazana is paid material, and the
   tokens this deployment can mint are guest tokens, so the upstream refuses every
   content shape with a 401. That refusal was verified against the live API before
   this file existed, and it is not something a tab can be clever about.

   So this module has one job and does it honestly: it renders whichever of the
   seven states the batch is in, says what that state means in a sentence a student
   can act on, and renders the real subject grid the moment the archive answers.
   It never draws an empty grid and calls it "Khazana" — a student who cannot find
   last year's lectures needs to know why, not to be told there are none.
   ========================================================================= */

import { esc } from "./app.js";

/** The seven states, worded once, here, so the tab and the panel cannot drift. */
export const STATES = {
  none: {
    title: "No Khazana archive",
    hint: "Physics Wallah has not attached an archive of older lectures to this batch. Everything this batch does have is in the Subjects tab.",
    tone: "quiet",
  },
  known: {
    title: "Khazana archive linked",
    hint: "This batch carries a Khazana archive of older lecture sets. Open it to see what the source will serve.",
    tone: "quiet",
  },
  locked: {
    title: "Khazana is paid content",
    hint: "The archive exists, but Physics Wallah serves it only to a subscribed account — a guest token is refused. An operator can unlock it by setting a subscribed PW_TOKEN; nothing else about the site changes when that happens.",
    tone: "warn",
  },
  invalid: {
    title: "Khazana pointer unusable",
    hint: "The archive id on this batch is a program, and no content shape accepts it. This is a defect in the source batch, not something a reader can fix.",
    tone: "warn",
  },
  empty: {
    title: "Khazana archive is empty",
    hint: "The archive answered, but it holds no subjects yet. It will fill in on its own once the source publishes.",
    tone: "quiet",
  },
  error: {
    title: "Khazana could not be reached",
    hint: "The archive did not answer this time. This is a network read rather than a missing archive — try again in a moment.",
    tone: "warn",
  },
  ok: {
    title: "Khazana",
    hint: "Older lecture sets for this batch, taught alongside the current one.",
    tone: "good",
  },
};

/** The state object for a verdict the API sent us. */
export function stateOf(khazana) {
  const key = (khazana && khazana.state) || "none";
  return { key, ...(STATES[key] || STATES.error), ...(khazana || {}) };
}

/**
 * The tab's markup.
 *
 * `reading` is the in-flight state: the pointer is known and we are asking the
 * archive. It is a distinct render rather than a spinner inside every other
 * state, because "we have not asked yet" and "we asked and were refused" are the
 * two things a reader most needs to be able to tell apart.
 */
export function khazanaMarkup({ khazana, subjects = [], reading = false } = {}) {
  if (reading) {
    return `
      <div class="khazana-note">
        <span class="pill">Khazana</span>
        <p class="tiny dim">Reading the archive…</p>
      </div>
      <div class="grid grid-subjects">
        ${Array.from({ length: 3 })
          .map(() => `<div class="skeleton sk-card"></div>`)
          .join("")}
      </div>`;
  }

  const state = stateOf(khazana);

  if (state.key === "ok" && subjects.length) {
    return `
      <div class="khazana-note">
        <span class="pill pill-accent">Khazana</span>
        <p class="tiny dim">${esc(state.hint || STATES.ok.hint)}</p>
      </div>
      <div class="grid grid-subjects">${subjects.map((s) => subjectCard(s, state)).join("")}</div>`;
  }

  if (state.key === "ok") {
    // A 200 with no rows is not content. Say so rather than rendering nothing.
    return notice(STATES.empty, state);
  }

  return notice(state, state);
}

function notice(state, full) {
  // The title is the line a reader scans; the hint is what they read next. Drawing
  // only the hint left every state opening with a paragraph, so nothing said which
  // state it was.
  return `
    <div class="khazana-note ${state.tone === "warn" ? "is-warn" : ""}">
      <span class="pill">Khazana</span>
      <strong class="khazana-title">${esc(state.title)}</strong>
      ${
        full && full.programId
          ? `<p class="tiny dim">Archive <code>${esc(full.programId)}</code></p>`
          : ""
      }
      <p>${esc(state.hint)}</p>
      ${
        full && full.needsSubscriberToken
          ? `<p class="tiny dim">Operators can enable this with a subscribed <code>PW_TOKEN</code>; the tab then lists the archive without any other change.</p>`
          : ""
      }
    </div>`;
}

/**
 * One archive subject, as a card.
 *
 * The link carries the archive id, not the batch id, because the subject page
 * must fetch chapters from the archive that owns them — a batch id there would
 * silently list the *current* year's chapters under an archive heading.
 */
function subjectCard(s, state) {
  const href =
    `/subject.html?batch=${encodeURIComponent(state.programId || "")}` +
    `&subject=${encodeURIComponent(s.slug || "")}` +
    `&name=${encodeURIComponent(s.name || "")}` +
    `&archive=1`;
  const meta = [s.lectureCount ? `${s.lectureCount} lectures` : "", s.tagCount ? `${s.tagCount} chapters` : ""]
    .filter(Boolean)
    .join(" · ");
  return `
    <a class="subject-card fade-up" href="${href}">
      <div class="icon">${esc(initials(s.name))}</div>
      <div class="grow">
        <div class="name">${esc(s.name)}</div>
        <div class="sub">${esc(meta || "Open the archive")}</div>
      </div>
      <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * Fetch and render the archive into a container.
 *
 * Two requests, on purpose. The pointer comes from the batch payload the page
 * already has, so the tab paints instantly with the state it can know; `read`
 * then spends the upstream probes. A batch with no pointer never makes a request
 * at all, which is most of the catalogue.
 */
export async function mountKhazana(host, { programId = "", fetchImpl } = {}) {
  if (!host) return null;
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  if (!programId) {
    host.innerHTML = khazanaMarkup({ khazana: { state: "none" } });
    return { state: "none", subjects: [] };
  }

  host.innerHTML = khazanaMarkup({ khazana: { state: "known" }, reading: true });

  try {
    const res = await doFetch(
      `/api/batch?khazana=read&id=${encodeURIComponent(programId)}&program=${encodeURIComponent(programId)}`
    );
    const data = await res.json();
    if (!data || data.success === false) throw new Error((data && data.error) || "unavailable");
    const answer = { khazana: data.khazana, subjects: data.subjects || [] };
    host.innerHTML = khazanaMarkup(answer);
    // Return what was *rendered* in the shape the caller's cache expects, not the
    // raw response: a caller that has to know the API's nesting to read `state`
    // will eventually read it wrong, and a tab that caches the wrong thing shows
    // the previous batch's archive.
    return { ...answer, state: (data.khazana && data.khazana.state) || "error" };
  } catch {
    const failed = { state: "error" };
    host.innerHTML = khazanaMarkup({ khazana: failed });
    return failed;
  }
}
