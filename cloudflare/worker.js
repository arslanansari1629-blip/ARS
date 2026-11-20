/**
 * ArsVibe PW on Cloudflare Workers (free `*.workers.dev` subdomain).
 *
 * One Worker serves the whole site:
 *   · `/api/*` → the twelve handlers in `api/*.mjs`, unchanged, through
 *     the same fetch adapter the Pages experiment used
 *     (`functions/api/[[route]].js`);
 *   · everything else → the static site in `public/` via the ASSETS
 *     binding (Workers Static Assets, unlimited free bandwidth);
 *   · a daily cron re-runs the site scanner, replacing Vercel Cron.
 */

import { dispatch } from "../functions/api/[[route]].js";

const CACHEABLE = new Set([
  "/api/sign",
  "/api/hls",
  // Catalogue JSON rides along: chapters/contents/batch pages declare
  // their own short s-maxage, and the Cache API honours it — a popular
  // subject page then costs one upstream walk per edge per few minutes
  // instead of one per student, which is also what keeps PW's throttle
  // from turning into empty chapter lists. Error bodies are no-store
  // and the put below only ever stores a 200.
  "/api/contents",
  "/api/batch",
  "/api/batches",
]);

/**
 * Warm the edge with the bytes playback needs next.
 *
 * A rendition playlist names the AES key and every segment up front, so
 * the moment one is served we already know the first requests the player
 * will make. Fetching the key + first segments in the background (through
 * the same in-process dispatch — a Worker may not fetch its own origin)
 * means the player's first segment is an edge hit on first play too, not
 * just on replays. Bounded to 8 URLs: warming a whole lecture would burn
 * the subrequest budget for viewers who may never press play.
 */
async function prefetchPlaylist(request, res, env, cache) {
  try {
    const type = res.headers.get("content-type") || "";
    if (!/mpegurl/i.test(type)) return;
    const key = new URL(request.url).searchParams.get("key") || "";
    if (!/main\.m3u8$/i.test(key)) return; // media playlists only, not the master
    const text = await res.clone().text();
    const urls = [];
    for (const line of text.split("\n")) {
      const m = line.match(/URI="([^"]+)"/) || line.trim().match(/^(https?:\/\/\S+)$/);
      if (m && m[1].includes("/api/sign?")) urls.push(m[1]);
      if (urls.length >= 8) break;
    }
    await Promise.all(
      urls.map(async (u) => {
        const req = new Request(u);
        if (await cache.match(req).catch(() => null)) return;
        const r = await dispatch(req, env).catch(() => null);
        if (r && r.status === 200) await cache.put(req, r).catch(() => {});
      })
    );
  } catch {
    /* warming is best-effort; playback never depends on it */
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // Zero-buffer rule #1: a signed segment is the same bytes for every
      // viewer forever, so the second play of any lecture must be an edge
      // hit (~20 ms), never another signer round trip (~1 s). Playlists
      // ride along at their own short Cache-Control. Only GETs on the two
      // media relays are cached, only on a 200, and the Cache API honours
      // the response's own Cache-Control — errors (no-store) never stick.
      if (request.method === "GET" && CACHEABLE.has(url.pathname) && typeof caches !== "undefined") {
        const cache = caches.default;
        const hit = await cache.match(request).catch(() => null);
        if (hit) {
          const out = new Response(hit.body, hit);
          out.headers.set("x-ars-cache", "edge");
          // The stored copy carries the first viewer's CORS origin; a
          // cached response must answer for whoever is asking now.
          const origin = request.headers.get("origin");
          if (origin && out.headers.has("access-control-allow-origin")) {
            out.headers.set("access-control-allow-origin", origin);
          }
          return out;
        }
        const res = await dispatch(request, env);
        const cacheable200 =
          res.status === 200 && !/no-store|private/i.test(res.headers.get("cache-control") || "");
        if (cacheable200 && ctx && typeof ctx.waitUntil === "function") {
          // Re-wrap so the headers are ours to edit: a platform response's
          // header list may be immutable, and the put must not die on it.
          const stored = new Response(res.clone().body, res);
          stored.headers.delete("set-cookie");
          ctx.waitUntil(
            cache
              .put(request, stored)
              .then(() => prefetchPlaylist(request, res, env, cache))
              .catch(() => {})
          );
        }
        return res;
      }
      return dispatch(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  /** Daily scanner pass — the `x-vercel-cron` proof the admin route expects from a platform cron. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      dispatch(
        new Request("https://arsvibe.internal/api/admin?action=scan&cron=1", {
          headers: { "x-vercel-cron": "1" },
        }),
        env
      )
    );
  },
};
