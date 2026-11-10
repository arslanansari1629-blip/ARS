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
/* Filters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Language labels are not normalised upstream: the catalogue contains both
 * `Assamese` and `ASSAMESE`, which became two entries in the filter dropdown
 * that returned different halves of the same language. Spanish-style aliases do
 * not exist, but two spellings that people genuinely type do (`Gujrati`,
 * `Bangla`), so both are matched.
 */
const LANGUAGE_ALIASES = {
  gujrati: "gujarati",
  gujarati: "gujarati",
  bangla: "bengali",
  bengali: "bengali",
  oriya: "odia",
  odia: "odia",
};

function languageKey(value) {
  const k = String(value || "").trim().toLowerCase();
  return LANGUAGE_ALIASES[k] || k;
}

/**
 * Correct spelling for languages the source site misspells or abbreviates.
 * A dropdown offering "Gujrati" and "Bangla" looks like a typo, and the filter
 * is more useful when it reads the way a student would search.
 */
const LANGUAGE_LABELS = {
  gujarati: "Gujarati",
  bengali: "Bengali",
  odia: "Odia",
  assamese: "Assamese",
};

/** Display label for a language key, preferring the commonest casing upstream. */
function languageLabel(batches, key) {
  if (LANGUAGE_LABELS[key]) return LANGUAGE_LABELS[key];
  const counts = new Map();
  for (const b of batches) {
    if (languageKey(b.language) !== key) continue;
    const shown = String(b.language || "").trim();
    counts.set(shown, (counts.get(shown) || 0) + 1);
  }
  // Title-case the winner so "ASSAMESE" does not shout from the dropdown.
  const winner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || key;
  return winner.charAt(0).toUpperCase() + winner.slice(1).toLowerCase();
}

/** Sort keys the API accepts. Exported so the route validates against one list. */
export const CATALOG_SORTS = new Set(["default", "name", "newest", "price", "free"]);
const SORTS = CATALOG_SORTS;

/** `13 Apr 2026` is the upstream date shape; Date parses it, but guard anyway. */
function timeOf(date) {
  const t = new Date(date || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

const feeOf = (b) => (typeof b.feeTotal === "number" ? b.feeTotal : null);

/**
 * Apply the language / price / sort filters to a hit list.
 *
 * These used to live in the browser and only ran over the twenty rows already
 * fetched, so "filter by Kannada" searched page 1 of 711 for one of 70 Kannada
 * batches and usually showed nothing. Filtering has to happen over the whole
 * catalogue to mean anything.
 */
function applyFilters(index, hits, { lang, price, sort }) {
  let out = hits;

  const key = lang ? languageKey(lang) : "";
  if (key) out = out.filter((i) => languageKey(index.batches[i].language) === key);

  if (price === "free") {
    out = out.filter((i) => feeOf(index.batches[i]) === 0);
  } else if (price === "paid") {
    out = out.filter((i) => (feeOf(index.batches[i]) || 0) > 0);
  }

  if (sort && SORTS.has(sort) && sort !== "default") {
    // Search hits are ordered by relevance, so a sort is only meaningful on an
    // unfiltered catalogue listing — but applying it anyway is what the control
    // promises. Ties fall back to shipped order so paging stays stable.
    const cmp = {
      name: (a, b) => index.batches[a].name.localeCompare(index.batches[b].name),
      newest: (a, b) => timeOf(index.batches[b].startDate) - timeOf(index.batches[a].startDate),
      price: (a, b) => (feeOf(index.batches[a]) ?? Infinity) - (feeOf(index.batches[b]) ?? Infinity),
      free: (a, b) => (feeOf(index.batches[b]) ?? -1) - (feeOf(index.batches[a]) ?? -1),
    }[sort];
    if (cmp) out = [...out].sort((a, b) => cmp(a, b) || a - b);
  }

  return out;
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
export async function searchLocalCatalog(term, limit = 60, opts = {}) {
  const q = String(term || "").trim().toLowerCase();
  const index = await loadCatalogIndex();

  // No query but filters selected: this is a filtered browse of the whole
  // catalogue, not an empty search. Returning [] here is what made "Free only"
  // with an empty search box show nothing at all.
  if (!q) {
    const all = index.batches.map((_b, i) => i);
    const kept = applyFilters(index, all, opts);
    return {
      ok: true,
      batches: kept.slice(0, limit).map((i) => index.batches[i]),
      total: kept.length,
      source: "local",
    };
  }

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

  const kept = applyFilters(index, hits, opts);
  const batches = kept.slice(0, limit).map((i) => index.batches[i]);
  return { ok: true, batches, total: kept.length, source: "local" };
}

/** One page of the complete catalogue, in the shipped (curated) order. */
export async function localCatalogPage(page = 1, pageSize = CATALOG_PAGE_SIZE, opts = {}) {
  const index = await loadCatalogIndex();
  const all = index.batches.map((_b, i) => i);
  const kept = applyFilters(index, all, opts);

  const total = kept.length;
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
    unfilteredTotal: index.batches.length,
    batches: kept.slice(start, start + size).map((i) => index.batches[i]),
    source: "local",
  };
}

/** Look a batch up locally — used when the upstream detail call fails. */
export async function localBatch(batchId) {
  const index = await loadCatalogIndex();
  const i = index.byId.get(String(batchId || ""));
  return i === undefined ? null : index.batches[i];
}

/**
 * Languages present in the catalogue, for the filter dropdown.
 *
 * Returns one entry per real language with its display label and count, so the
 * dropdown can say "Kannada (70)" and cannot offer the same language twice under
 * two casings. Ordered by count: the languages most people want come first.
 */
export async function catalogLanguages() {
  const index = await loadCatalogIndex();
  const counts = new Map();
  for (const b of index.batches) {
    const key = languageKey(b.language);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: languageLabel(index.batches, key), count }));
}

/** Price counts for the funnel — so the UI can label "Free (5,854)". */
export async function catalogPriceCounts() {
  const index = await loadCatalogIndex();
  let free = 0;
  for (const b of index.batches) if (feeOf(b) === 0) free += 1;
  return { free, paid: index.batches.length - free, total: index.batches.length };
}
