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

import { pwHeaders, guestToken, cachedToken, onMintReset } from "./pw-auth.mjs";

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
  // The vidcloud lane, third: it is the signer whose own site plays
  // these lectures daily, and its method — a token minted from its
  // own generate_token endpoint, presented to its get-hls-key — is
  // exactly the credential walk below. It sits inside our signer
  // (asked from our Cloudflare Worker, health-recorded, quota-free
  // on our side) rather than as a separate ladder dependency.
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
];

const REFUSALS = new Set([401, 402, 403, 429]);

/**
 * Refusals remembered per upstream + credential (45 s).
 *
 * The probe asks for five renditions at once, and a host that just
 * refused this credential will refuse the other four — re-asking is
 * how a signer outage used to become a subrequest-budget outage.
 * The ladder above us memoizes the same way; this keeps the own
 * signer's internal walk (official hosts, then vidcloud) equally
 * frugal, which is the whole vidcloud method: mint once, sign
 * everything, waste nothing.
 */
const refusalMemo = new Map();
const REFUSAL_TTL = 45 * 1000;

/** Drop every remembered refusal (healer resets, tests). */
export function forgetOwnSignerRefusals() {
  refusalMemo.clear();
}

// A dropped token invalidates the refusals it earned, wherever the
// drop comes from (healer repair, test reset, credential rotation).
onMintReset(forgetOwnSignerRefusals);

/**
 * Ask our own Cloudflare signer for one asset.
 *
 * @param {string} videoKey  PW video folder.
 * @param {string} key       Asset path (`720/main.m3u8`, `enc.key`, …).
 * @param {string} [token]   Credential the caller already holds; the
 *   guest mint is tried next, and one fresh mint after any refusal.
 * @param {{range?: string, timeoutMs?: number, deadlineMs?: number}} [opts]
 *   `timeoutMs` caps one upstream fetch; `deadlineMs` caps the whole
 *   ask — every credential pass and upstream together. The deadline
 *   is load-bearing: three upstreams x three credentials x an 8 s
 *   timeout is a 72-second worst case, and a probe that asks for
 *   five renditions must never inherit that per rendition. Callers
 *   on a critical path pass a small deadline; the walk stops at it
 *   and reports what it last heard.
 * @returns {Promise<Response>} the upstream answer (ok or last refusal).
 */
export async function askOwnSigner(
  videoKey,
  key,
  token = "",
  { range = "", timeoutMs = 8000, deadlineMs = 20000 } = {}
) {
  const deadline = Date.now() + Math.max(250, deadlineMs || 20000);
  const remaining = () => deadline - Date.now();
  // One credential's walk over the official hosts. A refusal is
  // remembered and the walk moves on; any other answer (200, 206,
  // 404, 5xx) is the host speaking for itself and is returned as-is.
  const askWith = async (cred) => {
    let last = null;
    const credKey = cred ? `${cred.length}:${cred.slice(0, 24)}` : "anon";
    for (const base of OWN_UPSTREAMS) {
      if (remaining() <= 0) break;
      // Keyed by credential, always: a 403 to an anonymous ask is
      // routinely a 200 to a minted one (that *is* the vidcloud
      // method), so a refusal must never be inherited by a different
      // credential — only re-asking with the *same* one is waste.
      const memoKey = `${base}|${credKey}`;
      const hit = refusalMemo.get(memoKey);
      if (hit && Date.now() - hit.at < REFUSAL_TTL) {
        last = new Response("refused (remembered)", { status: hit.status });
        continue;
      }
      let res;
      try {
        const url =
          `${base}?videoKey=${encodeURIComponent(videoKey)}&key=${encodeURIComponent(key)}` +
          (cred ? `&authorization=${encodeURIComponent(cred)}` : "");
        res = await fetch(url, {
          headers: { ...pwHeaders(cred), ...(range ? { Range: range } : {}) },
          redirect: "follow",
          signal: AbortSignal.timeout(Math.max(250, Math.min(timeoutMs, remaining()))),
        });
      } catch (err) {
        // The invocation's subrequest budget is spent: every further
        // fetch throws the same error, so spend nothing more proving
        // it — surface it and let the caller record the real cause.
        if (/subrequests/i.test(String((err && err.message) || err))) throw err;
        continue; // transport failure: next official host
      }
      if (res.ok || res.status === 206 || !REFUSALS.has(res.status)) return res;
      refusalMemo.set(memoKey, { status: res.status, at: Date.now() });
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
  // Refused: the credential is the problem, so mint. First the mint
  // already in hand (no network — five concurrent rendition asks
  // must not race five mint storms), then the network mint, then
  // exactly one fresh mint. The network mints are single-flight in
  // lib/pw-auth.mjs, so concurrent asks share one race. An expired
  // guest token draws precisely this answer from every host at once.
  const inHand = cachedToken();
  if (inHand && inHand !== prev && remaining() > 0) {
    prev = inHand;
    res = await askWith(inHand);
    if (!res || res.ok || res.status === 206 || !REFUSALS.has(res.status)) {
      return res || unreachable();
    }
  }
  for (const fresh of [false, true]) {
    if (remaining() <= 0) break;
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
