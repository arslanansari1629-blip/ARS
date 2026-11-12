/* =========================================================================
   The Khazana tab — the part of it that works.

   Khazana is Physics Wallah's library of *older* lecture sets: previous years'
   recordings, kept so a chapter can be revised from a different teacher. PW sells
   it to itself, inside newer batches.

   There are two ways it reaches a student, and only one of them is reachable
   from here:

   1. **Linked to a batch** — the batch document carries `khazanaProgramId`
      (`/v3/batches/<id>/details`). The pointer is free; the content is not. Every
      content shape for a program id answers a guest credential with 401, and no
      mirror changes that. So this path is left where it was: named, explained,
      and reported honestly rather than drawn as an empty grid.

   2. **Sold as its own batch** — "CA Foundation Khazana 2026", "SSC Khazana for
      Exam 2026", "CA Inter Sep 2026 Group 1 Khazana". These are ordinary batches
      with ordinary subjects and chapters, and they open exactly like any other
      batch on this site. Before this module was rewritten the tab ignored them
      entirely, which is why a site with real Khazana on it said "no Khazana
      here". That was the bug: not a broken endpoint, a missed case.

   So the tab now leads with the readable Khazana batches and treats the linked
   archive as the footnote it is.
   ========================================================================= */

import { esc } from "./app.js";

/** The linked-archive states, worded once so the tab and the panel cannot drift. */
export const STATES = {
  none: {
    title: "No linked archive",
    hint: "This batch does not carry a Khazana archive pointer. The Khazana batches that *can* be opened are listed above.",
    tone: "quiet",
  },
  known: {
    title: "Archive linked to this batch",
    hint: "Physics Wallah points this batch at an archive of older lectures. Open it to see what the source will serve.",
    tone: "quiet",
  },
  locked: {
    title: "Linked archive needs a subscriber",
    hint: "The archive exists, but Physics Wallah serves it only to a subscribed account — a guest token is refused. An operator can unlock it by setting a subscribed PW_TOKEN; nothing else about the site changes when that happens.",
    tone: "warn",
  },
  invalid: {
    title: "Linked archive is not openable",
    hint: "The archive id on this batch is a program, and the chapter routes here speak batch ids. Rows from it would 404 on click, so they are not shown.",
    tone: "warn",
  },
  empty: {
    title: "Linked archive is empty",
    hint: "The archive answered, but it holds no subjects yet. It will fill in on its own once the source publishes.",
    tone: "quiet",
  },
  error: {
    title: "Linked archive could not be reached",
    hint: "The archive did not answer this time. This is a network read rather than a missing archive — try again in a moment.",
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

/** One Khazana batch, as a card that opens the batch page. */
function libraryCard(b) {
  const meta = [b.exam && b.exam[0], b.language, b.isFree ? "Free" : ""]
    .filter(Boolean)
    .join(" · ");
  const img = b.image
    ? `<img src="${esc(b.image)}" alt="" loading="lazy" decoding="async">`
    : `<span class="khazana-card-initials">${esc(initials(b.name))}</span>`;
  return `
    <a class="subject-card khazana-card" href="/batch.html?id=${encodeURIComponent(b.id)}">
      <span class="subject-thumb khazana-thumb">${img}</span>
      <span class="grow">
        <span class="title">${esc(b.name)}</span>
        <span class="counts">${esc(meta || "Recorded lecture library")}</span>
      </span>
      <svg class="chev" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** The notice drawn for a linked-archive state. */
function notice(state) {
  return `
    <div class="khazana-note${state.tone === "warn" ? " is-warn" : ""}">
      <strong class="khazana-title">${esc(state.title)}</strong>
      ${
        state.programId
          ? `<p class="khazana-pointer">Archive <code>${esc(state.programId)}</code></p>`
          : ""
      }
      <p>${esc(state.hint)}</p>
      ${
        state.needsSubscriberToken
          ? `<p class="khazana-fix">Operators can enable this with a subscribed <code>PW_TOKEN</code>; the tab then lists the archive without any other change.</p>`
          : ""
      }
    </div>`;
}

/**
 * The library block: every Khazana batch on the site, as openable cards.
 *
 * This is the working half of the feature, so it comes first and it is never
 * empty — `lib/khazana.mjs` ships the list with the catalogue whether or not the
 * catalogue is otherwise reachable.
 */
export function libraryMarkup(library) {
  const rows = Array.isArray(library) ? library : [];
  if (!rows.length) return "";
  return `
    <div class="khazana-library">
      <div class="khazana-library-head">
        <h3>Khazana batches you can open</h3>
        <p>Physics Wallah sells Khazana as its own batch. Each one below is a real,
           openable batch: pick a subject, then a chapter, then a lecture — the same
           route as everything else on this site.</p>
      </div>
      <div class="subject-grid khazana-grid">${rows.map(libraryCard).join("")}</div>
    </div>`;
}

/**
 * The tab's markup.
 *
 * `reading` is the in-flight state for a *linked* archive: the pointer is known
 * and we are asking it. The library block does not wait for that request and is
 * drawn first — the list of openable Khazana batches does not depend on whether
 * this particular batch has a pointer.
 */
export function khazanaMarkup({ khazana, subjects = [], library = [], reading = false } = {}) {
  const head = libraryMarkup(library);

  if (reading) {
    return `${head}
      <div class="khazana-note">
        <strong class="khazana-title">Reading the linked archive…</strong>
        <p>Asking the source what it will serve for this batch.</p>
      </div>`;
  }

  const state = stateOf(khazana);

  if (state.key === "ok" && subjects.length) {
    return `${head}
      <div class="khazana-library">
        <div class="khazana-library-head">
          <h3>From this batch's archive</h3>
        </div>
        <div class="subject-grid khazana-grid">${subjects
          .map((s) => subjectCard(s, state))
          .join("")}</div>
      </div>`;
  }

  // A 200 with no rows is not content. Say so rather than rendering nothing.
  if (state.key === "ok") return head + notice(STATES.empty);

  return head + notice({ ...state, programId: state.programId || "" });
}

/**
 * One subject from a *linked* archive.
 *
 * The link carries the archive id, not the batch id, and `archive=1` so the
 * subject page knows the difference. Rows from an archive whose id is a program
 * never reach here — `readArchive` refuses to call those `ok`.
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
    <a class="subject-card khazana-card" href="${href}">
      <span class="subject-thumb khazana-thumb"><span class="khazana-card-initials">${esc(initials(s.name))}</span></span>
      <span class="grow">
        <span class="title">${esc(s.name)}</span>
        <span class="counts">${esc(meta || "Open the archive")}</span>
      </span>
    </a>`;
}

/**
 * Fetch and render the archive into a container.
 *
 * `library` is passed in by the caller (it comes with the batch payload, so it is
 * already on the page). Only the *linked* archive costs a request, and only when
 * this batch has one — a batch with no pointer spends nothing.
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
      `/api/batch?khazana=read&id=${encodeURIComponent(programId)}&program=${encodeURIComponent(programId)}`
    );
    const data = await res.json();
    if (!data || data.success === false) throw new Error((data && data.error) || "unavailable");
    const answer = { khazana: data.khazana, subjects: data.subjects || [], library };
    host.innerHTML = khazanaMarkup(answer);
    return { ...answer, state: (data.khazana && data.khazana.state) || "error" };
  } catch {
    const failed = { state: "error", programId };
    host.innerHTML = khazanaMarkup({ khazana: failed, library });
    return { ...failed, library };
  }
}
