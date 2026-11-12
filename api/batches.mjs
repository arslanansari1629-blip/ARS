import { json, cors, query, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { tick, TICK_GRACE_MS } from "../lib/scheduler.mjs";
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
 * GET /api/batches?q=arjuna             → same thing; `q` is accepted as an alias
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

  // Five-minute cadence: two number comparisons when it is not time, and a
  // bounded wait when it is. It can never throw into the request.
  //
  // The headers are the only way to see this from outside. Each function instance
  // has its own memory, so the admin panel's copy of the scheduler cannot see a
  // tick that happened here — an operator checking whether the cadence is real
  // needs the route that ran it to say so.
  try {
    const t = tick(req);
    res.setHeader("X-Scan-Tick", t.ticked ? "started" : "wait");
    if (t.nextInMs) res.setHeader("X-Scan-Next", String(Math.ceil(t.nextInMs / 1000)));
    if (t.ticked && t.slice) {
      // Hold for the slice, but never longer than the grace. The alternative — a
      // fully detached slice — is one the platform may freeze the moment the
      // response is sent, which is a scheduler that quietly finishes nothing.
      const done = await Promise.race([
        t.slice.then(() => "done").catch(() => "failed"),
        new Promise((resolve) => setTimeout(() => resolve("running"), TICK_GRACE_MS)),
      ]);
      res.setHeader("X-Scan-Slice", done);
    }
  } catch {
    /* a scheduler fault must not cost a catalogue page */
  }

  const { page, search, q, pageSize, lang, price, sort, facets } = query(req);

  // `?q=` is the short form bookmarks, the search box and the reference site all
  // use. It used to be ignored, which silently answered `/api/batches?q=Lakshya`
  // with the whole 14,201-row catalogue instead of a match — a wrong answer that
  // looks like a working one. Accept it as an alias for the documented `search`.
  const term = String(search ?? q ?? "").trim();

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

    if (term || lang || (price && price !== "all")) {
      let out = null;
      try {
        // 80 hits is a generous first page; `total` carries the real count so
        // the UI can say "showing the closest 80 of 431".
        out = await searchLocalCatalog(term, 80, filters);
      } catch {
        out = null;
      }

      if (!out || !out.ok) {
        // The upstream search cannot filter or see the whole catalogue, so it is
        // only a last resort when the local index is unavailable.
        if (!term) return json(res, 503, { success: false, error: "Catalogue index unavailable" });
        const upstream = await searchCatalog(term);
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
