/**
 * Local batch catalogue.
 *
 * The upstream "AllBatches" endpoint we proxy is paginated and *unsearchable*
 * for a lot of the catalogue: `searchBatch` on the source site misses batches
 * that definitely exist (verified against live ids). vidcloud.eu.org does not
 * use a search endpoint at all — its client downloads one complete JSON list of
 * every batch and filters it in the browser:
 *
 *   https://rarestudy.github.io/rarestudy/batches.json   (≈14 200 batches)
 *
 * We ship that same list (data/batches.json, refreshed from the same URL) and
 * search it locally, so a batch that exists upstream can always be found even
 * when the source site's own search cannot see it. Live batch *details* still
 * come from the upstream API — this file only fixes discovery.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { normalizeBatch } from "./upstream.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
// The committed artefact is the gzip (1.3 MB); the plain JSON is a local
// build product. Prefer whichever exists so `npm run build` and a bare checkout
// both work.
const CATALOG_FILES = [
  path.join(DATA_DIR, "batches.json.gz"),
  path.join(DATA_DIR, "batches.json"),
];

/** Where the shipped list came from — exposed so the UI can credit the source. */
export const CATALOG_SOURCE = "https://rarestudy.github.io/rarestudy/batches.json";

/** Page size for the full list. Matches the source site's grid. */
export const CATALOG_PAGE_SIZE = 20;

let loadPromise = null;

/**
 * Load and index the catalogue once per lambda instance.
 *
 * The file is ~7 MB of JSON; parsing it on every request would be wasteful, so
 * the parsed index is memoised. A failed load is not cached — the next request
 * retries instead of permanently poisoning the instance.
 */
export async function loadCatalogIndex() {
  if (!loadPromise) {
    loadPromise = readCatalogFile()
      .then((text) => buildIndex(JSON.parse(text)))
      .catch((err) => {
        loadPromise = null;
        throw err;
      });
  }
  return loadPromise;
}

async function readCatalogFile() {
  let lastError = null;
  for (const file of CATALOG_FILES) {
    try {
      const buf = await readFile(file);
      return file.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("catalogue file missing");
}

function buildIndex(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.batches) ? raw.batches : [];
  const batches = list.map(normalizeBatch).filter(Boolean);

  // Pre-lowercase the searchable text once: a 14k-row scan is then a cheap
  // substring test instead of re-lowercasing 14k names per keystroke.
  const haystack = batches.map((b) =>
    `${b.name} ${b.byName || ""} ${b.slug || ""}`.toLowerCase()
  );

  return {
    batches,
    haystack,
    byId: new Map(batches.map((b, i) => [b.id, i])),
  };
}

/* ------------------------------------------------------------------ */
/* Ordering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Best-first ordering for matches.
 *
 * The source site keeps the list in its own "curated" order (newest batches
 * first). Keeping the shipped order as the tie-breaker means search results
 * look familiar to someone coming from vidcloud, while an exact/prefix name
 * match still floats to the top.
 */
function score(index, i, q) {
  const b = index.batches[i];
  const name = b.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (new RegExp(`(^|\\s)${escapeRegExp(q)}`).test(name)) return 2;
  if (name.includes(q)) return 3;
  return 4;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Queries                                                            */
/* ------------------------------------------------------------------ */

/**
 * Search the whole catalogue from local data.
 *
 * Every whitespace-separated token must appear somewhere in the row ("class 10
 * bihar" only matches rows containing all three), which is what people expect
 * from a search box and is strictly better than the upstream substring match.
 */
export async function searchLocalCatalog(term, limit = 60) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return { ok: true, batches: [], total: 0, source: "local" };

  const index = await loadCatalogIndex();
  const tokens = q.split(/\s+/).filter(Boolean);

  const hits = [];
  for (let i = 0; i < index.haystack.length; i++) {
    const hay = index.haystack[i];
    if (!tokens.every((t) => hay.includes(t))) continue;
    hits.push(i);
  }

  hits.sort((a, b) => {
    const d = score(index, a, q) - score(index, b, q);
    return d !== 0 ? d : a - b;
  });

  const batches = hits.slice(0, limit).map((i) => index.batches[i]);
  return { ok: true, batches, total: hits.length, source: "local" };
}

/** One page of the complete catalogue, in the shipped (curated) order. */
export async function localCatalogPage(page = 1, pageSize = CATALOG_PAGE_SIZE) {
  const index = await loadCatalogIndex();
  const total = index.batches.length;
  const size = Math.max(1, Math.min(100, Number(pageSize) || CATALOG_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const start = (p - 1) * size;

  return {
    ok: true,
    page: p,
    totalPages,
    total,
    pageSize: size,
    batches: index.batches.slice(start, start + size),
    source: "local",
  };
}

/** Look a batch up locally — used when the upstream detail call fails. */
export async function localBatch(batchId) {
  const index = await loadCatalogIndex();
  const i = index.byId.get(String(batchId || ""));
  return i === undefined ? null : index.batches[i];
}

/** Languages present in the catalogue, for the filter dropdown. */
export async function catalogLanguages() {
  const index = await loadCatalogIndex();
  const set = new Set(index.batches.map((b) => b.language).filter(Boolean));
  return Array.from(set).sort();
}
