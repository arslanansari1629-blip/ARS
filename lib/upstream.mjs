/**
 * Upstream client for the EduVibe PW data source.
 *
 * The source site (pw.eduvibe.cc.cd) renders its batch catalogue, subjects,
 * chapters, lectures, notes, DPPs, announcements and PDFs from a public
 * PenPencil-compatible JSON API. Every response our site serves is fetched
 * live from that upstream — nothing is hard-coded or scraped into fixtures.
 */

/**
 * Primary upstream for the site's own reads.
 *
 * `/api/pw` is our authenticated pass-through to this same API surface, so the
 * site benefits from the server-side guest token (and the host failover) instead
 * of hitting a public mirror unauthenticated. `PW_UPSTREAM_BASE` still wins,
 * which is what the tests and a local fixture upstream rely on.
 */
export const UPSTREAM_BASE =
  (typeof process !== "undefined" && process.env && process.env.PW_UPSTREAM_BASE) ||
  "/api/pw";

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

/** Absolute origin for same-deployment routes. */
function selfBase() {
  const env = (typeof process !== "undefined" && process.env) || {};
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  if (env.PW_SELF_BASE) return env.PW_SELF_BASE;
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

export async function upstreamJson(path, opts = {}) {
  const { timeout = DEFAULT_TIMEOUT, attempts = 2, cacheSeconds = 0 } = opts;
  let url;
  if (path.startsWith("http")) {
    url = path;
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
      const res = await fetch(url, {
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
    language: raw.language || "",
    startDate: raw.startDate || "",
    endDate: raw.endDate || "",
    feeTotal: typeof raw.feeTotal === "number" ? raw.feeTotal : null,
    price: typeof raw.feeTotal === "number" ? raw.feeTotal : null,
    type: raw.type || "",
    image,
    subBatches: Array.isArray(raw.subBatches) ? raw.subBatches : [],
  };
}
