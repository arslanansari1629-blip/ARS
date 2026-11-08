/**
 * Shared HTTP helpers for the API routes.
 *
 * Vercel Node functions receive (req, res). Local dev uses the same signature
 * shim implemented in scripts/dev.mjs.
 */

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, Accept, Origin");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
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
