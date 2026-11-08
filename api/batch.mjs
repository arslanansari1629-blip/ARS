import { json, cors, query, badRequest, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchBatch } from "../lib/api-data.mjs";

/**
 * GET /api/batch?id=<batchId>
 * Batch header data + subject list (live from upstream).
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { id } = query(req);
  if (!id) return badRequest(res, "id is required");

  try {
    const out = await fetchBatch(id);
    if (!out.ok) return proxyFallback(res, out, "batch");
    return json(res, 200, { success: true, ...out }, 300);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}
