/**
 * Is anything missing from the shipped catalogue?
 *
 * The question comes up whenever a reference site advertises a bigger number
 * than ours ("18,568 batches" vs our 14,201). Sampling a few pages of that
 * site's list answers it by luck; this answers it by count.
 *
 *   node scripts/audit-coverage.mjs https://ours.example.com
 *
 * It walks the upstream `/AllBatches` list — paged, every id — and reports how
 * many of those ids are absent from the local catalogue. The upstream walk is
 * the important half: PW's own list is the only enumeration of *real* batches,
 * and it is a strict subset of what we ship, so "0 missing" is a strong answer
 * rather than a sample.
 *
 * Read-only. It never writes the catalogue and never deploys anything.
 */

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGUE = path.join(ROOT, "data", "batches.json.gz");

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node scripts/audit-coverage.mjs <site-base-url>");
  process.exit(2);
}

/** The shipped catalogue, straight from the artefact the runtime reads. */
async function localIds() {
  const raw = JSON.parse(gunzipSync(await readFile(CATALOGUE)).toString());
  const rows = Array.isArray(raw) ? raw : raw.batches || [];
  return { ids: new Set(rows.map((r) => r._id || r.id).filter(Boolean)), count: rows.length };
}

/** One page of upstream `/AllBatches`, through the site's own pw proxy. */
async function upstreamPage(page, limit) {
  const target = `/AllBatches?page=${page}&limit=${limit}`;
  const url = `${base}/api/pw?path=${encodeURIComponent(target)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${target} → HTTP ${res.status}`);
  const data = await res.json();
  const rows = data.batches || data.data || [];
  return {
    ids: rows.map((r) => r._id || r.id).filter(Boolean),
    total: Number(data.total || 0),
    totalPages: Number(data.totalPages || 0),
  };
}

const LIMIT = 20;

const local = await localIds();
console.log(`local catalogue: ${local.count} rows`);

const first = await upstreamPage(1, LIMIT);
if (!first.totalPages) throw new Error("the upstream list reported no page count");
console.log(`upstream list:   ${first.total} batches across ${first.totalPages} pages\n`);

const seen = new Set();
const missing = [];
const pageCount = first.totalPages;

for (let page = 1; page <= pageCount; page += 1) {
  const out = page === 1 ? first : await upstreamPage(page, LIMIT);
  for (const id of out.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!local.ids.has(id)) missing.push(id);
  }
  if (page % 50 === 0 || page === pageCount) {
    process.stdout.write(`\r  walked ${page}/${pageCount} pages, ${seen.size} ids, ${missing.length} missing`);
  }
}

console.log("\n");
console.log(`upstream ids seen:  ${seen.size}`);
console.log(`missing from local: ${missing.length}`);

if (missing.length) {
  console.log("\nmissing ids (first 50):");
  for (const id of missing.slice(0, 50)) console.log(`  ${id}`);
  process.exitCode = 1;
} else {
  // Say what this does and does not prove. The upstream list is the only
  // enumeration of real batches, so a clean walk means nothing that exists on
  // PW is absent here — it does not mean every row we ship is still live.
  console.log("\nevery batch PW enumerates is in the shipped catalogue");
}
