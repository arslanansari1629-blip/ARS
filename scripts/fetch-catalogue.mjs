/**
 * Refresh the batch catalogue.
 *
 * vidcloud.eu.org's client does not search an API — it downloads one complete
 * list of every PW batch and filters it locally:
 *
 *   https://rarestudy.github.io/rarestudy/batches.json
 *
 * We ship a normalised copy of that list so `/api/batches` can answer every
 * search instantly (and find batches the source site's own search cannot see),
 * without a live upstream call per keystroke.
 *
 *   node scripts/fetch-catalogue.mjs          # refresh data/batches.json
 *   node scripts/fetch-catalogue.mjs --check  # fail if the file is stale/missing
 *
 * The deploy is not blocked when the refresh fails: a slightly old catalogue
 * still beats an empty site, and the committed copy is valid data.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
// The committed artefact is the gzip (1.3 MB vs 7 MB of JSON); the runtime
// reads it straight out of memory. Both are written together so the two can
// never disagree.
const OUT_JSON = path.join(DATA, "batches.json");
const OUT_GZ = path.join(DATA, "batches.json.gz");

const SOURCES = [
  "https://rarestudy.github.io/rarestudy/batches.json",
  "https://cdn.jsdelivr.net/gh/rarestudy/rarestudy@main/batches.json",
];

async function download() {
  let lastError = null;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "eduvibe-pw-catalogue" },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        lastError = `${url} → ${res.status}`;
        continue;
      }
      const raw = await res.json();
      const list = Array.isArray(raw) ? raw : raw.batches;
      if (!Array.isArray(list) || !list.length) {
        lastError = `${url} → no batches`;
        continue;
      }
      return list;
    } catch (err) {
      lastError = `${url} → ${err.message}`;
    }
  }
  throw new Error(`catalogue refresh failed: ${lastError}`);
}

function normalise(list) {
  const out = [];
  const seen = new Set();
  for (const b of list) {
    const id = b && (b._id || b.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      // `normalizeBatch` upstream reads `_id`; keep the source shape so the
      // same normaliser works on both this file and a live API row.
      _id: id,
      name: (b.name || "").trim(),
      byName: (b.byName || "").trim(),
      slug: b.slug || "",
      language: b.language || "",
      startDate: b.startDate || "",
      endDate: b.endDate || "",
      feeTotal: typeof b.feeTotal === "number" ? b.feeTotal : null,
      type: b.type || "",
      // `normalizeBatch` reads `previewImage`; the source list uses that name.
      previewImage: b.previewImage || b.image || "",
      subBatches: Array.isArray(b.subBatches) ? b.subBatches : [],
    });
  }
  return out;
}

async function main() {
  const check = process.argv.includes("--check");

  if (check) {
    try {
      const info = await stat(OUT_GZ);
      const data = JSON.parse(gunzipSync(await readFile(OUT_GZ)).toString("utf8"));
      const count = (data.batches || []).length;
      if (!count) throw new Error("catalogue file is empty");
      const days = (Date.now() - info.mtimeMs) / 864e5;
      console.log(
        `OK — ${count} batches, ${(info.size / 1e6).toFixed(1)} MB, ${days.toFixed(1)} days old`
      );
      return;
    } catch (err) {
      console.error(`catalogue check failed: ${err.message}`);
      process.exit(1);
    }
  }

  try {
    const list = normalise(await download());
    const json = JSON.stringify({
      source: SOURCES[0],
      fetchedAt: new Date().toISOString(),
      count: list.length,
      batches: list,
    });
    await writeFile(OUT_JSON, json);
    await writeFile(OUT_GZ, gzipSync(json, { level: 9 }));
    console.log(
      `catalogue refreshed — ${list.length} batches → data/batches.json.gz (${(
        (await stat(OUT_GZ)).size / 1e6
      ).toFixed(2)} MB)`
    );
  } catch (err) {
    // Never fail the build on a refresh problem: the committed copy is valid.
    console.warn(`warning: ${err.message} (keeping the existing catalogue)`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
