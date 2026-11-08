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

/**
 * Fetch one PW API path with the server-side credential attached, without going
 * through HTTP.
 *
 * The site's own reads used to call itself (`fetch("https://<deployment>/api/pw" +
 * path)`), which is a loopback: on Vercel the deployment URL sits behind
 * deployment protection and answers an auth page, so every lecture resolved to
 * "no video". Calling the same dispatcher the route calls keeps one credential
 * strategy, one host failover and one error shape, with no round trip.
 *
 * Returns the raw `Response` so a caller can stream it (media) or parse it
 * (`upstreamJson`). Never throws: a network failure comes back as status 0.
 */
export async function pwFetch(path, init = {}) {
  const safe = safePath(String(path || "").replace(/^\/+/, ""));
  if (!safe) return new Response(JSON.stringify({ success: false, error: "not a PW API path" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

  const { token } = await resolveToken(false);
  const pinned = init.upstream ? upstreamBase(init.upstream) : "";
  const hosts = pinned ? [pinned] : UPSTREAMS;

  let rejection = null;
  let lastError = "unreachable";
  for (const host of hosts) {
    const target = `${host}/${safe}`;
    let response;
    try {
      response = await fetch(target, {
        method: init.method || "GET",
        headers: pwHeaders(token, init.headers || {}),
        redirect: "follow",
        signal: AbortSignal.timeout(init.timeout || 15000),
        cache: "no-store",
      });
    } catch (err) {
      lastError = err?.name === "TimeoutError" ? "timed out" : err?.message || "unreachable";
      continue;
    }
    if (response.ok || response.status === 206 || response.status === 404) return response;
    if (!pinned) {
      rejection = rejection || response;
      continue;
    }
    return response;
  }
  return (
    rejection ||
    new Response(JSON.stringify({ success: false, error: lastError, path: safe }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  );
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
  //
  // They are also not interchangeable per endpoint. `get-hls-key` answers 401 on
  // api.penpencil.co and 200 (a real 16-byte AES key) on vidcloud.eu.org/api for
  // the identical token, because signing is bound to the host that minted it. So
  // a 4xx means "wrong host for this path, keep looking", not "bad request"; the
  // first rejection is kept so the caller still gets an honest upstream answer
  // when no host serves it. A 404 stays definitive — that is a real answer about
  // the path, and retrying it on five mirrors just makes 404s slow.
  const pinned = Boolean(url.searchParams.get("upstream") || url.searchParams.get("host"));
  const hosts = pinned ? [base] : [base, ...UPSTREAMS.filter((u) => u !== base)];

  const attempt = async (bearer) => {
    const tried = [];
    let rejection = null;
    for (const host of hosts) {
      const to = `${host}/${path}${forward.toString() ? `?${forward}` : ""}`;
      let response;
      try {
        response = await fetch(to, {
          method: req.method,
          headers: pwHeaders(bearer, req.headers.range ? { Range: req.headers.range } : {}),
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
          cache: "no-store",
        });
      } catch (err) {
        tried.push({
          host,
          status: 0,
          error: err?.name === "TimeoutError" ? "timed out" : err?.message || "unreachable",
        });
        continue;
      }
      tried.push({ host, status: response.status });
      if (response.ok || response.status === 206) return { upstream: response, target: to, tried };
      if (response.status === 404 || response.status === 410) {
        return { upstream: response, target: to, tried };
      }
      // 400/401/403/405 — this host will not do it, another one might.
      if (!rejection) rejection = { upstream: response, target: to };
      else await response.arrayBuffer().catch(() => {});
    }
    return {
      upstream: rejection?.upstream || null,
      target: rejection?.target || `${base}/${path}`,
      tried,
    };
  };

  let { upstream, target, tried } = await attempt(token);

  // One more full pass with a freshly minted token: an expired guest token is by
  // far the most common 401 here, and it is not the caller's fault.
  if (upstream && (upstream.status === 401 || upstream.status === 403)) {
    const retried = await resolveToken(true);
    if (retried.token && retried.token !== token) {
      const again = await attempt(retried.token);
      if (again.upstream && again.upstream.status !== 401 && again.upstream.status !== 403) {
        upstream = again.upstream;
        target = again.target;
        tried = [...tried, ...again.tried];
        source = retried.source;
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
        error: `Upstream ${target.split("/").slice(0, 3).join("/")} answered ${upstream.status}`,
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
