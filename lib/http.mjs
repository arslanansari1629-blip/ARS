import { recordRequest, finishRequest } from "./admin.mjs";

/**
 * Shared HTTP helpers for the API routes.
 *
 * Vercel Node functions receive (req, res). Local dev uses the same signature
 * shim implemented in scripts/dev.mjs.
 */

/**
 * Every API route calls this first, which makes it the one honest place to count
 * traffic: the admin panel's numbers are then real requests, not a guess. The
 * count is written on the response's first header write, so the status code is
 * already known and latency can be measured to the start of the answer.
 */
export function cors(res, req) {
  if (req) {
    const mark = { req, at: Date.now(), counted: false };
    marked.set(res, mark);
    // The route's own `res.setHeader` calls are the first thing that happens
    // after the handler decides its status, so that is where the sample is taken.
    const writeHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (!mark.counted) {
        mark.counted = true;
        const status = res.statusCode || 200;
        recordRequest({ route: routeOf(req), status, ms: Date.now() - mark.at, res });
      }
      return writeHeader(name, value);
    };

    // Byte counts are only knowable at the end, so the response's own writers are
    // wrapped. `write` returns what the original did: callers rely on it.
    // Both are optional — a minimal response object (a test double, or a runtime
    // that only exposes `end`) still has to work, just without byte counts.
    const size = (chunk) => {
      if (!chunk) return;
      try {
        res.__adminBytes = (res.__adminBytes || 0) + Buffer.byteLength(chunk);
      } catch {
        /* non-buffer chunk (a callback given to end()): nothing to measure */
      }
    };

    if (typeof res.write === "function") {
      const write = res.write.bind(res);
      res.write = (chunk, ...rest) => {
        size(chunk);
        return write(chunk, ...rest);
      };
    }

    if (typeof res.end === "function") {
      const end = res.end.bind(res);
      res.end = (chunk, ...rest) => {
        if (typeof chunk !== "function") size(chunk);
        const result = end(chunk, ...rest);
        finishRequest(res);
        return result;
      };
    }
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Range, Accept, Origin, Cache-Control, If-None-Match, Pragma"
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
}

/** res -> { req, at } for every route that opted into traffic counting. */
const marked = new WeakMap();

/**
 * Which route a request belongs to, derived from the URL rather than passed in,
 * so a new route is counted without having to remember to instrument itself.
 */
function routeOf(req) {
  const url = String((req && req.url) || "");
  const name = (url.split("?")[0].split("/")[2] || "").replace(/\.mjs$/, "");
  return name || "other";
}

export function json(res, status, body, cacheSeconds = 0) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    cacheSeconds > 0
      ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
      : "no-store"
  );
  res.end(JSON.stringify(body));
}

export function query(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return Object.fromEntries(url.searchParams.entries());
}

export function methodNotAllowed(res) {
  json(res, 405, { success: false, error: "Method not allowed" });
}

export function badRequest(res, message) {
  json(res, 400, { success: false, error: message });
}

/**
 * `mode=direct` (default) fetches upstream from the server.
 * `mode=proxy` asks the browser to fetch upstream through the public CORS
 * relay — used automatically as a fallback when a server-side call is blocked.
 */
/**
 * Upstream blocked from this server (blocked network / datacenter IP).
 * Answer 200 with a hint so the browser can fetch the same live JSON itself.
 */
export function proxyFallback(res, reason, key = "batches") {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Data-Mode", "browser-relay");
  res.end(
    JSON.stringify({
      success: true,
      needsProxy: true,
      key,
      reason: (reason && reason.error) || "Upstream unreachable from this server",
    })
  );
}

export function modeOf(req) {
  return query(req).mode === "proxy" ? "proxy" : "direct";
}

export const RELAY_BASE = "https://api.allorigins.win/raw?url=";

export function relayUrl(target) {
  return `${RELAY_BASE}${encodeURIComponent(target)}`;
}

/** Rewrite absolute upstream URLs in a payload so the browser falls back. */
export function withRelayTargets(res, body, target, cacheSeconds = 0) {
  json(res, 200, { ...body, relay: relayUrl(target), upgrade: "proxy" }, cacheSeconds);
}
