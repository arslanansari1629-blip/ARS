import { json, cors, query, badRequest, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchBatch, fetchBatchHeader } from "../lib/api-data.mjs";
import { readArchive, archiveVerdict, archivePointers } from "../lib/khazana.mjs";

/**
 * GET /api/batch?id=<batchId>            header + subject list (live upstream)
 * GET /api/batch?id=<batchId>&header=1   header only, from the shipped catalogue
 * GET /api/batch?id=<batchId>&khazana=1  the batch's Khazana archive
 *
 * The page calls `header=1` first: it is one indexed lookup against the local
 * catalogue, so the hero paints in milliseconds instead of waiting on a slow
 * upstream detail call. The full call then fills in the subject list.
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { id, header, khazana } = query(req);
  if (!id) return badRequest(res, "id is required");

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
    let pointer = programId;

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

    const result = await cachedArchive(pointer, () => readArchive(pointer));
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
