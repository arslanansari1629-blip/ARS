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

// The healer may invalidate the token cache; it is registered from here so the
// dependency stays one-way (this module never imports anything from the data
// layer, and the healer never reaches back into this one at import time).
import { registerCaches } from "./selfheal.mjs";

export const CLIENT_ID = "5eb393ee95fab7468a79d189";
export const CLIENT_VERSION = "5.2.1";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Hosts that publish a usable guest token for their own client. */
export const TOKEN_SOURCES = [
  "https://vidcloud.eu.org/generate_token.php",
  "https://proxy.streamvideo.co.in/generate_token.php",
  "https://vidcloud.eu.org/api/generate_token.php",
  "https://proxy.streamvideo.co.in/api/generate_token.php",
  "https://api.studyspark.study/generate_token.php",
  "https://api.studyspark.study/api/generate_token.php",
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

/**
 * The minted token, shared across Worker isolates through the edge cache.
 *
 * A mint is per-isolate today, and vidcloud's bot check challenges some
 * egress IPs while waving others through — so one isolate mints happily
 * while its neighbour burns the whole request on a challenge page. The
 * token is the relay's own public guest token (they publish the mint),
 * so sharing it for a few minutes between our isolates is safe: it turns
 * a per-isolate lottery into "any isolate that can mint, mints for all".
 * Node/test runtimes have no Cache API; every access is guarded.
 */
const SHARED_TOKEN_URL = "https://ars-cache.internal/v1/minted-token";
/** The same token kept for an hour as a last resort (see resolveToken). */
const SHARED_TOKEN_STALE_URL = "https://ars-cache.internal/v1/minted-token-stale";

async function sharedTokenRead() {
  try {
    if (typeof caches === "undefined") return null;
    const hit = await caches.default.match(SHARED_TOKEN_URL);
    if (!hit) return null;
    const j = await hit.json();
    if (!j || !usable(j.token) || Number(j.expires) <= Date.now()) return null;
    return { token: j.token, source: `${j.source} (edge-shared)`, expires: Number(j.expires) };
  } catch {
    return null;
  }
}

function sharedTokenWrite(token, source, expires) {
  try {
    if (typeof caches === "undefined") return;
    const ttl = Math.max(30, Math.min(300, Math.floor((expires - Date.now()) / 1000)));
    const res = new Response(JSON.stringify({ token, source, expires }), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
    });
    caches.default.put(SHARED_TOKEN_URL, res).catch(() => {});
    // Last-resort copy: relay blob tokens carry no readable expiry, and
    // signers routinely accept them long past our assumed ten minutes.
    // When every mint is bot-challenged (the outage that takes the whole
    // site down), yesterday's token is a far better answer than the
    // built-in anonymous fallback every signer refuses.
    const stale = new Response(JSON.stringify({ token, source, expires }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    });
    caches.default.put(SHARED_TOKEN_STALE_URL, stale).catch(() => {});
  } catch {
    /* sharing is an optimisation, never a dependency */
  }
}

async function sharedStaleTokenRead() {
  try {
    if (typeof caches === "undefined") return null;
    const hit = await caches.default.match(SHARED_TOKEN_STALE_URL);
    if (!hit) return null;
    const j = await hit.json();
    if (!j || !usable(j.token)) return null;
    return { token: j.token, source: `${j.source} (edge-stale)` };
  } catch {
    return null;
  }
}

/**
 * Negative cache for a failed mint. The relays' mint endpoints sit behind
 * bot checks that challenge datacentre egress in bursts; an instance that
 * catches one of those windows and keeps re-minting on every request both
 * extends the challenge and burns its subrequest budget proving it. 45 s
 * of quiet, then try again.
 */
let mintFailedUntil = 0;

/**
 * Throw the cached token away.
 *
 * Registered with the self-healer, which calls it when the relays report a run of
 * signature failures: a stale guest token is the most common cause, and the cure
 * is simply to stop trusting the one in hand. The next request re-mints.
 */
export function resetToken() {
  cache = { token: "", source: "", expires: 0 };
  mintFailedUntil = 0;
}

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

  // Cold isolate: another isolate may already hold a good mint.
  if (!fresh) {
    const shared = await sharedTokenRead();
    if (shared) {
      cache = { token: shared.token, source: shared.source, expires: shared.expires };
      return { token: shared.token, source: shared.source, cached: true };
    }
  }

  // In a known-bad window, do not spend fetches re-proving it.
  if (!fresh && mintFailedUntil > Date.now()) {
    if (cache.token) return { token: cache.token, source: `${cache.source} (stale)`, cached: true };
    return { token: FALLBACK_TOKEN, source: "built-in fallback", cached: true };
  }

  // Race every mint source at once, twice. The relays' mint endpoints
  // are intermittently unreachable from a given egress, and walking them
  // serially at six seconds each made a mint outage cost half a minute
  // before the fallback even spoke. In parallel the fastest healthy mint
  // wins in one round trip; the losers' answers are simply discarded.
  const mintOnce = async (source, signal) => {
    const res = await fetch(source, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-IN,en;q=0.9",
        "User-Agent": BROWSER_UA,
        // The mint sits behind the relay's own bot check, which
        // challenges requests that do not look like they came from
        // the relay's web app — a bare API call from a datacentre
        // egress gets a challenge page, not a token.
        referer: "https://vidcloud.eu.org/",
        origin: "https://vidcloud.eu.org",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`mint ${res.status}`);
    const token = parseTokenBody(await res.text());
    if (!usable(token)) throw new Error("mint unusable");
    return { token, source };
  };
  for (let round = 0; round < 2; round += 1) {
    // Abort the losers the moment one mint lands: Promise.any alone
    // leaves all six fetches running, and a Worker invocation that
    // spends a dozen subrequests on a token has none left to sign with.
    const controllers = TOKEN_SOURCES.map(() => new AbortController());
    try {
      const won = await Promise.any(TOKEN_SOURCES.map((src, i) => mintOnce(src, controllers[i].signal)));
      controllers.forEach((c) => c.abort());
      cache = { token: won.token, source: won.source, expires: freshUntil(won.token) };
      sharedTokenWrite(won.token, won.source, cache.expires);
      return { token: won.token, source: won.source, cached: false };
    } catch {
      controllers.forEach((c) => c.abort());
      /* every source refused this round; one more, then fall back */
    }
  }

  mintFailedUntil = Date.now() + 45 * 1000;
  // A stale cached token still beats nothing at all.
  if (cache.token) return { token: cache.token, source: `${cache.source} (stale)`, cached: true };
  // Another isolate's last good mint, kept for an hour: during a mint
  // outage this is the difference between lectures playing and not.
  const stale = await sharedStaleTokenRead();
  if (stale) {
    cache = { token: stale.token, source: stale.source, expires: Date.now() + 5 * 60 * 1000 };
    return { token: stale.token, source: stale.source, cached: true };
  }
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
    ...(token
      ? {
          authorization: `Bearer ${token}`,
          token,
          // Partner relays that publish an *encrypted* guest token (vidcloud's
          // generate_token.php returns a 620-char blob, not a JWT) cannot use
          // it as a bearer: their backend recognises the blob under its own
          // header name and decrypts it before calling PW. Send it that way
          // too — extra headers are ignored by hosts that do not know them.
          "x-auth-token": token,
        }
      : {}),
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
  //
  // When nothing has been minted yet the built-in fallback is what a request
  // would actually send, so report that rather than an empty state: "no token"
  // and "an anonymous token" are different answers to "why is this 401".
  const active = cache;
  const token = active.token || FALLBACK_TOKEN;
  const source = active.source || "built-in fallback";
  const assumedExpiry = active.expires || Date.now() + DEFAULT_TTL;
  const selfExpiry = tokenExpiry(token);
  const remaining = selfExpiry ? selfExpiry - Date.now() : assumedExpiry - Date.now();
  return {
    ...active,
    token,
    source,
    expires: assumedExpiry,
    expiresIn: Math.max(0, Math.round(remaining / 1000)),
    expiresAt: selfExpiry ? new Date(selfExpiry).toISOString() : "",
    expiryFrom: selfExpiry ? "token exp claim" : "assumed 10m",
  };
}

// Bound after every declaration above, so the healer gets the finished function.
registerCaches({ token: resetToken });
