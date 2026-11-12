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

   So the tab leads with this batch's own archive when it has one, and always
   carries the list of openable Khazana batches underneath.
   ========================================================================= */

import { esc } from "./app.js";

/** The linked-archive states, worded once so the tab and the panel cannot drift. */
export const STATES = {
  none: {
    title: "No linked archive",
    hint: "This batch does not carry a Khazana archive pointer. The Khazana batches that *can* be opened are listed below.",
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

/** The notice drawn for a state that has nothing to list. */
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
    </div>`;
}

/**
 * The library block: every Khazana batch on the site, as openable cards.
 *
 * It is never empty — `lib/khazana.mjs` ships the list with the catalogue — and
 * it does not wait on the archive read, so it is drawn first.
 */
export function libraryMarkup(library) {
  const rows = Array.isArray(library) ? library : [];
  if (!rows.length) return "";
  return `
    <div class="khazana-library">
      <div class="khazana-library-head">
        <h3>Khazana batches you can open</h3>
        <p>Physics Wallah also sells Khazana as its own batch. Each one below is a
           real, openable batch: pick a subject, then a chapter, then a lecture —
           the same route as everything else on this site.</p>
      </div>
      <div class="subject-grid khazana-grid">${rows.map(libraryCard).join("")}</div>
    </div>`;
}

/**
 * One subject inside a linked archive.
 *
 * `batch` and `subject` are both **slugs**: the archive's chapter and topic calls
 * are slug-addressed, and this link is what the subject page will read. `name` is
 * carried so the heading is right before the first fetch lands.
 */
export function archiveSubjectCard(s, programId) {
  const href =
    `/subject.html?batch=${encodeURIComponent(programId)}` +
    `&subject=${encodeURIComponent(s.slug || "")}` +
    `&name=${encodeURIComponent(s.name || "")}` +
    `&archive=1`;
  const meta = [
    s.lectures ? `${s.lectures} lectures` : "",
    s.chapters ? `${s.chapters} chapter${s.chapters === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const img = s.image
    ? `<img src="${esc(s.image)}" alt="" loading="lazy" decoding="async">`
    : "";
  return `
    <a class="subject-card khazana-card" href="${href}">
      <span class="subject-thumb khazana-thumb">${
        img || `<span class="khazana-card-initials">${esc(initials(s.name))}</span>`
      }</span>
      <span class="grow">
        <span class="title">${esc(s.name)}</span>
        <span class="counts">${esc(meta || "Open the archive")}</span>
      </span>
      <svg class="chev" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

/**
 * The tab's markup.
 *
 * `reading` is the in-flight state for a linked archive. The library block is
 * drawn regardless — whether this batch has a pointer has no bearing on which
 * Khazana batches exist.
 */
export function khazanaMarkup({ khazana, subjects = [], library = [], reading = false } = {}) {
  const head = libraryMarkup(library);

  if (reading) {
    return `${head}
      <div class="khazana-note">
        <strong class="khazana-title">Reading the linked archive…</strong>
        <p>Asking the source which subjects this batch's archive holds.</p>
      </div>`;
  }

  const state = stateOf(khazana);

  if (state.key === "ok" && subjects.length) {
    const total = subjects.reduce((n, s) => n + (Number(s.lectures) || 0), 0);
    return `${head}
      <div class="khazana-library khazana-archive">
        <div class="khazana-library-head">
          <h3>From this batch's archive</h3>
          <p>${esc(
            `${subjects.length} subject${subjects.length === 1 ? "" : "s"}` +
              (total ? ` · ${total} lectures` : "") +
              " · older recordings, opened the same way as any other lecture"
          )}</p>
        </div>
        <div class="subject-grid khazana-grid">${subjects
          .map((s) => archiveSubjectCard(s, state.programId || ""))
          .join("")}</div>
      </div>`;
  }

  // A 200 with no rows is not content. Say so rather than rendering nothing.
  if (state.key === "ok") return head + notice(STATES.empty);

  return head + notice({ ...state, programId: state.programId || "" });
}

/**
 * Fetch and render the archive into a container.
 *
 * `programId` is the batch's `khazanaProgramId`, already on the page from the
 * batch payload, so no lookup is needed to know *whether* to ask. Only the read
 * itself costs a request, and only for a batch that has a pointer.
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
