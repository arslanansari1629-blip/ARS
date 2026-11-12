/**
 * Khazana — a batch's archive of older lectures.
 *
 * ## What it actually is
 *
 * Khazana is not a page and not a player. It is Physics Wallah's **archive of
 * earlier lecture sets**, bundled inside newer batches: the same syllabus taught
 * in previous years, kept so a student can revise a chapter from a different
 * teacher. PW's own product copy describes it as "Khazana Video Library Access —
 * available in Infinity plans", which is the important half of the sentence.
 *
 * Every batch document carries a pointer to it:
 *
 *     /v3/batches/<id>/details → "khazanaProgramId": "62cc7a39ea773600110bec2f"
 *
 * Two sibling archives use the same mechanism (`pitaraProgramId`, and some
 * batches carry both), so the reader below is written against "an archive
 * pointer" rather than against Khazana specifically.
 *
 * ## The hard part, stated plainly
 *
 * Attaching the pointer is free — it is already in the details payload the batch
 * page fetches. **Reading the archive is gated.** Every content shape answers a
 * guest credential with a refusal, and this was verified against the live upstream
 * before a line of this file was written:
 *
 *     /v3/batches/<khazana>/subjects   → 401 Unauthorised
 *     /v3/batches/<khazana>/details    → 400 Invalid Batch
 *     /v3/programs/<khazana>/subjects  → 404 Not Found
 *     /v3/programs/<khazana>/details   → 404 Not Found
 *     every mirror host                → 404 / not this API
 *     with a freshly minted guest token → still 401
 *
 * That is not a bug to route around. Khazana is paid content, and the tokens this
 * deployment can mint are guest tokens. So this module's job is not to pretend
 * otherwise: it resolves what it can, names exactly which of the seven states it
 * landed in, and tells the reader what would change it. A tab that says "needs a
 * subscriber token" is honest; a tab that renders an empty grid and calls it
 * "Khazana" is a lie that costs a student their evening.
 *
 * When `PW_TOKEN` holds a subscribed bearer, the `ok` path below starts returning
 * real subjects and every caller — the tab, the subject page, the player — begins
 * working with no further change. That is the whole point of modelling the states
 * instead of hard-coding a failure.
 */

import { upstreamJson } from "./upstream.mjs";

/**
 * The seven things a batch's archive can be.
 *
 * Kept as data rather than as booleans because the panel, the tab and the tests
 * all have to agree on the wording, and three booleans always drift apart.
 */
export const KHAZANA_STATES = {
  /** This batch carries no archive pointer at all. */
  none: {
    label: "No Khazana archive",
    short: "This batch does not carry a Khazana archive.",
  },
  /** The pointer exists but nothing has tried to read it yet. */
  known: {
    label: "Khazana archive linked",
    short: "This batch carries a Khazana archive.",
  },
  /** The archive exists and the credential is not entitled to it. */
  locked: {
    label: "Khazana needs a subscriber",
    short: "The archive is there, but it is paid content and a guest token is refused.",
  },
  /** The pointer is not usable as a content id — a program, not a batch. */
  invalid: {
    label: "Khazana pointer unusable",
    short: "The archive id is a program, and no content shape accepts it.",
  },
  /** The archive answered, and it is genuinely empty. */
  empty: {
    label: "Khazana archive empty",
    short: "The archive answered but holds no subjects yet.",
  },
  /** The archive answered with content. */
  ok: {
    label: "Khazana available",
    short: "The archive is readable and listed below.",
  },
  /** The probe could not reach it. */
  error: {
    label: "Khazana unreachable",
    short: "The archive could not be reached this time.",
  },
};

/** Which states mean "there is something wrong that a human could fix". */
export const KHAZANA_ATTENTION = new Set(["locked", "invalid", "error"]);

/**
 * Read the archive pointer out of a batch detail payload.
 *
 * Some batches carry both Khazana and Pitara; Khazana wins because it is the one
 * the reader asked about, and the other is exposed alongside rather than dropped.
 */
export function archivePointers(detail) {
  const d = detail || {};
  const khazana = typeof d.khazanaProgramId === "string" ? d.khazanaProgramId.trim() : "";
  const pitara = typeof d.pitaraProgramId === "string" ? d.pitaraProgramId.trim() : "";
  return { khazana, pitara };
}

/**
 * The content shapes worth trying, in order.
 *
 * Each is a real endpoint this codebase already speaks to somewhere else — the
 * batch one is what `/v3/batches/<id>/subjects` serves for a normal batch — so
 * the ladder is a list of plausible readings rather than invented URLs. The
 * ladder exists because the pointer's *type* is ambiguous: for some batches it is
 * a batch id, for others the same field holds a program id.
 */
const SHAPES = [
  (id) => `/v3/batches/${encodeURIComponent(id)}/subjects`,
  (id) => `/v3/programs/${encodeURIComponent(id)}/subjects`,
  (id) => `/v3/batches/${encodeURIComponent(id)}/details`,
];

/**
 * Map one upstream answer onto a state.
 *
 * The status is the answer, but the *text* is checked as well: a credential
 * refusal that reaches us wrapped as a generic failure still says "401" in its
 * message, and reading that is the difference between telling a student "this is
 * paid content" and telling them "the site is broken".
 */
export function classifyAnswer(res) {
  if (!res) return "error";
  const said = String(res.error || "").toLowerCase();
  const status = Number(res.status) || (/refus|unauthori|forbidden|\b401\b|\b403\b/.test(said) ? 401 : 0);
  if (status === 401 || status === 403) return "locked";
  if (status === 400) return "invalid";
  if (status === 404) return "missing-shape";
  if (!res.ok) return "error";

  const data = res.data || {};
  const body = data.data && typeof data.data === "object" ? data.data : data;
  const subjects = Array.isArray(body.subjects) ? body.subjects : Array.isArray(body) ? body : null;
  if (!subjects) return "missing-shape";
  return subjects.length ? "ok" : "empty";
}

/** Normalise one upstream subject into the shape the site's subject cards use. */
function mapSubject(s, archiveId) {
  return {
    id: s._id || s.id || "",
    subjectId: s.subjectId || "",
    name: String(s.subject || s.name || "").trim(),
    // Deliberately *not* falling back to `_id`: the subject page needs a real
    // slug to resolve chapters, and an `_id` there produces a link that looks
    // like content and 404s on click. A row that cannot be opened is not content.
    slug: s.slug || s.subjectId || "",
    lectureCount: Number(s.lectureCount || s.videos || 0),
    tagCount: Number(s.tagCount || 0),
    displayOrder: Number.isFinite(s.displayOrder) ? s.displayOrder : 999,
    // The archive id is carried on every row: whatever the subject page needs to
    // fetch chapters, it must not have to re-derive which archive it came from.
    archiveId,
  };
}

/**
 * Can this archive id be opened as a batch?
 *
 * The site's chapter list is `SubjectInfo?BatchId=<id>`, so a subject row is only
 * useful if that id is a batch id. A 401 here is *not* a "no": the credential is
 * what is missing, not the batch, so the rows stay listed and stay locked.
 */
async function opensAsBatch(id, probe) {
  try {
    const res = await probe(`/v3/batches/${encodeURIComponent(id)}/subjects`);
    const said = String((res && res.error) || "").toLowerCase();
    const status = Number(res && res.status) || (/refus|unauthori|forbidden|\b401\b|\b403\b/.test(said) ? 401 : 0);
    if (status === 401 || status === 403) return true;
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

/**
 * Resolve a batch's archive.
 *
 * @param {string} programId  the pointer from the batch document
 * @param {object} opts
 * @param {(path:string)=>Promise<object>} opts.probe  injectable fetch, for tests
 * @returns {Promise<{state:string, programId:string, subjects:object[], note:string, tried:object[]}>}
 */
export async function readArchive(programId, opts = {}) {
  const id = String(programId || "").trim();
  if (!id) {
    return { state: "none", programId: "", subjects: [], note: KHAZANA_STATES.none.short, tried: [] };
  }

  const probe = opts.probe || ((path) => upstreamJson(path, { cacheSeconds: 60, timeout: 9000 }));
  const tried = [];
  let sawLocked = false;

  let programShape = false;
  for (const shape of SHAPES) {
    const path = shape(id);
    programShape = path.startsWith("/v3/programs/");
    let res;
    try {
      res = await probe(path);
    } catch (err) {
      tried.push({ path, state: "error", detail: String((err && err.message) || err).slice(0, 120) });
      continue;
    }

    const state = classifyAnswer(res);
    tried.push({
      path,
      state,
      status: Number(res && res.status) || 0,
      // Carry the upstream's own words. Without this an operator sees
      // `{"state":"error","status":0}` — which is exactly the shape of evidence
      // that sent the first production read of this feature looking in the wrong
      // place: it said "unreachable" while the truth was "a host refused a
      // credential and the walk turned that into a network error".
      detail: String((res && (res.error || (res.data && res.data.error))) || "").slice(0, 160),
    });

    if (state === "ok") {
      const body = res.data.data && typeof res.data.data === "object" ? res.data.data : res.data;
      const subjects = (Array.isArray(body.subjects) ? body.subjects : [])
        .map((s) => mapSubject(s, id))
        .filter((s) => s.slug && s.name)
        .sort((a, b) => a.displayOrder - b.displayOrder);
      if (!subjects.length) {
        // A 200 with rows that carry no slug is not content; fall through rather
        // than handing the page an empty list dressed as success.
        continue;
      }
      // Whether these rows can actually be *opened* is a separate question from
      // whether they were listed. Chapters come from `SubjectInfo?BatchId=`, which
      // only speaks batch ids, so an archive that answers in program form would
      // hand the reader rows that 404 on click — exactly the delivered-looking
      // feature this round exists to avoid. Check before claiming `ok`.
      if (programShape) {
        const opened = await opensAsBatch(id, probe);
        if (!opened) {
          return {
            state: "invalid",
            programId: id,
            subjects: [],
            note: "The archive answered, but only in program form — the chapter and lecture routes this site has speak batch ids, so these rows could not be opened. This is a defect in the source batch, not something a reader can fix.",
            tried,
          };
        }
      }
      return {
        state: "ok",
        programId: id,
        subjects,
        note: KHAZANA_STATES.ok.short,
        tried,
      };
    }

    if (state === "empty") {
      return {
        state: "empty",
        programId: id,
        subjects: [],
        note: KHAZANA_STATES.empty.short,
        tried,
      };
    }

    if (state === "locked") {
      // One refusal is enough to know the credential is not entitled, but keep
      // walking: a shape that answers 401 must not stop a later shape answering
      // 200, which is exactly what happened while this was being written.
      sawLocked = true;
    }
  }

  /* Nothing answered. Say which nothing, because the four nothings need four
     different actions: a token, a fix, a retry, or patience. */
  const anyReachable = tried.some((t) => t.state !== "error");
  if (sawLocked && !anyReachable) {
    return {
      state: "locked",
      programId: id,
      subjects: [],
      note: "The archive is paid content. Every content shape refused a guest credential — set a subscribed PW_TOKEN to read it.",
      needsSubscriberToken: true,
      tried,
    };
  }
  if (sawLocked) {
    return {
      state: "locked",
      programId: id,
      subjects: [],
      note: "The archive is paid content. Every content shape refused a guest credential — set a subscribed PW_TOKEN to read it.",
      needsSubscriberToken: true,
      tried,
    };
  }
  if (anyReachable) {
    return {
      state: "invalid",
      programId: id,
      subjects: [],
      note: "The archive pointer does not resolve to a readable content id (it looks like a program, not a batch).",
      tried,
    };
  }
  const refusedHost = tried.some((t) => /refus|unauthori|forbidden|401|403/i.test(t.detail || ""));
  return {
    state: refusedHost ? "locked" : "error",
    programId: id,
    subjects: [],
    note: refusedHost
      ? "The archive is paid content. The upstream refused this deployment's guest credential — set a subscribed PW_TOKEN to read it."
      : "The archive could not be reached. This is a network read, not a missing archive.",
    needsSubscriberToken: refusedHost || undefined,
    tried,
  };
}

/**
 * A one-line verdict for the panel, plus whether it is worth an operator's time.
 *
 * Deliberately quiet when a batch simply has no archive: that is the normal case
 * for most of the catalogue, and a warning per batch would make the panel
 * unreadable. Only `locked` and `invalid` say something a person can act on.
 */
export function archiveVerdict(report) {
  const state = (report && report.state) || "none";
  const meta = KHAZANA_STATES[state] || KHAZANA_STATES.error;
  return {
    state,
    label: meta.label,
    summary: (report && report.note) || meta.short,
    // Fail safe: a state this build has never heard of is an operator's problem,
    // not something to render as healthy. Silence is how a broken archive looks
    // exactly like an absent one.
    attention: KHAZANA_ATTENTION.has(state) || !KHAZANA_STATES[state],
    needsSubscriberToken: Boolean(report && report.needsSubscriberToken),
  };
}
