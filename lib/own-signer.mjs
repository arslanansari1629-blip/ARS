/**
 * Our own signer, on Cloudflare — the lead lane of both signer ladders.
 *
 * Why this exists: playback depended on other people's signing lanes.
 * The partner relays (vidcloud, studyspark, streamvideo) are strangers'
 * Workers with strangers' quotas; our Vercel lane died behind a 402
 * fair-use wall and took every lecture with it. The user asked for the
 * signer to live on Cloudflare, on infrastructure we control — so here
 * it is. This module runs *inside* the site's own Cloudflare Worker
 * (and inside the Node runtime in dev/tests): no self-fetch, no extra
 * deployment, no third-party quota between us and PW's official API.
 *
 * What it does, and nothing more:
 *   1. presents a credential (the caller's token first, then the guest
 *      mint, then a fresh mint on refusal) to PW's *official* API —
 *      `api.penpencil.xyz` / `api.penpencil.co`, the one signer that
 *      cannot be quota-killed by a third party;
 *   2. returns the upstream Response untouched, so playlists, AES keys
 *      and segments stream through exactly as the relays' answers did.
 *
 * The lane's ladder name is a sentinel `.internal` URL: it is never
 * fetched (a Worker may not fetch its own origin, and this host does
 * not exist) — `lib/sign.mjs` and `lib/api-data.mjs` recognise it and
 * call `askOwnSigner` in process. Health is recorded against the
 * sentinel like any other host, so the Brain sees "own-cloudflare" in
 * its ladder reports and the healer can rank it on evidence.
 *
 * Refusals are a family (the 402 lesson): 401/402/403/429 from one
 * official host moves to the next, and earns exactly one fresh mint —
 * never a second ask with a credential already refused.
 */

import { pwHeaders, guestToken } from "./pw-auth.mjs";

/** Ladder name of the own-Cloudflare lane (sentinel — never fetched). */
export const OWN_SIGNER_HOST =
  "https://own-signer.arsvibe.internal/api/v1/videos/get-hls-key";

/** True when a ladder entry is the own-Cloudflare lane. */
export function isOwnSigner(signer) {
  return String(signer || "").includes("own-signer.arsvibe.internal");
}

/** PW's official signing hosts, best first. No middlemen. */
export const OWN_UPSTREAMS = [
  "https://api.penpencil.xyz/v1/videos/get-hls-key",
  "https://api.penpencil.co/v1/videos/get-hls-key",
];

const REFUSALS = new Set([401, 402, 403, 429]);

/**
 * Ask our own Cloudflare signer for one asset.
 *
 * @param {string} videoKey  PW video folder.
 * @param {string} key       Asset path (`720/main.m3u8`, `enc.key`, …).
 * @param {string} [token]   Credential the caller already holds; the
 *   guest mint is tried next, and one fresh mint after any refusal.
 * @param {{range?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<Response>} the upstream answer (ok or last refusal).
 */
export async function askOwnSigner(videoKey, key, token = "", { range = "", timeoutMs = 8000 } = {}) {
  // One credential's walk over the official hosts. A refusal is
  // remembered and the walk moves on; any other answer (200, 206,
  // 404, 5xx) is the host speaking for itself and is returned as-is.
  const askWith = async (cred) => {
    let last = null;
    for (const base of OWN_UPSTREAMS) {
      let res;
      try {
        const url =
          `${base}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}` +
          (cred ? `&authorization=${encodeURIComponent(cred)}` : "");
        res = await fetch(url, {
          headers: { ...pwHeaders(cred), ...(range ? { Range: range } : {}) },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        continue; // transport failure: next official host
      }
      if (res.ok || res.status === 206 || !REFUSALS.has(res.status)) return res;
      last = res;
    }
    return last;
  };

  // The caller's credential first — anonymously if that is what we
  // hold. The mint is NOT awaited up front: PW's API answers plenty
  // of asks anonymously, and a signer that answers at once must never
  // wait 600 ms for a token it did not need (that wait was once the
  // entire cold start of a lecture).
  let prev = String(token || "").trim();
  let res = await askWith(prev);
  if (!res || res.ok || res.status === 206 || !REFUSALS.has(res.status)) {
    return res || unreachable();
  }
  // Refused: the credential is the problem, so mint — cached mint
  // first, then exactly one fresh mint. An expired guest token draws
  // precisely this answer from every host at once.
  for (const fresh of [false, true]) {
    const minted = await guestToken(fresh).catch(() => "");
    if (!minted || minted === prev) continue;
    prev = minted;
    res = await askWith(minted);
    if (!res || res.ok || res.status === 206 || !REFUSALS.has(res.status)) {
      return res || unreachable();
    }
  }
  return res || unreachable();
}

function unreachable() {
  return new Response(
    JSON.stringify({ success: false, error: "own Cloudflare signer: PW's official API unreachable" }),
    { status: 502, headers: { "Content-Type": "application/json", "X-Ars-Signer": "own-cloudflare" } }
  );
}
