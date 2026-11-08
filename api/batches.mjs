import { json, cors, query, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchCatalogPage, searchCatalog } from "../lib/api-data.mjs";

/**
 * GET /api/batches?page=1        → paginated catalogue (live from upstream)
 * GET /api/batches?search=arjuna → search
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { page, search } = query(req);

  try {
    if (search) {
      const out = await searchCatalog(search);
      if (!out.ok) return proxyFallback(res, out);
      return json(res, 200, { success: true, mode: "search", ...out }, 120);
    }

    const out = await fetchCatalogPage(page);
    if (!out.ok) return proxyFallback(res, out);
    return json(res, 200, { success: true, ...out }, 300);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}
