/**
 * PW credential resolution.
 *
 * Every PW-compatible host (`api.penpencil.co`, `api.penpencil.xyz`,
 * vidcloud.eu.org, api.studyspark.study, learnxpw.site) wants the same header
 * set, and the lecture/DPP/OTP endpoints additionally want an `authorization`
 * bearer. The bearer is a real PW user token, which we cannot mint: PW issues
 * those to signed-in accounts only.
 *
 * What *is* publicly available is the guest token the partner relays publish
 * for their own apps, and those relays accept it as either a header or the
 * `authorization` query parameter. So:
 *
 *   • resolve the freshest guest token we can get (cache it, honour expiry);
 *   • let an operator pin a token with the PW_TOKEN env var;
 *   • expose the exact header set every route uses, so the proxy, the signer
 *     and the stream resolver cannot drift apart.
 */

export const CLIENT_ID = "5eb393ee95fab7468a79d189";
export const CLIENT_VERSION = "5.2.1";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Hosts that publish a usable guest token for their own client. */
export const TOKEN_SOURCES = [
  "https://vidcloud.eu.org/generate_token.php",
  "https://proxy.streamvideo.co.in/generate_token.php",
  "https://vidcloud.eu.org/api/generate_token.php",
];

/**
 * Public fallback token shipped by several open-source PW clients. It is a
 * well-known anonymous token, not a credential of ours.
 */
export const FALLBACK_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";

const TOKEN_TTL = 10 * 60 * 1000;

let cache = { token: "", source: "", expires: 0 };

/** Random request id PW expects on every call. */
export function randomId() {
  // Not security-sensitive: PW only uses it to correlate a request.
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

/** Normalise whatever a token endpoint returned into a bare token string. */
function parseTokenBody(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  let value = raw;
  try {
    const j = JSON.parse(raw);
    value =
      (typeof j === "string" && j) ||
      j.access_token ||
      j.token ||
      (j.data && (j.data.access_token || j.data.token)) ||
      "";
  } catch {
    /* plain text token */
  }
  return String(value)
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function usable(token) {
  return Boolean(token) && token.length > 15 && !token.includes("<");
}

/**
 * Resolve a guest token.
 *
 * @param {boolean} [fresh] ignore the cache (a token can expire mid-lecture)
 * @returns {Promise<{token: string, source: string, cached: boolean}>}
 */
export async function resolveToken(fresh = false) {
  const pinned = (typeof process !== "undefined" && process.env && process.env.PW_TOKEN) || "";
  if (usable(pinned)) return { token: pinned, source: "env:PW_TOKEN", cached: true };

  if (!fresh && cache.token && cache.expires > Date.now()) {
    return { token: cache.token, source: cache.source, cached: true };
  }

  for (const source of TOKEN_SOURCES) {
    try {
      const res = await fetch(source, {
        headers: { Accept: "application/json, text/plain, */*", "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      });
      if (!res.ok) continue;
      const token = parseTokenBody(await res.text());
      if (!usable(token)) continue;
      cache = { token, source, expires: Date.now() + TOKEN_TTL };
      return { token, source, cached: false };
    } catch {
      /* next source */
    }
  }

  // A stale cached token still beats nothing at all.
  if (cache.token) return { token: cache.token, source: `${cache.source} (stale)`, cached: true };
  return { token: FALLBACK_TOKEN, source: "built-in fallback", cached: true };
}

/** Back-compat shim: the resolver in `lib/api-data.mjs` only wants the string. */
export async function guestToken(fresh = false) {
  return (await resolveToken(fresh)).token;
}

/**
 * The header set every PW-compatible host expects.
 *
 * `referer`/`origin` matter: several of these hosts answer 401 to a request
 * that does not look like it came from their own web app.
 */
export function pwHeaders(token, extra = {}) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-IN,en;q=0.9",
    "User-Agent": BROWSER_UA,
    "client-id": CLIENT_ID,
    "client-type": "WEB",
    "client-version": CLIENT_VERSION,
    randomid: randomId(),
    origin: "https://www.pw.live",
    referer: "https://www.pw.live/",
    ...(token ? { authorization: `Bearer ${token}`, token } : {}),
    ...extra,
  };
}

/** Same credentials, as query parameters (what `get-hls-key` expects). */
export function pwParams(token) {
  return token ? { authorization: token } : {};
}

/** Cached token state, for the /api/token diagnostic route. */
export function tokenState() {
  return { ...cache, expiresIn: Math.max(0, Math.round((cache.expires - Date.now()) / 1000)) };
}
