import { json, cors, query, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { tick } from "../lib/scheduler.mjs";
import { CATALOG_SORTS as SORTS, normaliseSort } from "../lib/catalog.mjs";
import { fetchCatalogPage, searchCatalog } from "../lib/api-data.mjs";
import {
  searchLocalCatalog,
  localCatalogPage,
  catalogLanguages,
  catalogPriceCounts,
  CATALOG_SOURCE,
} from "../lib/catalog.mjs";

/**
 * GET /api/batches?page=1&pageSize=20   → the complete catalogue
 * GET /api/batches?search=arjuna        → search across every batch
 * GET /api/batches?facets=1             → languages and price counts for the filters
 *
 * `lang`, `price` (free|paid) and `sort` (name|newest|price-asc|price-desc) are
 * applied
 * over the whole catalogue before paging. They used to be applied in the browser
 * to the twenty rows already fetched, which is why filtering by a language with
 * 70 batches across 711 pages usually showed an empty grid.
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

  // Five-minute cadence: cheap when it is not time (two number comparisons),
  // detached when it is, and it can never throw into the request.
  try {
    tick(req);
  } catch {
    /* a scheduler fault must not cost a catalogue page */
  }

  const { page, search, pageSize, lang, price, sort, facets } = query(req);

  try {
    if (facets) {
      const [languages, prices] = await Promise.all([catalogLanguages(), catalogPriceCounts()]);
      return json(res, 200, { success: true, languages, prices, catalog: CATALOG_SOURCE }, 3600);
    }

    // Echo the sort the catalogue actually applied, not the raw query string:
    // a legacy ?sort=price is really "price-asc", and reporting "price" back
    // would describe a sort key this API no longer has.
    const wanted = normaliseSort(sort);
    const filters = { lang, price, sort: SORTS.has(wanted) ? wanted : "default" };

    if (search || lang || (price && price !== "all")) {
      let out = null;
      try {
        // 80 hits is a generous first page; `total` carries the real count so
        // the UI can say "showing the closest 80 of 431".
        out = await searchLocalCatalog(search, 80, filters);
      } catch {
        out = null;
      }

      if (!out || !out.ok) {
        // The upstream search cannot filter or see the whole catalogue, so it is
        // only a last resort when the local index is unavailable.
        if (!search) return json(res, 503, { success: false, error: "Catalogue index unavailable" });
        const upstream = await searchCatalog(search);
        if (!upstream.ok) return proxyFallback(res, upstream);
        out = { ...upstream, source: "upstream" };
      }

      return json(
        res,
        200,
        { success: true, mode: "search", ...out, filters, catalog: CATALOG_SOURCE },
        120
      );
    }

    let out = null;
    try {
      out = await localCatalogPage(page, pageSize, filters);
    } catch {
      out = null;
    }

    if (!out || !out.ok) {
      const upstream = await fetchCatalogPage(page);
      if (!upstream.ok) return proxyFallback(res, upstream);
      out = upstream;
    }

    return json(res, 200, { success: true, ...out, filters, catalog: CATALOG_SOURCE }, 300);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}
