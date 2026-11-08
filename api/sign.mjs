import { cors } from "../lib/http.mjs";
import { guestToken } from "../lib/api-data.mjs";

/**
 * GET /api/sign?host=<signer>&videoKey=<folder>&key=720/main.m3u8
 *
 * Relays the upstream PW "get-hls-key" signing service. It returns a freshly
 * signed CloudFront playlist / segment / AES key for a video folder, which lets
 * the player stream lectures whose published URL lost its signature.
 *
 * The signer relays are PW partner APIs: they require an anonymous guest token
 * (Authorization: Bearer … plus a `token` header). Without it they answer 401,
 * which is why every signer below is tried with the same credential set.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FALLBACK_SIGNERS = [
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
  "https://www.learnxpw.site/api/v1/videos/get-hls-key",
];

/** Quality order used when the caller does not name a rendition. */
const QUALITIES = ["720", "480", "360", "240"];

function signerHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    token,
    "client-type": "WEB",
    "client-version": "1.0.0",
    Accept: "*/*",
    "User-Agent": UA,
  };
}

async function fetchSigned(signer, videoKey, key, token) {
  const target = `${signer}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`;
  return fetch(target, {
    headers: signerHeaders(token),
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const videoKey = url.searchParams.get("videoKey") || "";
  const key = url.searchParams.get("key") || "";
  const hostParam = url.searchParams.get("host") || "";

  if (!videoKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "videoKey is required" }));
  }

  const signers = hostParam ? [hostParam, ...FALLBACK_SIGNERS.filter((s) => s !== hostParam)] : FALLBACK_SIGNERS;
  const token = await guestToken();

  // Resolve the rendition master playlist when the caller does not pin one.
  const keys = key ? [key] : QUALITIES.map((q) => `${q}/main.m3u8`);

  for (const candidate of keys) {
    for (const signer of signers) {
      let upstream;
      try {
        upstream = await fetchSigned(signer, videoKey, candidate, token);
      } catch {
        continue;
      }
      if (!upstream.ok) continue;

      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      const looksLikePlaylist = /\.(m3u8|mpd)$/i.test(candidate);
      const declaredText = /json|html|text\/|xml|mpegurl|dash/i.test(contentType);

      // A playlist can arrive with almost any content-type, so read it as text
      // whenever either the requested path or the response type says so.
      if (looksLikePlaylist || declaredText) {
        const text = await upstream.text();
        if (text.includes("#EXTM3U") || text.includes("<MPD")) {
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            text.includes("#EXTM3U") ? "application/vnd.apple.mpegurl" : "application/dash+xml"
          );
          res.setHeader("Cache-Control", "no-store");
          return res.end(rewritePlaylist(text, req, videoKey, candidate));
        }
        // JSON / HTML / error body — try the remaining signers.
        continue;
      }

      // Binary payload (AES key or a media segment) — pass it through untouched.
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=300");
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }
  }

  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      success: false,
      error:
        "No signing service accepted this lecture right now. PW only publishes some lectures; try another lecture or use the source player.",
    })
  );
}

/**
 * Rewrite every child reference of a signed playlist back through this route so
 * the browser never has to talk to CloudFront directly.
 */
function rewritePlaylist(text, req, videoKey, requestedKey) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const base = `${proto}://${host}`;
  const rendition = (String(requestedKey).match(/^(\d+)\//) || [])[1] || "";

  const relay = (childKey) =>
    `${base}/api/sign?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(childKey)}`;

  /**
   * Reduce a playlist reference to the `[<rendition>/]<file>` form the signer
   * wants.
   *
   * Some relays already rewrite the AES key URI into their own endpoint
   * (`…/get-hls-key?videoKey=…&key=720/enc.key`). For those the real key path
   * lives in the `key` query parameter — taking the URL's last two path
   * segments would yield a useless `videos/get-hls-key`.
   */
  const toKey = (ref) => {
    const raw = String(ref);
    const qIndex = raw.indexOf("?");
    if (qIndex !== -1) {
      const params = new URLSearchParams(raw.slice(qIndex + 1));
      const inner = params.get("key");
      if (inner) return inner;
    }
    const clean = qIndex === -1 ? raw : raw.slice(0, qIndex);
    const rel = clean.replace(/^https?:\/\/[^/]+\//, "");
    const parts = rel.split("/").filter(Boolean);
    if (!parts.length) return raw;
    if (parts.length === 1) return rendition ? `${rendition}/${parts[0]}` : parts[0];
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  };

  return text
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw) return line;
      if (raw.startsWith("#")) {
        // EXT-X-KEY / EXT-X-MAP carry their target in URI="…"
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${relay(toKey(uri))}"`);
      }
      return relay(toKey(raw));
    })
    .join("\n");
}
