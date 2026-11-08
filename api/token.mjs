import { cors, json, query } from "../lib/http.mjs";
import { resolveToken, pwHeaders, tokenState, TOKEN_SOURCES, FALLBACK_TOKEN } from "../lib/pw-auth.mjs";

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
      // The headline answer: can this deployment fetch a signed lecture file?
      lectureSigning: signingWorks ? "working" : "unavailable",
      explain: signingWorks
        ? "The signer relays accept the token, so lecture playlists, AES keys and segments can be proxied."
        : "No signer accepted the token. Set PW_TOKEN to a valid PW bearer to restore lecture signing.",
      checkedAt: new Date().toISOString(),
    },
    0
  );
}
