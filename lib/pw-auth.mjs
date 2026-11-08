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

/**
 * How long a minted token is actually good for.
 *
 * The cache used to assume ten minutes for every token, which is two mistakes in
 * one: it threw away tokens that were valid for longer (a needless re-mint on
 * every lecture), and it kept trusting tokens that had already expired (the most
 * common cause of a lecture failing halfway through). The token is a JWT, so it
 * states its own expiry — read it, and only fall back to ten minutes when the
 * claim is absent or unparseable.
 */
const DEFAULT_TTL = 10 * 60 * 1000;
/** Re-mint this long before the real expiry, so a request never races it. */
const TTL_MARGIN = 60 * 1000;

export function tokenExpiry(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return 0;
    // base64url → base64, then pad.
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp = Number(json.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** When to stop using `token`, honouring its own `exp` claim. */
function freshUntil(token) {
  const expiresAt = tokenExpiry(token);
  if (!expiresAt) return Date.now() + DEFAULT_TTL;
  return Math.max(Date.now(), expiresAt - TTL_MARGIN);
}

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
      cache = { token, source, expires: freshUntil(token) };
      return { token, source, cached: false };
    } catch {
      /* next source */
    }
  }

  // A stale cached token still beats nothing at all.
  if (cache.token) return { token: cache.token, source: `${cache.source} (stale)`, cached: true };
  return { token: FALLBACK_TOKEN, source: "built-in fallback", cached: true };
}

/**
 * Every credential we can present, best first, de-duplicated.
 *
 * A single token is a hard ceiling on what the API will answer, and the failure
 * mode is silent: one 401 and the endpoint looks like it "does not exist". Real
 * access is a *lattice*, not one string — a pinned operator token, the pinned env
 * token, whatever the relays are publishing right now, and the long-lived
 * anonymous token several open-source clients ship. Presenting all of them, in
 * that order, is what turns "authorised for most lectures" into "authorised for
 * every lecture the upstream will serve at all".
 *
 * `fresh` forces a re-mint of the relay token, which is the common case: the
 * cached one expired mid-lecture.
 *
 * @param {boolean} [fresh]
 * @returns {Promise<Array<{token: string, source: string}>>}
 */
export async function credentialLadder(fresh = false) {
  const seen = new Set();
  const ladder = [];
  const add = (token, source) => {
    if (!usable(token) || seen.has(token)) return;
    seen.add(token);
    ladder.push({ token, source });
  };

  const env = (typeof process !== "undefined" && process.env) || {};
  add(env.PW_TOKEN, "env:PW_TOKEN");
  add(env.PW_TOKEN_FALLBACK, "env:PW_TOKEN_FALLBACK");

  try {
    const primary = await resolveToken(fresh);
    add(primary.token, primary.source);
  } catch {
    /* fall through to the static token */
  }

  // Last resort, always tried: it needs no network and cannot expire overnight.
  add(FALLBACK_TOKEN, "built-in fallback");
  return ladder;
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
  // `expiresIn` is now the token's own remaining lifetime (from its `exp` claim),
  // not an assumption. `expiresAt` is included so a caller can see the wall clock
  // it is working towards.
  const selfExpiry = tokenExpiry(cache.token);
  const remaining = selfExpiry ? selfExpiry - Date.now() : cache.expires - Date.now();
  return {
    ...cache,
    expiresIn: Math.max(0, Math.round(remaining / 1000)),
    expiresAt: selfExpiry ? new Date(selfExpiry).toISOString() : "",
    expiryFrom: selfExpiry ? "token exp claim" : "assumed 10m",
  };
}
