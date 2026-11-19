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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return dispatch(request, env);
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
