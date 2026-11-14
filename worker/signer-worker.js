/**
 * ArsVibe PW signer — our own `get-hls-key` relay on Cloudflare Workers.
 *
 * Why this exists: playback used to depend on third-party signer relays
 * (vidcloud, streamvideo, studyspark). They are other people's Workers with
 * other people's quotas — vidcloud died with Cloudflare Error 1027 (its
 * owner's plan limit) and every lecture on the site stopped playing. This
 * Worker is the same protocol on infrastructure we control:
 *
 *   GET /api/v1/videos/get-hls-key?videoKey=<folder>&key=<path>
 *   GET /?videoKey=<folder>&key=<path>
 *
 * It holds no PW password. It mints the same public guest token the relays
 * publish, presents it to PW's official API (which speaks this exact
 * protocol), and streams the answer back. An operator can pin a real PW
 * bearer as the `PW_TOKEN` secret to skip the public mint entirely.
 *
 * Segments that PW's playlists already carry as signed absolute URLs never
 * reach this Worker — the site proxies those straight from PW's CDN — so
 * a lecture view costs a handful of Worker requests, not ~1,257.
 */

const CLIENT_ID = "5eb393ee95fab7468a79d189";

/** Public anonymous token shipped by open-source PW clients (last resort). */
const FALLBACK_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";

/** Where a guest token can be minted. First healthy answer wins. */
const TOKEN_SOURCES = [
  "https://vidcloud.eu.org/generate_token.php",
  "https://proxy.streamvideo.co.in/generate_token.php",
  "https://vidcloud.eu.org/api/generate_token.php",
];

/**
 * Signing upstreams, best first. PW's own API leads: it cannot be
 * quota-killed by a third party. The partner relays stay as a tail —
 * if the official hosts ever refuse our credentials, a living relay
 * still answers, exactly as it did before this Worker existed.
 */
const UPSTREAMS = [
  "https://api.penpencil.xyz/v1/videos/get-hls-key",
  "https://api.penpencil.co/v1/videos/get-hls-key",
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
  "https://proxy.streamvideo.co.in/api/v1/videos/get-hls-key",
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Isolate-level token cache; PW guest tokens live far longer than this. */
let tokenCache = { token: "", source: "", expires: 0 };

function randomId() {
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

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
    /* plain-text token */
  }
  return String(value).replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
}

function usable(token) {
  return Boolean(token) && token.length > 15 && !token.includes("<");
}

async function mintToken(env, fresh = false) {
  const pinned = (env && env.PW_TOKEN) || "";
  if (usable(pinned)) return { token: pinned, source: "secret:PW_TOKEN" };

  if (!fresh && tokenCache.token && tokenCache.expires > Date.now()) {
    return { token: tokenCache.token, source: `${tokenCache.source} (cached)` };
  }
  for (const source of TOKEN_SOURCES) {
    try {
      const res = await fetch(source, {
        headers: { Accept: "application/json, text/plain, */*", "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const token = parseTokenBody(await res.text());
      if (!usable(token)) continue;
      tokenCache = { token, source, expires: Date.now() + 8 * 60 * 1000 };
      return { token, source };
    } catch {
      /* next source */
    }
  }
  if (tokenCache.token) return { token: tokenCache.token, source: `${tokenCache.source} (stale)` };
  return { token: FALLBACK_TOKEN, source: "built-in fallback" };
}

function pwHeaders(token) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-IN,en;q=0.9",
    "User-Agent": BROWSER_UA,
    "client-id": CLIENT_ID,
    "client-type": "WEB",
    "client-version": "5.2.1",
    randomid: randomId(),
    origin: "https://www.pw.live",
    referer: "https://www.pw.live/",
    ...(token ? { authorization: `Bearer ${token}`, token } : {}),
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/** One upstream attempt. The token goes as header *and* query: the relays
 *  read the header, PW's official API reads `authorization` — send both. */
async function askUpstream(base, videoKey, key, token) {
  const url =
    `${base}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}` +
    (token ? `&authorization=${encodeURIComponent(token)}` : "");
  return fetch(url, {
    headers: pwHeaders(token),
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
}

async function sign(videoKey, key, env) {
  let { token } = await mintToken(env);
  let reminted = false;
  let lastStatus = 0;
  let lastError = "no upstream answered";

  for (const base of UPSTREAMS) {
    for (let credentialTry = 0; credentialTry < 2; credentialTry += 1) {
      let upstream;
      try {
        upstream = await askUpstream(base, videoKey, key, token);
      } catch (err) {
        lastError = err?.message || "upstream unreachable";
        break; // next upstream
      }
      if (upstream.ok) return upstream;
      lastStatus = upstream.status;
      lastError = `upstream answered ${upstream.status}`;
      // 401/403 once per upstream earns a fresh mint; a second refusal is
      // the upstream's final word and the ladder moves on.
      if ((upstream.status === 401 || upstream.status === 403) && !reminted) {
        reminted = true;
        const fresh = await mintToken(env, true);
        if (fresh.token && fresh.token !== token) {
          token = fresh.token;
          continue;
        }
      }
      break;
    }
  }
  return { error: lastError, status: lastStatus };
}

async function handleSign(url, env) {
  const videoKey = url.searchParams.get("videoKey") || url.searchParams.get("folder") || "";
  const key = url.searchParams.get("key") || "";
  if (!videoKey || !key) {
    return json({ success: false, error: "videoKey and key are required" }, 400);
  }

  const got = await sign(videoKey, key, env);
  if (got instanceof Response) {
    const headers = new Headers(got.headers);
    headers.delete("set-cookie");
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    // Playlists/keys are immutable per videoKey+key; segments even more so.
    // Let Cloudflare's cache take repeat hits off the upstream entirely.
    if (/\.m3u8$/i.test(key)) headers.set("Cache-Control", "public, max-age=60, s-maxage=600");
    else headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
    headers.set("X-Ars-Signer", "own-worker");
    return new Response(got.body, { status: got.status, headers });
  }
  return json(
    { success: false, error: `Could not sign this video: ${got.error}.`, videoKey, key, upstreamStatus: got.status || 0 },
    502
  );
}

async function handle(request, env = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    const { source } = await mintToken(env);
    return json({
      ok: true,
      signer: "arsvibe-own-worker",
      tokenSource: source,
      upstreams: UPSTREAMS,
      checkedAt: new Date().toISOString(),
    });
  }

  // Root and the relay-shaped path both sign: the site probes hosts by the
  // `/api/v1/videos/get-hls-key` shape, so answer to that name too.
  if (url.pathname === "/" || url.pathname.endsWith("/get-hls-key")) {
    return handleSign(url, env);
  }
  return json({ success: false, error: "not found" }, 404);
}

export default { fetch: (request, env) => handle(request, env) };
export { handle };
