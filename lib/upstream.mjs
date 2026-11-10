/**
 * Upstream client for the ArsVibe PW data source.
 *
 * The source site (pw.eduvibe.cc.cd) renders its batch catalogue, subjects,
 * chapters, lectures, notes, DPPs, announcements and PDFs from a public
 * PenPencil-compatible JSON API. Every response our site serves is fetched
 * live from that upstream — nothing is hard-coded or scraped into fixtures.
 */

import { displayLanguage } from "./lang.mjs";

/**
 * Upstream for the site's own reads.
 *
 * Default is `pw`, meaning "in process": `upstreamJson` calls the same
 * authenticated dispatcher that `/api/pw` exposes (PW host failover and the
 * server-side guest token included) without an HTTP round trip. Pointing
 * `PW_UPSTREAM_BASE` at a URL still overrides this — the tests and a local
 * fixture upstream rely on that.
 *
 * This used to be the literal `/api/pw`, and on Vercel that self-fetch hit the
 * deployment URL, which sits behind deployment protection and answered an HTML
 * auth page: every lecture then resolved to "no video".
 */
export const UPSTREAM_BASE =
  (typeof process !== "undefined" && process.env && process.env.PW_UPSTREAM_BASE) || "pw";

/** True when reads go through the in-process PW dispatcher. */
const IN_PROCESS = UPSTREAM_BASE === "pw";

/** Secondary read-only mirror of the same catalogue (same batch ids). */
export const CATALOG_MIRRORS = [
  "https://www.learnxpw.site/api/AllBatches",
  "https://rarestudy.github.io/rarestudy/batches.json",
];

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Domains whose assets (images / PDFs) need our proxy to avoid CORS issues. */
export const ASSET_HOST_HINTS = [
  "pw.live",
  "cloudfront.net",
  "learnxpw.site",
  "penpencil",
];

const DEFAULT_TIMEOUT = 15000;

/** Absolute origin for same-deployment routes, only needed by relative bases. */
function selfBase() {
  const env = (typeof process !== "undefined" && process.env) || {};
  const explicit = env.PW_SELF_BASE || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  if (explicit) return explicit;
  return `http://127.0.0.1:${env.PORT || 3000}`;
}

export function isAssetUrl(url) {
  try {
    const host = new URL(url).hostname;
    return ASSET_HOST_HINTS.some((h) => host.includes(h));
  } catch {
    return false;
  }
}

/**
 * GET JSON from the upstream API.
 * Retries across the mirror base, with a couple of attempts and a browser UA
 * (Cloudflare rejects default server user-agents).
 */
/**
 * In-memory response cache.
 *
 * The catalogue, batch detail and chapter lists change at most a few times a
 * day, but they are fetched on every keystroke of the search box and every tab
 * switch. A short TTL keeps the site responsive when the upstream throttle
 * kicks in — and a cached catalogue is what makes a page load at all while
 * upstream is rate-limiting us. Stream/signature responses are never cached
 * here (they are signed and short-lived).
 */
const responseCache = new Map();
const MAX_CACHE_ENTRIES = 300;

export function clearUpstreamCache() {
  responseCache.clear();
}

/**
 * Route a same-deployment read through the PW dispatcher in-process.
 *
 * The dispatcher returns a `Response`, so the rest of `upstreamJson` does not
 * need to know which transport it got.
 */
async function inProcess(marked) {
  const { pwFetch } = await import("./pw-proxy.mjs");
  return pwFetch(marked.slice(3), { timeout: DEFAULT_TIMEOUT });
}

export async function upstreamJson(path, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, attempts = 2, cacheSeconds = 0 } = opts;
  let url;
  if (path.startsWith("http")) {
    url = path;
  } else if (IN_PROCESS) {
    url = `pw:${path.startsWith("/") ? path : `/${path}`}`;
  } else if (UPSTREAM_BASE.startsWith("/")) {
    // Same-deployment route: resolve it against ourselves so `fetch` gets an
    // absolute URL. On Vercel the deployment URL is in the environment; locally
    // the dev server listens on PORT.
    url = `${selfBase()}${UPSTREAM_BASE}${path}`;
  } else {
    url = `${UPSTREAM_BASE}${path}`;
  }

  const cached = cacheSeconds > 0 ? responseCache.get(url) : null;
  if (cached && cached.expires > Date.now()) return cached.value;

  let lastError = "upstream unavailable";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = IN_PROCESS ? await inProcess(url) : await fetch(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": UA,
          Origin: "https://www.learnxpw.site",
          Referer: "https://www.learnxpw.site/study/batches",
        },
        signal: AbortSignal.timeout(timeout),
        cache: "no-store",
      });

      const text = await res.text();
      if (!res.ok) {
        lastError = `upstream ${res.status}`;
        // 4xx other than rate-limit will not get better on retry
        if (res.status < 500 && res.status !== 429) break;
        continue;
      }

      try {
        const value = { ok: true, status: res.status, data: JSON.parse(text) };
        if (cacheSeconds > 0) {
          // Bound the cache: a long-lived lambda would otherwise grow forever.
          if (responseCache.size >= MAX_CACHE_ENTRIES) {
            const oldest = responseCache.keys().next().value;
            responseCache.delete(oldest);
          }
          responseCache.set(url, { value, expires: Date.now() + cacheSeconds * 1000 });
        }
        return value;
      } catch {
        lastError = "upstream returned a non-JSON body";
        // Cloudflare interstitials are HTML — retry once
        continue;
      }
    } catch (err) {
      lastError = err?.name === "TimeoutError" ? "upstream timed out" : err?.message || "network error";
    }
  }

  return { ok: false, status: 0, data: null, error: lastError };
}

/** Build a public asset URL from a PW asset descriptor. */
export function resolveAsset(asset, fallbackBase = "https://static.pw.live/") {
  if (!asset) return "";
  if (typeof asset === "string") {
    const v = asset.trim();
    if (!v) return "";
    if (v.startsWith("http://") || v.startsWith("https://")) return v;
    return `${fallbackBase.replace(/\/+$/, "")}/${v.replace(/^\/+/, "")}`;
  }
  if (typeof asset === "object") {
    const base = (asset.baseUrl || fallbackBase).replace(/\/+$/, "");
    const rel = asset.key || asset.path;
    if (rel) return `${base}/${String(rel).replace(/^\/+/, "")}`;
    if (asset._id) return `${base}/${asset._id}`;
  }
  return "";
}

/** Convert the API's HTML-ish descriptions into readable plain text. */
export function stripHtml(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeBatch(raw) {
  if (!raw || !raw._id) return null;
  const image =
    resolveAsset(raw.previewImage) || raw.previewImageUrl || resolveAsset(raw.image) || "";
  return {
    id: raw._id,
    name: (raw.name || raw.batchName || "Untitled batch").trim(),
    byName: (raw.byName || "").trim(),
    slug: raw.slug || "",
    // Normalised spelling: the source says "Gujrati" and "Bangla", and spells one
    // language two ways. The filter and the cards must not disagree about it.
    language: displayLanguage(raw.language),
    startDate: raw.startDate || "",
    endDate: raw.endDate || "",
    feeTotal: typeof raw.feeTotal === "number" ? raw.feeTotal : null,
    price: typeof raw.feeTotal === "number" ? raw.feeTotal : null,
    type: raw.type || "",
    image,
    subBatches: Array.isArray(raw.subBatches) ? raw.subBatches : [],
  };
}
