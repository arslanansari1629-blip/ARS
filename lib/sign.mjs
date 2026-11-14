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
import { masterPlaylist } from "./api-data.mjs";
import { recordSignerResult, recordRelayFailure, rankSigners } from "./selfheal.mjs";
import { UPSTREAM_BASE } from "./upstream.mjs";

/** Signer relays, tried in order until one answers. */
const SIGNERS = [
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
  "https://proxy.streamvideo.co.in/api/v1/videos/get-hls-key",
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
  // `PW_UPSTREAM_BASE` pointed at a local fixture (development and CI only) is a
  // signer too. Without this the relay ignored the fixture and went to the live
  // mirrors, so a download could not be exercised end to end offline at all.
  ...(UPSTREAM_BASE.startsWith("http") ? [`${UPSTREAM_BASE}/v1/videos/get-hls-key`] : []),
];

/**
 * The ladder, re-ordered by observed health.
 *
 * The order above is a guess about today's mirrors; the healer replaces it with
 * what actually answered a moment ago. A host that is quarantined sorts last
 * rather than being removed, so a full outage still tries everything instead of
 * failing with nothing to try. This is the whole point of the demotion: the
 * first request after a window reset should go to a signer that works, not to
 * the one that has been 403-ing for an hour.
 */
function ladder() {
  return rankSigners(SIGNERS);
}

/** Host part of a signer URL, for the ledger and weighting. */
function hostOf(signer) {
  return String(signer || "").replace(/^https?:\/\//, "").split("/")[0];
}

/**
 * The relay is fetched by the browser (hls.js, dash.js, a `<video>` element),
 * so it has to be readable cross-origin. The old handler set no CORS header at
 * all, which only looked harmless because the player happened to be same-origin.
 */
function corsHeaders(req) {
  const origin = String(req.headers.origin || "*");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    Vary: "Origin",
  };
}

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

/**
 * Fetch one signed file from the first signer that will mint it.
 *
 * Returns the upstream `Response` (unread) or `{ error, status }`. Both `/api/sign`
 * and the media gateway's 403 fallback need exactly this, and the gateway must be
 * able to call it *in process*: a loopback `fetch` of our own origin looks fine
 * locally and fails wherever the function cannot reach itself.
 *
 * @returns {Promise<{ok: boolean, response?: Response, error?: string, status?: number}>}
 */
/**
 * Statuses that mean "ask again in a moment", not "this does not exist".
 *
 * The signers answer 401/403 in bursts when they are busy or when their own
 * guest-token minting is lagging, and the identical request succeeds seconds
 * later. Treating that as final is what made a download die on one segment out
 * of five hundred — and the visitor was told the lecture "could not be
 * downloaded" when a retry would have finished it.
 *
 * 404 is deliberately *not* here: a missing rendition or segment is a real
 * answer, and retrying it only wastes the function's wall clock.
 */
const TRANSIENT = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

/** How many full passes over the ladder one asset gets. */
const SIGN_ATTEMPTS = 3;
/** First backoff gap; it grows per attempt. Overridable for tests. */
const SIGN_GAP_MS = 400;

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function fetchSigned(videoKey, key, { attempts = SIGN_ATTEMPTS, gapMs = SIGN_GAP_MS } = {}) {
  let token = await guestToken().catch(() => "");
  let lastError = "the signing service did not answer";
  let lastStatus = 0;
  let authFailed = false;
  let reminted = false;

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    // Back off between passes: signer throttling clears in seconds, and a second
    // ask is far cheaper than telling someone their lecture is unavailable.
    if (attempt > 0) await sleep(gapMs * attempt * attempt);
    // A 401 means the guest token expired or was rejected — mint a new one before
    // spending another pass on the same stale credential.
    if (authFailed) token = await guestToken(true).catch(() => token);
    authFailed = false;

    for (const signer of ladder()) {
      const host = hostOf(signer);
      let upstream;
      try {
        upstream = await signed(signer, videoKey, key, token);
      } catch (err) {
        lastError = err?.message || "signer unreachable";
        // The healer learns from this: a host that keeps throwing is demoted and
        // the ladder is re-ordered; a run of network failures drops the caches
        // that would otherwise keep handing out the same dead URL.
        recordSignerResult(host, false, { error: lastError });
        recordRelayFailure({ relay: "sign", kind: "unreachable", detail: lastError });
        continue;
      }

      // 401 is an expired token. 403 from every host at once is the same
      // story told differently — the credential, not the asset — and the
      // ladder used to carry that one stale token past every mirror before
      // giving up (a live check watched a working 720p playlist 502 this
      // way while a fresh token served it instantly). Either answer earns
      // exactly one re-mint and one immediate retry; a genuine refusal
      // (a DRM folder) still fails, just one mint later.
      if ((upstream.status === 401 || upstream.status === 403) && !reminted) {
        reminted = true;
        authFailed = true;
        token = await guestToken(true).catch(() => token);
        try {
          upstream = await signed(signer, videoKey, key, token);
        } catch (err) {
          lastError = err?.message || "signer unreachable";
          recordSignerResult(host, false, { error: lastError });
          continue;
        }
      }

      if (upstream.ok) {
        recordSignerResult(host, true);
        return { ok: true, response: upstream };
      }
      lastStatus = upstream.status;
      lastError = `the signing service answered ${upstream.status}`;

      // A host that answered a real 404 is telling us the asset is not there —
      // no other mirror will have it either, and no retry will conjure it.
      if (!TRANSIENT.has(upstream.status)) {
        recordSignerResult(host, false, { status: upstream.status });
        return { ok: false, error: lastError, status: lastStatus };
      }

      // Transient: keep the ladder moving, and only blame this host once the
      // retries are exhausted — otherwise one busy spell quarantines a signer
      // that was working a second ago.
      if (attempt === Math.max(1, attempts) - 1) {
        recordSignerResult(host, false, { status: upstream.status });
        recordRelayFailure({
          relay: "sign",
          kind: "signature",
          detail: `signer ${host} answered ${upstream.status}`,
        });
      }
      if (upstream.status === 429) {
        const retry = Number(upstream.headers.get("retry-after")) || 0;
        if (retry > 0) await sleep(Math.min(retry * 1000, 2000));
      }
    }
  }

  return { ok: false, error: lastError, status: lastStatus };
}

/** True when a failed sign is worth asking about again. */
export function isTransientStatus(status) {
  return TRANSIENT.has(Number(status) || 0);
}

/** One signer call with the current token. */
async function signed(signer, videoKey, key, token) {
  return fetch(`${signer}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}`, {
    headers: pwHeaders(token),
    redirect: "follow",
    // 25 s here meant one hung mirror could stall a playlist or a segment
    // for longer than the player's own fragment timeout. Twelve seconds is
    // generous for a signer that answers in one, and the ladder/retry logic
    // behind this call is what recovers a genuinely dead host.
    signal: AbortSignal.timeout(12000),
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
  const headers = corsHeaders(req);
  // `folder` is accepted as an alias for `videoKey`: the player has the folder,
  // and making it know which of the two the relay wants was a bug magnet.
  const videoKey = url.searchParams.get("videoKey") || url.searchParams.get("folder") || "";
  const key = url.searchParams.get("key") || "";

  if (!videoKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "videoKey is required" }));
  }

  /**
   * The master playlist is *ours*, not the signer's.
   *
   * This is why lectures did not play. Resolution gave the player
   * `key=master.m3u8`, but no signer host stores a master playlist — it keeps
   * one media playlist per rendition — so every ask came back 403 and hls.js
   * reported a dead manifest. The per-rendition playlists, the AES key and the
   * segments were all fine; only the entry point did not exist. We already know
   * which renditions answered (the resolver probed them), so we mint the master
   * here and point every variant at the real rendition playlist.
   */
  if (/^master\.m3u8$/i.test(key)) {
    const list = String(url.searchParams.get("renditions") || "")
      .split(",")
      .map((q) => q.trim())
      .filter((q) => /^\d{3,4}$/.test(q));
    if (!list.length) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.end(
        JSON.stringify({
          success: false,
          error: "renditions is required for the master playlist",
          videoKey,
        })
      );
    }
    const link = (quality) =>
      `${selfBase(req)}/api/sign?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(
        `${quality}/main.m3u8`
      )}`;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "public, max-age=60");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end(
      masterPlaylist(list.map((quality) => ({ quality, main: link(quality) })))
    );
  }

  // The rendition a bare file name belongs to ("enc.key" inside 720/main.m3u8).
  const rendition = /^(\d+)\//.test(key) ? key.split("/")[0] : "";

  // One ladder pass per asset was the flaky path: the signers refuse in
  // bursts (a 720p playlist that probed fine answered 403 seconds later),
  // and a single pass turned that burst into a dead player. `fetchSigned`
  // is the retrying fetch the downloader already uses — token remint on
  // 401, backoff between passes, every host per pass — so the relay uses
  // it too instead of maintaining a weaker copy of the same logic.
  const got = await fetchSigned(videoKey, key, { attempts: 2 }).catch((err) => ({
    ok: false,
    error: err?.message || "signer unreachable",
    status: 0,
  }));

  if (got.ok && got.response) {
    const upstream = got.response;
    if (isPlaylist(upstream, key)) {
      const text = await upstream.text();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      // A rendition playlist's segment list never changes for a given
      // videoKey+key: ten minutes at the edge absorbs the reload storm a
      // popular lecture creates, instead of a signer fetch per student.
      res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      return res.end(
        rewritePlaylist(text, {
          videoKey,
          folder: videoKey,
          rendition,
          base: selfBase(req),
        })
      );
    }
    // A segment's bytes never change for a given videoKey+key, and the URL
    // is identical for every viewer: a day at the edge turns the second
    // student's segment into a CDN hit instead of another signer round
    // trip, which is most of what "buffer-free" means in practice.
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return pipe(res, upstream, "public, max-age=86400, s-maxage=86400, immutable");
  }

  res.statusCode = 502;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  return res.end(
    JSON.stringify({
      success: false,
      error: `Could not sign this video: ${got.error || "the signing service did not answer"}.`,
      videoKey,
      key,
      upstreamStatus: got.status || 0,
    })
  );
}
