import { cors } from "../lib/http.mjs";

/**
 * GET /api/sign?host=<signer>&videoKey=<folder>&key=720/main.m3u8
 *
 * Relays the upstream PW "get-hls-key" signing service. It returns a freshly
 * signed CloudFront playlist / segment / AES key for a video folder, which lets
 * the player stream lectures whose published URL lost its signature.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FALLBACK_SIGNERS = [
  "https://www.learnxpw.site/api/v1/videos/get-hls-key",
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
];

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const videoKey = url.searchParams.get("videoKey") || "";
  const key = url.searchParams.get("key") || "720/main.m3u8";
  const hostParam = url.searchParams.get("host") || "";

  if (!videoKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "videoKey is required" }));
  }

  const signers = hostParam ? [hostParam, ...FALLBACK_SIGNERS] : FALLBACK_SIGNERS;

  for (const signer of signers) {
    try {
      const target = `${signer}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(
        key
      )}`;
      const upstream = await fetch(target, {
        headers: { Accept: "*/*", "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });

      if (!upstream.ok) continue;

      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (/json|html|text\/plain/i.test(contentType)) {
        const text = await upstream.text();
        if (text.includes("#EXTM3U") || text.includes("<MPD>")) {
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            text.includes("#EXTM3U") ? "application/vnd.apple.mpegurl" : "application/dash+xml"
          );
          res.setHeader("Cache-Control", "no-store");
          return res.end(rewritePlaylist(text, req, videoKey));
        }
        // signer answered with JSON (error or a signed redirect payload)
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(text);
      }

      res.statusCode = upstream.status;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=300");
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch {
      /* try the next signer */
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

function rewritePlaylist(text, req, videoKey) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const base = `${proto}://${host}`;
  return text
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw) return line;
      if (raw.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          const key = uri.split("/").slice(-2).join("/");
          return `URI="${base}/api/sign?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}"`;
        });
      }
      const clean = raw.split("?")[0];
      const rel = clean.replace(/^https?:\/\/[^/]+\//, "");
      const parts = rel.split("/").filter(Boolean);
      const key = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : raw;
      return `${base}/api/sign?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`;
    })
    .join("\n");
}
