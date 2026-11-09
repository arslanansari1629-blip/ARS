/**
 * `GET /api/sign?videoKey=&key=` — the HLS signing relay.
 *
 * PW hands out a *folder* (an object prefix), not a playable URL: the playlist,
 * the AES key and the segments are all minted by a partner signer that answers
 * only for real client traffic. This is the one place those halves meet — the
 * player asks our origin, we sign upstream, and the bytes come back through us.
 * That is what makes a lecture playable without sending the viewer to another
 * site, and what keeps the player free of CORS problems.
 *
 * Two behaviours are load-bearing and were both bugs once:
 *   1. the signer must receive the anonymous guest token, or it answers 401;
 *   2. a playlist must be read as text and rewritten, never streamed raw — a raw
 *      playlist leaves the browser requesting relative variants it cannot reach.
 */

import { guestToken, pwHeaders } from "../lib/pw-auth.mjs";

/** Signer relays, tried in order until one answers. */
const SIGNERS = [
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
  "https://proxy.streamvideo.co.in/api/v1/videos/get-hls-key",
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
];

function selfBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

/**
 * The upstream file a reference points at, as `rendition/file`.
 *
 * Three shapes arrive here and all three must land on a key the signer accepts:
 *   `enc.key`                                   → rendition-relative
 *   `720/000.ts`                                → already a key
 *   `https://sec1.pw.live/hls/<folder>/720/001.ts?Signature=…` → reduce to key
 * A relay-rewritten `URI` hides the real key in its own query string, so that is
 * read first — otherwise the relay's endpoint leaks into the key path.
 */
function keyFor(ref, folder, rendition) {
  let raw = String(ref || "").trim();
  if (!raw) return "";

  if (raw.includes("?")) {
    const query = raw.slice(raw.indexOf("?") + 1);
    const fromQuery = new URLSearchParams(query).get("key");
    if (fromQuery) return fromQuery;
    raw = raw.slice(0, raw.indexOf("?"));
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const path = new URL(raw).pathname;
      const afterFolder = folder && path.includes(`/${folder}/`) ? path.split(`/${folder}/`)[1] : "";
      raw = afterFolder || path;
    } catch {
      /* fall through with the raw value */
    }
  }

  raw = raw.replace(/^\/+/, "");
  // A bare file name belongs to the rendition that was requested.
  if (!raw.includes("/") && rendition) return `${rendition}/${raw}`;
  return raw;
}

/** Rewrite every child reference so the browser asks this relay again. */
function rewritePlaylist(text, { videoKey, folder, rendition, base }) {
  const link = (key) => `${base}/api/sign?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`;

  return text
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw) return line;
      if (raw.startsWith("#")) {
        // URI="..." attributes (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, …)
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${link(keyFor(uri, folder, rendition))}"`);
      }
      return link(keyFor(raw, folder, rendition));
    })
    .join("\n");
}

/** One signer call with the current token. */
async function signed(signer, videoKey, key, token) {
  return fetch(`${signer}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`, {
    headers: pwHeaders(token),
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
}

function isPlaylist(upstream, key) {
  const type = upstream.headers.get("content-type") || "";
  return /mpegurl|dash\+xml/i.test(type) || /\.(m3u8|mpd)$/i.test(key) || /main\.(m3u8|mpd)/i.test(key);
}

/** Copy upstream bytes to the response without ever holding a segment in memory. */
async function pipe(res, upstream, cache) {
  res.statusCode = 200;
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Cache-Control", cache);
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);

  if (!upstream.body) {
    res.write(Buffer.from(await upstream.arrayBuffer()));
    return res.end();
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  return res.end();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // `folder` is accepted as an alias for `videoKey`: the player has the folder,
  // and making it know which of the two the relay wants was a bug magnet.
  const videoKey = url.searchParams.get("videoKey") || url.searchParams.get("folder") || "";
  const key = url.searchParams.get("key") || "";

  if (!videoKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "videoKey is required" }));
  }

  // The rendition a bare file name belongs to ("enc.key" inside 720/main.m3u8).
  const rendition = /^(\d+)\//.test(key) ? key.split("/")[0] : "";

  let token = await guestToken().catch(() => "");
  let lastError = "the signing service did not answer";
  let lastStatus = 0;

  for (const signer of SIGNERS) {
    let upstream;
    try {
      upstream = await signed(signer, videoKey, key, token);
    } catch (err) {
      lastError = err?.message || "signer unreachable";
      continue;
    }

    // An expired guest token is the single most common failure, and it is
    // recoverable: mint a fresh one and try the same signer again before moving
    // on, because the next host usually has the same objection.
    if (upstream.status === 401) {
      token = await guestToken(true).catch(() => token);
      try {
        upstream = await signed(signer, videoKey, key, token);
      } catch (err) {
        lastError = err?.message || "signer unreachable";
        continue;
      }
    }

    if (upstream.ok) {
      if (isPlaylist(upstream, key)) {
        const text = await upstream.text();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.end(
          rewritePlaylist(text, {
            videoKey,
            folder: videoKey,
            rendition,
            base: selfBase(req),
          })
        );
      }
      return pipe(res, upstream, "public, max-age=3600");
    }

    lastStatus = upstream.status;
    lastError = `the signing service answered ${upstream.status}`;
    // Only a spent credential or a load shed is worth another host; anything
    // else is the same answer everywhere.
    if (![401, 403, 404, 429, 500, 502, 503].includes(upstream.status)) break;
  }

  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.end(
    JSON.stringify({
      success: false,
      error: `Could not sign this video: ${lastError}.`,
      videoKey,
      key,
      upstreamStatus: lastStatus,
    })
  );
}
