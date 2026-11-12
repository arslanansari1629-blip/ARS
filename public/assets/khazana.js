/* =========================================================================
   The Khazana tab.

   Khazana is Physics Wallah's library of *older* lecture sets: previous years'
   recordings, kept so a chapter can be revised from a different teacher. PW
   ships it two ways:

   1. **Linked to a batch** — the batch document carries `khazanaProgramId`.
      That id is a *program*, not a batch, and it is fully readable:
      `v1/programs/<id>/subjects` → `v2/…/chapters` → `v1/…/topics` →
      `v2/programs/contents` returns the lectures with their CloudFront video
      URLs. All of it through this site's own `/api/batch?khazana=…` proxy. A
      guest credential is enough. (This used to be drawn as "needs a
      subscriber" — that was `v3/programs`, an endpoint that does not exist.
      `lib/khazana-program.mjs` records the surface that does.)

   2. **Sold as its own batch** — "CA Foundation Khazana 2026", "SSC Khazana for
      Exam 2026". Ordinary batches, ordinary routes.

   The tab shows **this batch's archive and nothing else**. It does not list other
   Khazana batches: that list was identical on all 14,201 batch pages, so a Class
   10 page carried CA Foundation and SSC cards under its own archive. Those
   batches are ordinary catalogue entries, found by searching for "khazana".
   ========================================================================= */

import { esc } from "./app.js";

/** The linked-archive states, worded once so the tab and the panel cannot drift. */
export const STATES = {
  none: {
    title: "No Khazana archive in this batch",
    hint: "Physics Wallah has not attached an archive of older lectures to this batch. Its own subjects and chapters are unaffected — use the Subjects tab. Separately, PW sells Khazana as its own batch; those are ordinary batches and can be found by searching the catalogue for \"khazana\".",
    tone: "quiet",
  },
  known: {
    title: "Archive linked to this batch",
    hint: "Physics Wallah points this batch at an archive of older lectures.",
    tone: "quiet",
  },
  locked: {
    title: "The source refused this deployment",
    hint: "The archive did not accept the credential this site mints. An operator can set PW_TOKEN to change that; the archive's address is below so the refusal can be checked directly.",
    tone: "warn",
  },
  invalid: {
    title: "Archive id not recognised",
    hint: "The pointer on this batch is not an archive the source serves. Nothing is drawn from it, because rows from an unknown id would fail on click.",
    tone: "warn",
  },
  empty: {
    title: "Archive is empty",
    hint: "The archive answered, but it holds no subjects yet. It will fill in on its own once the source publishes.",
    tone: "quiet",
  },
  error: {
    title: "Archive could not be reached",
    hint: "The archive did not answer this time. That is a network read rather than a missing archive — try again in a moment.",
    tone: "warn",
  },
  ok: {
    title: "Linked archive",
    hint: "Older lecture sets attached to this batch.",
    tone: "good",
  },
};

/** The state object for a verdict the API sent us. */
export function stateOf(khazana) {
  const key = (khazana && khazana.state) || "none";
  return { key, ...(STATES[key] || STATES.error), ...(khazana || {}) };
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * The notice drawn for a state that has nothing to list.
 *
 * Shaped like a panel, not a paragraph: an eyebrow that says which tab this is, a
 * heading, and the explanation. The warn tone is a colour change only — a student
 * who cannot read paid content has not made a mistake, and the page must not
 * shout at them for it.
 */
function notice(state) {
  const warn = state.tone === "warn";
  return `
    <div class="khazana-note${warn ? " is-warn" : ""}">
      <span class="khazana-eyebrow">Khazana${warn ? " · notice" : ""}</span>
      <strong class="khazana-title">${esc(state.title)}</strong>
      <p class="khazana-hint">${esc(state.hint)}</p>
      ${
        state.programId
          ? `<p class="khazana-pointer">Archive <code>${esc(state.programId)}</code></p>`
          : ""
      }
    </div>`;
}

/**
 * One subject inside a linked archive.
 *
 * `programId` is the archive and `slug` is the subject *within* it — the chapter
 * and topic calls are slug-addressed, and this link is what the subject page
 * reads. `name` rides along so the heading is right before the first fetch lands.
 *
 * The card is deliberately the same `.subject-card` the Subjects tab uses: these
 * are subjects, and dressing them differently would suggest they behave
 * differently.
 */
export function archiveSubjectCard(s, programId) {
  const href =
    `/subject.html?batch=${encodeURIComponent(programId)}` +
    `&subject=${encodeURIComponent(s.slug || "")}` +
    `&name=${encodeURIComponent(s.name || "")}` +
    `&archive=1`;

  const bits = [];
  if (Number(s.lectures)) bits.push(`${Number(s.lectures).toLocaleString("en-IN")} lectures`);
  if (Number(s.chapters)) bits.push(`${Number(s.chapters)} chapter${Number(s.chapters) === 1 ? "" : "s"}`);
  const meta = bits.join(" · ");

  const img = s.image
    ? `<img src="${esc(s.image)}" alt="" loading="lazy" decoding="async">`
    : "";
  return `
    <a class="subject-card khazana-card" href="${href}">
      <span class="subject-thumb khazana-thumb">${
        img || `<span class="khazana-card-initials">${esc(initials(s.name))}</span>`
      }</span>
      <span class="khazana-card-body">
        <span class="khazana-card-name">${esc(s.name)}</span>
        <span class="khazana-card-meta">${esc(meta || "Open the archive")}</span>
      </span>
      <svg class="chev" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

/** A small labelled figure in the archive header — subjects, lectures, chapters. */
function statCard(value, label) {
  return `
    <div class="khazana-stat">
      <span class="khazana-stat-value">${esc(String(value))}</span>
      <span class="khazana-stat-label">${esc(label)}</span>
    </div>`;
}

/**
 * The tab's markup.
 *
 * **This is this batch's archive and nothing else.** It used to also render the
 * site-wide list of openable Khazana *batches* underneath — ten cards, identical
 * on all fourteen thousand batch pages, so a Class 10 page carried CA Foundation
 * and SSC cards under its own archive. Those batches are ordinary catalogue
 * entries, found by searching for "khazana"; they do not belong inside one
 * batch's tab.
 *
 * The shape is the same in every state, so the tab never reflows wildly between
 * "reading", "empty" and "here it is": a header, optional figures, then either a
 * subject grid or a single notice.
 */
export function khazanaMarkup({ khazana, subjects = [], reading = false } = {}) {
  if (reading) {
    return `
      <div class="khazana-panel">
        <div class="khazana-head">
          <span class="khazana-eyebrow">Khazana</span>
          <h3 class="khazana-h3">Loading this batch's archive</h3>
          <p class="khazana-sub">Asking Physics Wallah which subjects the linked archive holds. This takes a moment the first time.</p>
        </div>
        <div class="khazana-skeleton" aria-hidden="true">
          ${Array.from({ length: 3 })
            .map(() => `<div class="khazana-skeleton-row"></div>`)
            .join("")}
        </div>
      </div>`;
  }

  const state = stateOf(khazana);

  if (state.key === "ok" && subjects.length) {
    const lectures = subjects.reduce((n, s) => n + (Number(s.lectures) || 0), 0);
    const chapters = subjects.reduce((n, s) => n + (Number(s.chapters) || 0), 0);
    const figures = [
      statCard(subjects.length, subjects.length === 1 ? "subject" : "subjects"),
      lectures ? statCard(lectures.toLocaleString("en-IN"), "lectures") : "",
      chapters ? statCard(chapters.toLocaleString("en-IN"), chapters === 1 ? "chapter" : "chapters") : "",
    ].join("");

    return `
      <div class="khazana-panel khazana-archive">
        <div class="khazana-head">
          <span class="khazana-eyebrow">Khazana · archive</span>
          <h3 class="khazana-h3">Older lecture sets in this batch</h3>
          <p class="khazana-sub">
            Physics Wallah bundles previous years' recordings with this batch. They open
            exactly like any other subject — chapter list, lectures, notes and DPPs.
          </p>
        </div>
        <div class="khazana-stats">${figures}</div>
        <div class="grid khazana-grid">${subjects
          .map((s) => archiveSubjectCard(s, state.programId || ""))
          .join("")}</div>
      </div>`;
  }

  // A 200 with no rows is not content. Say so rather than rendering nothing.
  const shown = state.key === "ok" ? STATES.empty : state;
  return `
    <div class="khazana-panel">
      ${notice({ ...shown, programId: state.key === "ok" ? "" : state.programId || "" })}
    </div>`;
}

/**
 * Fetch and render the archive into a container.
 *
 * `programId` must be resolved *before* calling — `?khazana=1` answers it. It is
 * not on the batch payload the page paints from: the header comes from the
 * shipped catalogue, which has no `khazanaProgramId` column on any of its 14,201
 * rows. Trusting the payload there is what made this tab say "no archive" on
 * every batch for a whole round.
 */
export async function mountKhazana(host, { programId = "", library = [], fetchImpl } = {}) {
  if (!host) return null;
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  if (!programId) {
    host.innerHTML = khazanaMarkup({ khazana: { state: "none" }, library });
    return { state: "none", subjects: [], library };
  }

  host.innerHTML = khazanaMarkup({ khazana: { state: "known" }, library, reading: true });

  try {
    const res = await doFetch(
      `/api/batch?khazana=subjects&id=${encodeURIComponent(programId)}&program=${encodeURIComponent(programId)}`
    );
    const data = await res.json();
    const out = data && (data.khazana || data);
    const state = (out && out.state) || (data && data.success === false ? "error" : "ok");
    const answer = {
      khazana: {
        state: state === "missing" ? "invalid" : state,
        programId,
        needsSubscriberToken: Boolean(out && out.needsSubscriberToken),
      },
      subjects: Array.isArray(data && data.subjects)
        ? data.subjects
        : Array.isArray(data && data.items)
          ? data.items
          : [],
      library,
    };
    host.innerHTML = khazanaMarkup(answer);
    return { ...answer, state };
  } catch (err) {
    const failed = { state: "error", programId };
    host.innerHTML = khazanaMarkup({ khazana: failed, library });
    return { ...failed, library, error: err && err.message };
  }
}
