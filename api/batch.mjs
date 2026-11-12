import { json, cors, query, badRequest, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchBatch, fetchBatchHeader } from "../lib/api-data.mjs";
import { readArchive, archiveVerdict, archivePointers } from "../lib/khazana.mjs";
import { fetchToday } from "../lib/today.mjs";
import {
  khazanaStateLabel,
  programSubjects,
  programShape,
  topicContents,
  topicContentsAll,
  programChapters,
  programTopics,
  topicSections,
} from "../lib/khazana-program.mjs";

/**
 * GET /api/batch?id=<batchId>            header + subject list (live upstream)
 * GET /api/batch?id=<batchId>&header=1   header only, from the shipped catalogue
 * GET /api/batch?id=<batchId>&khazana=1  the batch's Khazana archive
 * GET /api/batch?id=<batchId>&khazana=read&program=<programId>
 * GET /api/batch?id=<b>&khazana=subjects|chapters|topics|sections|contents
 * GET /api/batch?id=<batchId>&today=1   the classes scheduled for today (IST)
 *
 * The page calls `header=1` first: it is one indexed lookup against the local
 * catalogue, so the hero paints in milliseconds instead of waiting on a slow
 * upstream detail call. The full call then fills in the subject list.
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { id, header, khazana, today } = query(req);
  if (!id) return badRequest(res, "id is required");

  // The live-class strip. Its own route would be a thirteenth function, so it
  // rides here like Khazana does.
  if (today) return todayRoute(req, res, id, today);

  // Khazana lives on this route rather than in a twelfth function: it is a read
  // of one batch's archive, and the deployment's function cap is not negotiable.
  // `?khazana=1` returns the *state* without content; `?khazana=read` spends the
  // upstream probes. Splitting them is what stops a batch page paint from
  // costing three refused upstream calls every visit.
  if (khazana) return khazanaRoute(req, res, id, khazana);

  try {
    if (header === "1" || header === "true") {
      const out = await fetchBatchHeader(id);
      // A batch missing from the shipped catalogue still has to reach the slow
      // path — the header route is an optimisation, never a gate.
      if (out) return json(res, 200, { success: true, ...out }, 300);
    }

    const out = await fetchBatch(id);
    if (!out.ok) return proxyFallback(res, out, "batch");
    return json(res, 200, { success: true, ...out }, 300);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}


/* --------------------------------------------------------------- today */

/**
 * Cache the day per batch, not per second.
 *
 * Reading a day costs one upstream listing per subject — up to twelve of them —
 * and the answer changes at most when a class starts or ends. A minute is short
 * enough that a class going live is visible while a student is on the page, and
 * long enough that refreshing does not become an attack on the source.
 */
const todayCache = new Map();
const TODAY_TTL_MS = 60 * 1000;

function cachedToday(key, read) {
  const hit = todayCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TODAY_TTL_MS) return Promise.resolve(hit.value);
  return read().then((value) => {
    if (todayCache.size > 200) todayCache.delete(todayCache.keys().next().value);
    todayCache.set(key, { at: now, value });
    return value;
  });
}

/**
 * `GET /api/batch?id=<batch>&today=1`
 *
 * `today=at` accepts `now` — an ISO timestamp the caller can pin the clock with.
 * It exists because "is this class live" is a question about the current minute,
 * and a feature whose whole job is that question has to be testable at a fixed
 * minute rather than only at whatever time CI happens to run.
 */
async function todayRoute(req, res, batchId, mode) {
  if (req.method !== "GET") return methodNotAllowed(res);

  // `?at=` and `?now=` are the same switch. `now` is the spelling the fixture
  // upstream is asked with (see `lib/today.mjs`), so accepting it here means one
  // name for the clock rather than two that have to be kept in step.
  const q = query(req);
  const pinned = q.at || q.now || "";
  const parsed = pinned ? new Date(/^\d+$/.test(pinned) ? Number(pinned) : pinned) : new Date();
  const clock = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

  try {
    // The subject list is needed to know what to read, and there is only one
    // place to get it: the batch document. The shipped catalogue row does not
    // carry subjects at all (it has `subBatches`), so a "fast header" shortcut
    // here would be dead code dressed as an optimisation — it is not written.
    //
    // The cost is contained instead:
    //
    //  * the batch page already asks for this document, so on a normal visit the
    //    read below is served from the five-minute upstream cache;
    //  * the strip is mounted without blocking the rest of the page, so a slow
    //    detail call delays the classes and nothing else;
    //  * the day itself is cached for a minute per batch, so a refresh inside the
    //    same minute costs nothing at all.
    // An eight-second cap: `fetchBatch` itself allows nine for a cold detail
    // call, and a strip that waits nine seconds has missed the class it exists to
    // announce. Timing out leaves `subjects` empty, which the reader reports as
    // "no subjects to read" — an absence, not a claim about the schedule.
    const detail = await Promise.race([
      fetchBatch(batchId).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    const subjects = detail && detail.ok && Array.isArray(detail.subjects) ? detail.subjects : [];

    const key = `${batchId}|${Math.floor(clock.getTime() / TODAY_TTL_MS)}|${subjects.map((s) => s.slug).join(",").length}`;
    const day = await cachedToday(key, () => fetchToday(batchId, { now: clock, subjects }));

    return json(
      res,
      200,
      { success: true, batchId, today: day },
      // A day that is in progress is worth keeping for a minute; one that has
      // not started or is over can be kept longer, but the difference is not
      // worth a second code path.
      60
    );
  } catch (err) {
    return json(res, 200, {
      success: false,
      batchId,
      today: {
        ok: false,
        state: "error",
        day: "",
        classes: [],
        next: null,
        error: err?.message || "Today's classes could not be read",
      },
    });
  }
}


/* ------------------------------------------------------------- khazana */

/**
 * Cache the *outcome* of reading an archive, not just its content.
 *
 * A refusal is the common answer here, and three refused upstream calls per page
 * view is a price the upstream would start charging us for. Ten minutes is short
 * enough that setting `PW_TOKEN` begins working without a redeploy, and long
 * enough that a busy batch costs one probe per ten minutes.
 */
const archiveCache = new Map();
const ARCHIVE_TTL_MS = 10 * 60 * 1000;

function cachedArchive(key, read) {
  const hit = archiveCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ARCHIVE_TTL_MS) return Promise.resolve(hit.value);
  return read().then((value) => {
    // Bounded: an archive map that grows with the catalogue is a memory leak with
    // a nice name.
    if (archiveCache.size > 200) archiveCache.delete(archiveCache.keys().next().value);
    archiveCache.set(key, { at: now, value });
    return value;
  });
}

/**
 * `GET /api/batch?id=<batch>&khazana=1|read`
 *
 * `1` answers the pointer and the state the batch document already knows — no
 * upstream spend. `read` walks the content shapes and reports which one, if any,
 * could be read. Both answer with the same shape, so the tab renders one way.
 */
async function khazanaRoute(req, res, batchId, mode) {
  if (req.method !== "GET") return methodNotAllowed(res);

  try {
    // The pointer lives on the batch document. A caller that already knows it can
    // skip this lookup, which is what the batch page does with its own payload.
    const programId = String(query(req).program || "").trim();
    // For every level below the program, `id` *is* the program — the caller came
    // with a program id and nothing else. Requiring a duplicate `program=` there
    // was a trap: without it the route fell back to reading the id as a batch,
    // found no pointer, and answered "no archive" for a perfectly good archive.
    let pointer = programId || (SUB_ROUTES[mode] ? String(batchId || "").trim() : "");

    if (!pointer) {
      const detail = await fetchBatch(batchId);
      const doc = detail && detail.ok ? detail.batch : null;
      pointer = (doc && doc.khazana && doc.khazana.programId) || "";
      if (!pointer && doc) {
        // `fetchBatch` has already normalised the document; fall back to the raw
        // pointers when the normaliser did not carry one.
        const raw = archivePointers(doc);
        pointer = raw.khazana;
      }
    }

    if (!pointer) {
      return json(
        res,
        200,
        {
          success: true,
          khazana: archiveVerdict({ state: "none" }),
          programId: "",
          subjects: [],
        },
        300
      );
    }

    // Everything below the program level answers *content*, so it belongs above
    // the cheap-verdict branch: `?khazana=subjects` is not `?khazana=1`, and
    // routing it through the "state without content" path returned an empty
    // subject list that looked exactly like an empty archive.
    const sub = SUB_ROUTES[mode];
    if (sub) return subRoute(req, res, pointer, sub);

    if (mode !== "read") {
      return json(
        res,
        200,
        {
          success: true,
          khazana: archiveVerdict({ state: "known", programId: pointer }),
          programId: pointer,
          subjects: [],
        },
        300
      );
    }

    // Everything below the program level: subjects → chapters → topics →
    // tabs → lectures/notes. Each is one proxied read of the same v1/v2 surface,
    // so they share this function and this cache rather than adding five.
    const result = await cachedArchive(pointer, () => readProgram(pointer));
    return json(
      res,
      200,
      {
        success: true,
        khazana: archiveVerdict(result),
        programId: pointer,
        subjects: result.subjects,
        // The shapes tried and what each answered: the evidence for the verdict,
        // so an operator can disagree with it instead of trusting it.
        tried: result.tried,
      },
      // Content is cacheable; a refusal is not — the point of a refusal is that a
      // token change should be able to undo it promptly.
      result.state === "ok" || result.state === "empty" ? 300 : 60
    );
  } catch (err) {
    return json(res, 200, {
      success: false,
      khazana: archiveVerdict({ state: "error" }),
      error: err?.message || "Unexpected error",
    });
  }
}

/* ---------------------------------------------------- khazana program */

/**
 * Read a Khazana program through the surface that actually serves it.
 *
 * `readArchive` (the v3 ladder) is kept for the states it still describes — a
 * batch with no pointer, an unreachable upstream — but the content now comes from
 * `v1`/`v2`, which answer a guest credential. See `lib/khazana-program.mjs` for
 * the endpoint list and how it was verified.
 */
async function readProgram(programId) {
  const leg = await programSubjects(programId);
  if (!leg.ok) {
    return {
      state: leg.state === "missing" ? "invalid" : leg.state === "locked" ? "locked" : "error",
      programId,
      subjects: [],
      note:
        leg.state === "missing"
          ? "The archive id is not a program the upstream serves."
          : leg.state === "locked"
            ? "The upstream refused this deployment's credential."
            : "The archive could not be reached.",
      needsSubscriberToken: leg.state === "locked",
      tried: [{ path: `/v1/programs/${programId}/subjects`, state: leg.state, status: leg.status || 0 }],
    };
  }
  return {
    state: leg.state, // "ok" | "empty"
    programId,
    subjects: leg.subjects,
    note: leg.state === "ok" ? "The archive is readable." : "The archive answered but holds nothing yet.",
    tried: [{ path: `/v1/programs/${programId}/subjects`, state: leg.state, status: 200 }],
  };
}

/**
 * The five reads below the program level.
 *
 * Each takes its parent ids from the query and returns one normalised list, so
 * the pages never have to know an endpoint shape. `cache` is the same outcome
 * cache the archive read uses: these are static per program and change rarely.
 */
const SUB_ROUTES = {
  // `subjects` is the one level where the answer's *kind* matters: a course lists
  // Physics/Chemistry, an archive lists "Complete Physics - 11th". The page has
  // to know which it is holding before it decides what to draw.
  subjects: (q, id) => programShape(id),
  chapters: (q, id) => programChapters(id, q.subject),
  topics: (q, id) => programTopics(id, q.subject, q.chapter),
  sections: (q, id) => topicSections(id, q.subject, q.chapter, q.topic),
  // The player needs the whole topic, not the first 20 rows: a lecture clicked
  // from page 2 has to exist in the queue for prev/next to work.
  contents: (q, id) =>
    q.page
      ? topicContents(id, q.subject, q.chapter, q.topic, q.page)
      : topicContentsAll(id, q.subject, q.chapter, q.topic),
};

const REQUIRED = {
  chapters: ["subject"],
  topics: ["subject", "chapter"],
  sections: ["subject", "chapter", "topic"],
  contents: ["subject", "chapter", "topic"],
};

async function subRoute(req, res, programId, read) {
  const q = query(req);
  const mode = String(q.khazana || "");
  const missing = (REQUIRED[mode] || []).filter((k) => !String(q[k] || "").trim());
  if (missing.length) return badRequest(res, `${missing.join(", ")} required for khazana=${mode}`);

  const key = `program:${programId}:${mode}:${q.subject || ""}:${q.chapter || ""}:${q.topic || ""}:${q.page || 1}`;
  try {
    const out = await cachedArchive(key, () => read(q, programId));
    const payload = {
      success: Boolean(out.ok),
      programId,
      ...out,
      // The same `khazana` object every other mode answers with, so a consumer
      // that only knows how to read a verdict still learns what happened.
      khazana: {
        state: out.state || (out.ok ? "ok" : "error"),
        programId,
        label: khazanaStateLabel(out.state),
        attention: false,
        needsSubscriberToken: Boolean(out.needsSubscriberToken),
      },
    };
    delete payload.status;
    // Content is worth caching; a refusal is not — the point of a refusal is that
    // a credential change should undo it promptly.
    return json(res, out.ok ? 200 : 200, payload, out.ok ? 300 : 60);
  } catch (err) {
    return json(res, 200, {
      success: false,
      error: err?.message || "Unexpected error",
      state: "error",
    });
  }
}
