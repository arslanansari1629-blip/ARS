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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // Zero-buffer rule #1: a signed segment is the same bytes for every
      // viewer forever, so the second play of any lecture must be an edge
      // hit (~20 ms), never another signer round trip (~1 s). Playlists
      // ride along at their own short Cache-Control. Only `/api/sign`
      // GETs are cached, only on a 200, and the Cache API honours the
      // response's own Cache-Control — errors (no-store) never stick.
      if (request.method === "GET" && url.pathname === "/api/sign" && typeof caches !== "undefined") {
        const cache = caches.default;
        const hit = await cache.match(request).catch(() => null);
        if (hit) {
          const out = new Response(hit.body, hit);
          out.headers.set("x-ars-cache", "edge");
          return out;
        }
        const res = await dispatch(request, env);
        if (res.status === 200 && ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(cache.put(request, res.clone()).catch(() => {}));
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
