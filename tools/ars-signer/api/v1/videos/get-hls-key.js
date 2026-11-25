/**
 * ars-signer — ArsVibe's own PW signing lane, hosted on Vercel.
 *
 * Why this exists: the site's Cloudflare Worker egress is bot-blocked
 * (403) by every third-party signing relay, and PW's own API refuses
 * the public anonymous token (401) from that egress. Vercel's egress
 * is a different network neighbourhood — the relays' own reference
 * proxies are Vercel apps — so the same asks are answered here.
 *
 * Contract (identical to every other signer the site uses):
 *   GET /api/v1/videos/get-hls-key?videoKey=<folder>&key=<asset>[&authorization=<token>]
 *   → the upstream playlist/segment bytes, streamed, with CORS.
 * A 401/403 from every upstream becomes a 502 JSON refusal, which the
 * site reads as "this lane is down too" and moves on.
 */

const CLIENT_ID = "5eb393ee95fab7468a79d189";
const CLIENT_VERSION = "5.2.1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FALLBACK_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";

const MINTS = [
  "https://vidcloud.eu.org/generate_token.php",
  "https://vidcloud.eu.org/api/generate_token.php",
  "https://api.studyspark.study/generate_token.php",
  "https://proxy.streamvideo.co.in/generate_token.php",
];

let mintCache = { token: "", at: 0 };

function pwHeaders(token) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-IN,en;q=0.9",
    "User-Agent": UA,
    "client-id": CLIENT_ID,
    "client-type": "WEB",
    "client-version": CLIENT_VERSION,
    randomid: Math.random().toString(36).slice(2) + Date.now().toString(36),
    origin: "https://www.pw.live",
    referer: "https://www.pw.live/",
    ...(token
      ? { authorization: `Bearer ${token}`, token, "x-auth-token": token }
      : {}),
  };
}

async function mint(force = false) {
  if (!force && mintCache.token && Date.now() - mintCache.at < 8 * 60 * 1000) {
    return mintCache.token;
  }
  for (const url of MINTS) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      let token = "";
      try {
        const body = JSON.parse(text);
        token = body.token || body.access_token || body.data?.token || "";
      } catch {
        const m = text.match(/[A-Za-z0-9_\-\.]{24,}/);
        token = m ? m[0] : "";
      }
      if (token) {
        mintCache = { token, at: Date.now() };
        return token;
      }
    } catch {
      /* next mint */
    }
  }
  return "";
}

/** One upstream ask. Returns the Response, or null on transport failure. */
async function ask(base, videoKey, key, token, range) {
  const url = `${base}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`;
  try {
    return await fetch(url, {
      headers: { ...pwHeaders(token), ...(range ? { Range: range } : {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, token, range, x-auth-token");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = new URL(req.url, "http://x").searchParams;
  const videoKey = q.get("videoKey") || "";
  const key = q.get("key") || "";
  const callerToken = q.get("authorization") || req.headers.token || "";
  if (!videoKey || !key) {
    return res.status(400).json({ ok: false, error: "videoKey and key are required" });
  }
  const range = req.headers.range || "";

  const lanes = [];
  const minted = await mint();
  if (minted) {
    lanes.push({ base: "https://vidcloud.eu.org/api/v1/videos/get-hls-key", token: minted, name: "vidcloud+mint" });
    lanes.push({ base: "https://api.studyspark.study/api/v1/videos/get-hls-key", token: minted, name: "studyspark+mint" });
  }
  lanes.push({
    base: "https://api.penpencil.co/v1/videos/get-hls-key",
    token: callerToken || minted || FALLBACK_TOKEN,
    name: "penpencil-direct",
  });
  lanes.push({ base: "https://vidcloud.eu.org/api/v1/videos/get-hls-key", token: callerToken || "", name: "vidcloud+caller" });
  lanes.push({ base: "https://proxy.streamvideo.co.in/api/v1/videos/get-hls-key", token: minted || callerToken || "", name: "streamvideo+mint" });

  const refused = [];
  let reminted = false;
  for (const lane of lanes) {
    let upstream = await ask(lane.base, videoKey, key, lane.token, range);
    if (upstream && (upstream.status === 401 || upstream.status === 403) && !reminted && minted) {
      // One fresh mint, one retry on the first lane: the cached blob
      // may simply have expired under us.
      reminted = true;
      const fresh = await mint(true);
      if (fresh && fresh !== minted) {
        upstream = await ask(lane.base, videoKey, key, fresh, range);
      }
    }
    if (!upstream) {
      refused.push(`${lane.name}:unreachable`);
      continue;
    }
    if (upstream.status === 401 || upstream.status === 403) {
      refused.push(`${lane.name}:${upstream.status}`);
      continue;
    }
    // Answered (200, 404, 206…): pass the bytes through untouched.
    res.statusCode = upstream.status;
    const type = upstream.headers.get("content-type");
    if (type) res.setHeader("content-type", type);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("content-length", len);
    const crange = upstream.headers.get("content-range");
    if (crange) res.setHeader("content-range", crange);
    res.setHeader("x-ars-signer-lane", lane.name);
    if (req.method === "HEAD" || !upstream.body) return res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  }

  return res.status(502).json({
    ok: false,
    error: "every signing lane refused",
    refused,
    service: "ars-signer",
  });
};
