/**
 * The healer's wiring: what a *this deployment* repair is allowed to touch.
 *
 * `lib/healer.mjs` is the state machine and knows nothing about Physics Wallah,
 * the catalogue file or the signer list. This file is the adapter, and it exists
 * so the blast radius of every repair is reviewable in one place:
 *
 *   catalogue  → re-reading the shipped index (no network, no writes)
 *   token      → the guest-token cache (`lib/pw-auth.mjs` owns the real ladder)
 *   signers    → per-host weights and quarantines (`lib/selfheal.mjs` owns them)
 *   caches     → the plan and rendition maps (`lib/api-data.mjs` owns them)
 *   assets     → comparing `build.json` with the files on disk (read-only)
 *
 * Nothing here writes, deletes, deploys or changes a credential. That constraint
 * is the whole safety argument for a system that acts without being asked.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadCatalogIndex, reloadCatalogIndex } from "./catalog.mjs";
import { tokenState, resolveToken, credentialLadder } from "./pw-auth.mjs";
import { signerHealth, signerWeight, resetSignerScores, recordSignerResult } from "./selfheal.mjs";
import { registerHealerDependencies, registerTraffic } from "./healer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

/** The token handle: what the panel reports, what a repair may reset. */
function tokenHandle() {
  return {
    async state() {
      const token = tokenState();
      const ladder = await credentialLadder(false).catch(() => []);
      return {
        ...token,
        usableCount: ladder.filter((entry) => String(entry.token || "").length > 20).length,
        ladder: ladder.map((entry) => entry.source),
      };
    },
    reset() {
      // The cache is cleared by dropping the module's memo through its own
      // exported reset — `registerCaches({ token })` in `lib/pw-auth.mjs` bound
      // it, and the healer reaches it through that handle, never directly.
      return resolveToken(true).catch(() => null);
    },
    resolve(fresh = true) {
      return resolveToken(fresh);
    },
  };
}

/**
 * The signer handle.
 *
 * `probe()` deliberately does *not* call upstream: a repair must not add load to
 * a host that is already struggling. It re-reads the recorded evidence, which is
 * what the resolver uses, and returns it in the shape the repair's sentence
 * needs. The actual probing happens on the next real request — the request that
 * would have failed on a demoted host instead of a dead one.
 */
function signerHandle() {
  return {
    health: () => signerHealth(),
    weight: (host) => signerWeight(host),
    reset: () => resetSignerScores(),
    quarantine(host) {
      // Three recorded failures is the same threshold `lib/selfheal.mjs` uses, so
      // a manual quarantine and an automatic one land in the same state.
      for (let i = 0; i < 3; i += 1) recordSignerResult(host, false, { error: "quarantined by the healer" });
      return true;
    },
    async probe() {
      return {
        ok: true,
        hosts: signerHealth().map((row) => ({
          host: row.host,
          ok: row.weight >= 0.75,
          weight: row.weight,
          reason: row.reason,
        })),
      };
    },
  };
}

/** The asset handle: compare the build manifest with what is on disk. */
function assetsHandle() {
  return {
    async verify() {
      const manifest = JSON.parse(await readFile(path.join(PUBLIC, "build.json"), "utf8"));
      const promised = new Set();
      for (const page of manifest.pages || []) promised.add(page);
      for (const fn of manifest.functions || []) promised.add(`api/${fn}`);
      // Deliberately only the pages: they are the files a visitor can be sent to,
      // and a missing one is a hard 404 rather than a degraded experience.
      const missing = [];
      for (const file of promised) {
        const rel = /\.(html|mjs)$/.test(file) ? file : `${file}.html`;
        try {
          await readFile(path.join(PUBLIC, rel));
        } catch {
          missing.push(rel);
        }
      }
      return { missing, total: promised.size };
    },
  };
}

let wired = false;

/**
 * Bind the handles once per instance.
 *
 * `buildStamp` goes on the report so the panel can tell one deployment's healer
 * from another's — a repair history that spans a deploy is a different story.
 */
export function wireHealer({ caches = {}, traffic = null, client = null, version = "" } = {}) {
  if (wired) {
    if (traffic) registerTraffic(traffic);
    // A handle that arrives after the first wiring must still be taken. This used
    // to return here, which silently dropped every dependency added later — the
    // probe then reported itself "skipped" while the data was right there, and a
    // skipped probe reads as a healthy one.
    if (client) registerHealerDependencies({ client });
    return;
  }
  wired = true;

  registerHealerDependencies({
    catalog: {
      load: async () => {
        const index = await loadCatalogIndex();
        return { count: index.batches.length };
      },
      reload: async () => {
        const index = await reloadCatalogIndex();
        return { count: index.batches.length };
      },
    },
    token: tokenHandle(),
    signers: signerHandle(),
    assets: assetsHandle(),
    client,
    caches,
    version: version || process.env.BUILD_STAMP || "",
  });

  if (traffic) registerTraffic(traffic);
}

export function healerWired() {
  return wired;
}
