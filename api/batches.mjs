import { json, cors, query, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchCatalogPage, searchCatalog } from "../lib/api-data.mjs";
import { searchLocalCatalog, localCatalogPage, CATALOG_SOURCE } from "../lib/catalog.mjs";

/**
 * GET /api/batches?page=1&pageSize=20   → the complete catalogue
 * GET /api/batches?search=arjuna        → search across every batch
 *
 * Discovery is served from the shipped complete catalogue (the same list
 * vidcloud.eu.org's client uses), because the upstream `searchBatch` endpoint
 * cannot see parts of the catalogue — searching "Capcut" used to return nothing
 * even though the batch exists and its detail page renders fine. If the local
 * index is somehow unavailable we fall back to the upstream endpoints so the
 * page still works, just with the source site's narrower search.
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { page, search, pageSize, lang } = query(req);

  try {
    if (search) {
      let out = null;
      try {
        out = await searchLocalCatalog(search, search ? 80 : 20);
      } catch {
        out = null;
      }

      if (!out || !out.ok) {
        const upstream = await searchCatalog(search);
        if (!upstream.ok) return proxyFallback(res, upstream);
        out = { ...upstream, source: "upstream" };
      }

      let batches = out.batches || [];
      if (lang) batches = batches.filter((b) => b.language === lang);

      return json(
        res,
        200,
        { success: true, mode: "search", ...out, batches, total: batches.length, catalog: CATALOG_SOURCE },
        120
      );
    }

    let out = null;
    try {
      out = await localCatalogPage(page, pageSize);
    } catch {
      out = null;
    }

    if (!out || !out.ok) {
      const upstream = await fetchCatalogPage(page);
      if (!upstream.ok) return proxyFallback(res, upstream);
      out = upstream;
    }

    return json(res, 200, { success: true, ...out, catalog: CATALOG_SOURCE }, 300);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}
