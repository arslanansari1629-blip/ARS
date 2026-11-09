import { json, cors, query, badRequest, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchBatch, fetchBatchHeader } from "../lib/api-data.mjs";

/**
 * GET /api/batch?id=<batchId>            header + subject list (live upstream)
 * GET /api/batch?id=<batchId>&header=1   header only, from the shipped catalogue
 *
 * The page calls `header=1` first: it is one indexed lookup against the local
 * catalogue, so the hero paints in milliseconds instead of waiting on a slow
 * upstream detail call. The full call then fills in the subject list.
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { id, header } = query(req);
  if (!id) return badRequest(res, "id is required");

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
