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
import { fetchSigned } from "./sign.mjs";
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

/**
 * The playback canary handle.
 *
 * Every other probe checks a component; this one checks the *product*: pick
 * the most recently resolved lecture folder (from the plan cache the admin
 * route registers), fetch its playlist and its first segment through the
 * real signing ladder, and time it. That is the check that would have
 * caught the day every third-party relay died at once — the components all
 * looked arguable while no lecture on the site could play.
 *
 * Throttled to one real run per two minutes per instance: the canary is a
 * signer client like any other, and a monitoring probe that adds load to
 * the thing it monitors becomes part of the incident.
 */
const CANARY_TTL_MS = 2 * 60 * 1000;
let canaryMemo = { at: 0, result: null };

function canaryHandle(caches = {}) {
  return {
    async run() {
      const now = Date.now();
      if (canaryMemo.result && now - canaryMemo.at < CANARY_TTL_MS) return canaryMemo.result;

      const finish = (result) => {
        canaryMemo = { at: Date.now(), result };
        return result;
      };

      const plans = caches.plans;
      const folder = plans && typeof plans.keys === "function" ? [...plans.keys()].pop() : "";
      if (!folder) {
        return finish({ ok: true, ms: 0, segments: 0, detail: "no lecture resolved yet on this instance" });
      }
      const cached = caches.renditions?.get?.(folder);
      const quality = cached?.renditions?.[0]?.quality || "360";
      const started = Date.now();
      const ms = () => Date.now() - started;

      const playlist = await fetchSigned(folder, `${quality}/main.m3u8`).catch((err) => ({
        ok: false,
        error: err?.message || "signer unreachable",
      }));
      if (!playlist.ok) {
        return finish({ ok: false, ms: ms(), segments: 0, rendition: quality, detail: `playlist: ${playlist.error}` });
      }
      const text = await playlist.response.text().catch(() => "");
      if (!text.includes("#EXTM3U")) {
        return finish({ ok: false, ms: ms(), segments: 0, rendition: quality, detail: "playlist is not an HLS playlist" });
      }
      const refs = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      if (!refs.length) {
        return finish({ ok: false, ms: ms(), segments: 0, rendition: quality, detail: "playlist carries no segments" });
      }

      // The first segment, however the playlist addresses it: a signed
      // absolute goes straight to PW's CDN (that URL is its credential),
      // a relative reference goes back through the signer ladder.
      const first = refs[0];
      let bytes = 0;
      let segOk = false;
      try {
        if (/^https?:\/\//i.test(first) && /[?&](Signature|Key-Pair-Id|Expires|Policy)=/i.test(first)) {
          const res = await fetch(first, { signal: AbortSignal.timeout(10000) });
          segOk = res.ok;
          bytes = (await res.arrayBuffer()).byteLength;
        } else {
          const key = /^https?:\/\//i.test(first)
            ? first.split(`/${folder}/`)[1]?.split("?")[0] || first
            : first.includes("/")
              ? first
              : `${quality}/${first}`;
          const seg = await fetchSigned(folder, key);
          segOk = Boolean(seg.ok);
          if (seg.ok) bytes = (await seg.response.arrayBuffer()).byteLength;
        }
      } catch {
        segOk = false;
      }
      if (!segOk || bytes < 10000) {
        return finish({
          ok: false,
          ms: ms(),
          segments: refs.length,
          rendition: quality,
          detail: segOk ? `first segment suspiciously small (${bytes} bytes)` : "first segment would not fetch",
        });
      }
      return finish({
        ok: true,
        ms: ms(),
        segments: refs.length,
        rendition: quality,
        via: process.env.ARS_SIGNER_URL ? "own worker ladder" : "signer ladder",
      });
    },
  };
}

/** The own-signer handle: is OUR worker alive, not just somebody's relay? */
function ownSignerHandle() {
  return {
    async run() {
      const base = String(process.env.ARS_SIGNER_URL || "").replace(/\/+$/, "");
      if (!base) return { ok: true, skipped: true, ms: 0, detail: "ARS_SIGNER_URL is not set" };
      const started = Date.now();
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
        const body = await res.json().catch(() => null);
        return {
          ok: res.ok && body?.ok === true,
          ms: Date.now() - started,
          detail: body?.tokenSource ? `token from ${body.tokenSource}` : `health answered ${res.status}`,
        };
      } catch (err) {
        return { ok: false, ms: Date.now() - started, detail: err?.message || "own worker unreachable" };
      }
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
    canary: canaryHandle(caches),
    ownsigner: ownSignerHandle(),
    client,
    caches,
    version: version || process.env.BUILD_STAMP || "",
  });

  if (traffic) registerTraffic(traffic);
}

export function healerWired() {
  return wired;
}
