import { cors, json, methodNotAllowed } from "../lib/http.mjs";
import { resolveToken, pwHeaders, BROWSER_UA } from "../lib/pw-auth.mjs";

/**
 * GET /api/pw/<anything>
 *   ?upstream=<base>   pin a different PW-compatible host
 *   ?fresh=1           mint a new guest token instead of using the cache
 *   ?raw=1             stream the upstream body bytes instead of parsing JSON
 *   ?bin=1             force binary passthrough (segments, AES keys, PDFs)
 *
 * A single authenticated pass-through to the PW API surface, so anything the
 * upstream can do, this deployment can do:
 *
 *   /api/pw/v3/batches/<id>/details
 *   /api/pw/v2/batches/<id>/subject/<sid>/topics?page=1
 *   /api/pw/v2/batches/<id>/subject/<sid>/contents?page=1&contentType=videos&tag=<topic>
 *   /api/pw/v1/batches/<b>/subject/<s>/schedule/<id>/schedule-details
 *   /api/pw/v1/videos/get-otp?key=<hex>&isEncoded=true
 *   /api/pw/v1/videos/get-hls-key?videoKey=<folder>&key=720/main.m3u8
 *   /api/pw/v3/test-service/tests/new-dpp-list?page=1&batchId=&batchSubjectId=
 *
 * Credentials are attached here, not in the browser: the guest token never
 * reaches a client, which is the whole reason the lecture API needs a proxy at
 * all (upstream answers 401 to an unauthenticated call).
 *
 * Security: the host is allowlisted (no SSRF to arbitrary addresses), the path
 * has to look like a PW API path (no traversal), and nothing is cached that
 * could carry a signed path to the wrong user.
 */

/** PW-compatible hosts. The first is the current API generation. */
export const UPSTREAMS = [
  "https://api.penpencil.co",
  "https://api.penpencil.xyz",
  "https://vidcloud.eu.org/api",
  "https://api.studyspark.study/api/penpencil",
  "https://www.learnxpw.site/api",
];

const ALLOWED_HOSTS = new Set(
  UPSTREAMS.map((u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  })
);

/** Query params this route consumes itself. */
const OWN_PARAMS = new Set(["upstream", "fresh", "raw", "bin", "host", "path"]);

/** Endpoints that return a signed/binary payload and must not be JSON-parsed. */
const BINARY_PATH = /(get-hls-key|get-otp|\.pdf$|\.ts$|\.m4s|\.mp4$|enc\.key|init\.mp4)/i;

function upstreamBase(param) {
  if (!param) return UPSTREAMS[0];
  try {
    const u = new URL(param);
    if (!ALLOWED_HOSTS.has(u.hostname)) return "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Only PW API paths are proxied.
 *
 * A URL parser silently normalises `../../etc/passwd` down to `etc/passwd`, so
 * looking for ".." is not enough on its own: the leading segment is checked
 * against the API's real surface as well, which also stops the proxy being used
 * as a general-purpose forwarder for anything else on those hosts.
 */
const PATH_PREFIXES =
  /^(v\d+|api|search|searchBatch|AllBatches|BatchInfo|SubjectInfo|TopicInfo|Schedule|GetPdf|batch|batches)\b/i;

function safePath(raw) {
  const path = String(raw || "").replace(/^\/+/, "");
  if (!path) return "";
  // Reject traversal and absolute URLs smuggled into the path. Checked on the
  // *decoded* value, and again after normalising, so `%2e%2e%2f` cannot slip
  // through either.
  const decoded = path.replace(/%2e/gi, ".");
  if (decoded.includes("..") || /^[a-z]+:\/\//i.test(decoded)) return "";
  if (!PATH_PREFIXES.test(decoded)) return "";
  return path;
}

async function pipe(res, upstream) {
  res.statusCode = upstream.status;
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  // A signed segment or key is still the same bytes for everyone, but a playlist
  // is signature-bound — never let a cache serve one to a different request.
  res.setHeader("Cache-Control", "no-store");

  if (!upstream.body) return res.end(Buffer.from(await upstream.arrayBuffer()));
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
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res);

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // The wildcard segment comes from the route file when Vercel parses it, and
  // from the query string otherwise (local dev, curl, the bare /api/pw usage
  // answer). `?path=` is the only form that also works for JSON clients.
  const fromQuery = url.searchParams.get("path") || "";
  const path = safePath(
    decodeURIComponent(String(req.__pwPath || fromQuery || url.pathname.replace(/^\/api\/pw\/?/, "")))
  );
  if (!path) {
    return json(res, 400, {
      success: false,
      error: "Give a PW API path after /api/pw/, e.g. /api/pw/v3/batches/<id>/details",
      upstreams: UPSTREAMS,
    });
  }

  const base = upstreamBase(url.searchParams.get("upstream") || url.searchParams.get("host"));
  if (!base) {
    return json(res, 400, {
      success: false,
      error: "That upstream host is not allowlisted",
      allowed: Array.from(ALLOWED_HOSTS),
    });
  }

  const fresh = url.searchParams.get("fresh") === "1";
  const wantsBinary =
    url.searchParams.get("bin") === "1" ||
    url.searchParams.get("raw") === "1" ||
    BINARY_PATH.test(path);

  // Forward every query param except our own switches.
  const forward = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (!OWN_PARAMS.has(k)) forward.append(k, v);
  }

  let { token, source } = await resolveToken(fresh);

  // Walk every allowlisted host: these all expose the same API surface, and on
  // any given day one of them is blocked, rate-limited or simply down. Pinning
  // `?upstream=` keeps the caller in control when they need a specific one.
  const pinned = Boolean(url.searchParams.get("upstream") || url.searchParams.get("host"));
  const hosts = pinned ? [base] : [base, ...UPSTREAMS.filter((u) => u !== base)];

  let upstream = null;
  let target = "";
  let lastFailure = "";
  const tried = [];

  for (const host of hosts) {
    target = `${host}/${path}${forward.toString() ? `?${forward}` : ""}`;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: pwHeaders(token, req.headers.range ? { Range: req.headers.range } : {}),
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
        cache: "no-store",
      });
      tried.push({ host, status: upstream.status });
    } catch (err) {
      lastFailure = err?.name === "TimeoutError" ? "timed out" : err?.message || "unreachable";
      tried.push({ host, status: 0, error: lastFailure });
      upstream = null;
      continue;
    }
    // A 5xx from one host is worth retrying on the next one; a 4xx is an
    // answer about the request itself, not about the host.
    if (upstream.status >= 500) {
      tried[tried.length - 1].error = `upstream ${upstream.status}`;
      continue;
    }
    break;
  }

  if (!upstream) {
    return json(res, 502, {
      success: false,
      error: "No PW-compatible host answered for this path.",
      path,
      tried,
      reason: lastFailure,
      hint: "Lock a host with ?upstream=, or retry with ?fresh=1 for a new token.",
    });
  }

  // One retry with a fresh token: an expired guest token is by far the most
  // common 401 here, and it is not the caller's fault.
  if (upstream.status === 401 || upstream.status === 403) {
    const retried = await resolveToken(true);
    if (retried.token && retried.token !== token) {
      try {
        const second = await fetch(target, {
          method: req.method,
          headers: pwHeaders(retried.token, req.headers.range ? { Range: req.headers.range } : {}),
          redirect: "follow",
          signal: AbortSignal.timeout(30000),
          cache: "no-store",
        });
        if (second.ok) {
          upstream = second;
        }
      } catch {
        /* keep the original 401 answer */
      }
    }
  }

  res.setHeader("X-PW-Upstream", target.split("/").slice(0, 3).join("/"));
  res.setHeader("X-PW-Tried", tried.map((t) => `${t.host}:${t.status}`).join(","));
  res.setHeader("X-PW-Auth", source);

  if (!upstream.ok && upstream.status !== 206) {
    const body = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* not JSON */
    }
    res.statusCode = upstream.status === 404 ? 404 : 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(
      JSON.stringify({
        success: false,
        error: `Upstream ${base} answered ${upstream.status}`,
        upstreamStatus: upstream.status,
        upstreamBody: parsed || body.slice(0, 500),
        target,
        auth: source,
        hint:
          upstream.status === 401
            ? "Every known guest token was rejected. Set PW_TOKEN to a valid PW bearer to unlock this endpoint."
            : "Try ?upstream= with one of the other allowlisted hosts, or ?fresh=1 for a new token.",
      })
    );
  }

  if (wantsBinary) return pipe(res, upstream);

  const text = await upstream.text();
  // Pass JSON through untouched (adding metadata), and non-JSON as-is — some
  // endpoints answer a playlist even though the path looks like JSON.
  try {
    const parsed = JSON.parse(text);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(parsed));
  } catch {
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "text/plain; charset=utf-8"
    );
    res.setHeader("Cache-Control", "no-store");
    return res.end(text);
  }
}
