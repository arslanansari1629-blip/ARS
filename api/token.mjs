import { cors, json, query } from "../lib/http.mjs";
import {
  resolveToken,
  pwHeaders,
  tokenState,
  TOKEN_SOURCES,
  FALLBACK_TOKEN,
} from "../lib/pw-auth.mjs";
import { UPSTREAMS } from "../lib/pw-proxy.mjs";

/**
 * GET /api/token         → token state + which hosts accept it
 * GET /api/token?fresh=1 → re-mint first
 *
 * Answers "why is a lecture 401" without guessing: it shows which token is in
 * use, where it came from, and then actually spends it against the hosts the
 * lecture API needs (the API itself, and the two signer relays that turn a
 * video folder into a signed playlist).
 *
 * The token value is never echoed in full — a redacted prefix is enough to
 * tell two tokens apart, and this route is reachable from a browser.
 */

const PROBES = [
  {
    name: "pw-api",
    url: "https://api.penpencil.co/v3/batches/698ad3519549b300a5e1cc6a/details",
    mode: "header",
  },
  {
    name: "vidcloud-signer",
    url: "https://vidcloud.eu.org/api/v1/videos/get-hls-key?videoKey=bef5b6ef-800a-4d57-ac4d-bd188e2a7aad&key=enc.key",
    mode: "header",
    binary: true,
  },
  {
    name: "studyspark-signer",
    url: "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key?videoKey=bef5b6ef-800a-4d57-ac4d-bd188e2a7aad&key=enc.key",
    mode: "header",
    binary: true,
  },
];

function redact(token) {
  if (!token) return "";
  if (token.length < 14) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

async function probe(probe) {
  const started = Date.now();
  try {
    const res = await fetch(probe.url, {
      headers: pwHeaders(probe.token),
      signal: AbortSignal.timeout(9000),
      redirect: "follow",
      cache: "no-store",
    });
    const entry = {
      host: probe.name,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - started,
    };
    if (probe.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      entry.bytes = buf.length;
      // An AES-128 key is exactly 16 bytes; anything else is an error page.
      if (res.ok) entry.looksLikeKey = buf.length === 16;
    } else {
      const text = await res.text();
      entry.looksLikeJson = text.trim().startsWith("{");
      if (!res.ok) entry.body = text.slice(0, 200);
    }
    return entry;
  } catch (err) {
    return {
      host: probe.name,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err?.name === "TimeoutError" ? "timed out" : err?.message || "unreachable",
    };
  }
}

/**
 * Ask the API whether the current token actually gets stream URLs.
 *
 * Every failure message about lectures depends on this distinction: signing
 * works fine with a guest token, but the schedule record only includes
 * `videoDetails.videoUrl` for a token that holds the batch. Without this split,
 * "the API refuses the token" and "this token sees no videos" look identical.
 */
async function probeEntitlement(token) {
  const BATCH = "698ad3519549b300a5e1cc6a";
  const SUBJECT = "6a6b44faf834f38ed6f9120d";
  const url = `${UPSTREAMS[0]}/v2/batches/${BATCH}/subject/${SUBJECT}/contents?page=1&contentType=videos`;
  try {
    const res = await fetch(url, {
      headers: pwHeaders(token),
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    });
    if (!res.ok) {
      return { checked: true, status: res.status, lectures: 0, withVideoUrl: 0, error: `upstream ${res.status}` };
    }
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : [];
    const withUrl = items.filter((i) => (i.videoDetails && i.videoDetails.videoUrl) || i.url);
    const first = items[0] || {};
    return {
      checked: true,
      status: res.status,
      lectures: items.length,
      withVideoUrl: withUrl.length,
      sampleTitle: (first.videoDetails && first.videoDetails.name) || first.topic || "",
      sampleVideoUrl: (first.videoDetails && first.videoDetails.videoUrl) || first.url || "",
    };
  } catch (err) {
    return { checked: true, error: err?.message || "probe failed", lectures: 0, withVideoUrl: 0 };
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const { fresh } = query(req);
  const { token, source, cached } = await resolveToken(fresh === "1");

  const probes = await Promise.all(PROBES.map((p) => probe({ ...p, token })));

  const signingWorks = probes
    .filter((p) => p.host !== "pw-api")
    .some((p) => p.ok && (p.looksLikeKey || p.bytes === 16));

  // Signing and entitlement are two different questions, and conflating them is
  // what made "no video" so hard to read. A guest token can sign any folder it
  // is told about — it just never gets told which folder, because the schedule
  // record only carries a `videoUrl` for tokens that hold the batch. So ask the
  // catalogue directly: do the lectures in a live batch carry a stream URL?
  const sample = await probeEntitlement(token);

  return json(
    res,
    200,
    {
      success: true,
      token: {
        value: redact(token),
        source,
        cached,
        state: tokenState(),
        isBuiltInFallback: token === FALLBACK_TOKEN,
        sources: TOKEN_SOURCES,
        pinnedByEnv: source.startsWith("env:"),
      },
      probes,
      entitlement: sample,
      // The headline answer: can this deployment fetch a signed lecture file?
      lectureSigning: signingWorks ? "working" : "unavailable",
      // …and can it find out *which* file a lecture is?
      lecturePlayback:
        sample.withVideoUrl > 0 ? "working" : signingWorks ? "metadata-only" : "unavailable",
      explain:
        sample.withVideoUrl > 0
          ? "The token sees lecture stream URLs, so lectures resolve and play."
          : signingWorks
            ? `The token can sign files, but the API returns no stream URL for these lectures (${sample.sampleTitle || "sample"}), so every lecture resolves as 'not published'. Set PW_TOKEN to a bearer that holds the batch to play them.`
            : "No signer accepted the token. Set PW_TOKEN to a valid PW bearer to restore lecture signing.",
      checkedAt: new Date().toISOString(),
    },
    0
  );
}
