import { cors } from "../lib/http.mjs";
import { signerHeaders, probeRenditions, masterPlaylist } from "../lib/api-data.mjs";
import { resolveToken } from "../lib/pw-auth.mjs";

/**
 * GET /api/sign?host=<signer>&videoKey=<folder>&key=720/main.m3u8
 * GET /api/sign?videoKey=<folder>&key=720/000.ts      (segment / AES key)
 *
 * Relays the upstream PW "get-hls-key" signing service. It returns a freshly
 * signed CloudFront playlist / segment / AES key for a video folder, which lets
 * the player stream lectures whose published URL lost its signature.
 *
 * The signer relays are PW partner APIs: they require an anonymous guest token
 * (Authorization: Bearer … plus a `token` header). Without it they answer 401,
 * which is why every signer below is tried with the same credential set.
 *
 * What makes playback reliable here:
 *   • a *fresh* guest token per attempt — a cached token can expire mid-lecture
 *     and would otherwise fail every segment for the rest of the session;
 *   • several signer hosts per key, because a single relay is regularly down;
 *   • retries for key/segment fetches, which are the two requests a player makes
 *     hundreds of times and cannot recover from on its own;
 *   • binary responses streamed through untouched (a `.ts` is not text, and
 *     deciding that from `content-type` is how playlists get corrupted).
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** This deployment's own origin, as seen by the client that called us. */
function selfBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

const FALLBACK_SIGNERS = [
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
  "https://www.learnxpw.site/api/v1/videos/get-hls-key",
];

/** Quality order used when the caller does not name a rendition. */
const QUALITIES = ["720", "480", "360", "240"];

/** Requests the player repeats constantly — worth retrying before giving up. */
const RETRYABLE = /(enc\.key|\/\d+\.(ts|m4s)|init\.mp4|\.mp4$)/i;

async function fetchSigned(signer, videoKey, key, token) {
  const target = `${signer}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`;
  return fetch(target, {
    headers: signerHeaders(token),
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
}

/** Send upstream bytes straight through — never buffer a video segment. */
async function pipe(res, upstream, cache) {
  res.statusCode = 200;
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Cache-Control", cache);
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);

  if (!upstream.body) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.end(buffer);
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
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

  // `skip` pins the order away from the host that just failed: the player sends
  // a new attempt number on every retry, so a dead relay is rotated out instead
  // of being retried first forever.
  const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));
  const rotated = [...FALLBACK_SIGNERS.slice(skip % FALLBACK_SIGNERS.length), ...FALLBACK_SIGNERS.slice(0, skip % FALLBACK_SIGNERS.length)];
  const signers = hostParam
    ? [hostParam, ...rotated.filter((s) => s !== hostParam)]
    : rotated;

  // `key=master.m3u8` is the one thing the signer does not store, and it is the
  // one thing a player needs: the quality picker only has levels to choose from
  // if it receives a master playlist. Build it from the renditions that answer.
  if (/^master\.m3u8$/i.test(key)) {
    const { renditions } = await probeRenditions({ folder: videoKey });
    if (!renditions.length) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          success: false,
          error:
            "No signing service accepted this lecture right now. PW publishes some lectures without a stream; try another lecture or use the source player.",
          reason: "no rendition answered for this folder",
        })
      );
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    // `main` paths come back as `/api/sign?...`; make them absolute for players
    // that resolve playlist URIs against the manifest's origin.
    const body = masterPlaylist(
      renditions.map((r) => ({ quality: r.quality, main: `${selfBase(req)}${r.main}` }))
    );
    return res.end(body);
  }

  // Resolve the rendition master playlist when the caller does not pin one.
  const keys = key ? [key] : QUALITIES.map((q) => `${q}/main.m3u8`);

  // A segment/key request is binary: keep the first signer that answers and
  // never try to parse it as a playlist.
  const binary = !/\.(m3u8|mpd)$/i.test(key);
  // The signer relay only stores HLS paths. A `.mpd` request is a legitimate
  // thing for a client to ask for, so answer with the reason instead of letting
  // it look like the lecture is broken.
  const wantsDash = /\.mpd$/i.test(key) || /dash/i.test(key);
  const rounds = binary && RETRYABLE.test(key) ? 2 : 1;
  let lastReason = "no signer answered";
  let tried = 0;

  for (let round = 0; round < rounds; round++) {
    // Ask for a token per round: a stale cache is the most common cause of a
    // lecture that stops playing halfway through.
    const auth = await resolveToken(round > 0);
    const token = auth.token;
    res.setHeader("X-PW-Auth", auth.source);

    for (const candidate of keys) {
      for (const signer of signers) {
        tried += 1;
        let upstream;
        try {
          upstream = await fetchSigned(signer, videoKey, candidate, token);
        } catch (err) {
          lastReason = err?.name === "TimeoutError" ? "signer timed out" : "signer unreachable";
          continue;
        }
        if (!upstream.ok) {
          lastReason = `signer answered ${upstream.status}`;
          continue;
        }

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
          lastReason = "signer returned a non-playlist body";
          continue;
        }

        // Binary payload: AES key, encryption init segment or a media segment.
        return pipe(res, upstream, binary ? "public, max-age=3600" : "public, max-age=300");
      }
    }
  }

  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      success: false,
      error: wantsDash
        ? "This signer only stores HLS renditions, so a DASH (.mpd) path cannot be signed here. Request 720/main.m3u8 instead — lecture playback uses HLS."
        : "No signing service accepted this lecture right now. PW only publishes some lectures; try another lecture or use the source player.",
      reason: lastReason,
      tried,
      hlsHint: wantsDash ? "/api/sign?videoKey=<folder>&key=720/main.m3u8" : undefined,
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
