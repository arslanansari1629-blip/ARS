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

/**
 * Rolling prefetch: keep the edge a few segments ahead of the playhead.
 *
 * Playlists warm the *opening* segments; this warms the *next* ones.
 * Whenever a segment is served (hit or miss), the following four are
 * pulled into the edge in the background, so a viewer who keeps watching
 * never waits on a signer again — the cache chases the playhead. Segment
 * names are sequential (`360/041.ts`), so the future URLs are derivable
 * from the current one. Bounded and cache-checked: already-warm segments
 * cost one lookup, never a fetch.
 */
async function prefetchNextSegments(request, env, cache) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "";
    const m = key.match(/^(\d+)\/(\d+)\.(ts|m4s)$/i);
    if (!m) return;
    const idx = Number(m[2]);
    const jobs = [];
    for (let n = idx + 1; n <= idx + 4; n += 1) {
      const next = new URL(url.toString());
      next.searchParams.set("key", `${m[1]}/${String(n).padStart(m[2].length, "0")}.${m[3]}`);
      jobs.push(next.toString());
    }
    await Promise.all(
      jobs.map(async (u) => {
        const req = new Request(u);
        if (await cache.match(req).catch(() => null)) return;
        const r = await dispatch(req, env).catch(() => null);
        if (r && r.status === 200) await cache.put(req, r).catch(() => {});
      })
    );
  } catch {
    /* warming is best-effort */
  }
}

/** The stale-shadow key for a URL: same request, fragment marker. */
function shadowKey(request) {
  const u = new URL(request.url);
  u.hash = "stale-shadow";
  return new Request(u.toString(), { method: "GET" });
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
      const rangeAsk = Boolean(request.headers.get("range"));
      if (
        request.method === "GET" &&
        !rangeAsk &&
        CACHEABLE.has(url.pathname) &&
        typeof caches !== "undefined"
      ) {
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
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(prefetchNextSegments(request, env, cache));
          }
          return out;
        }
        let res = await dispatch(request, env);
        // Edge retry: signer refusals come in seconds-long bursts, and a
        // playlist/segment 502 this instant is routinely a 200 a breath
        // later. One quiet re-ask at the edge (only for media relays,
        // only on a 502) absorbs the burst before the player ever sees it.
        if (res.status === 502 && url.pathname === "/api/sign") {
          await new Promise((r) => setTimeout(r, 400));
          const again = await dispatch(request, env).catch(() => null);
          if (again && again.status === 200) res = again;
        }
        // Stale-if-error: a rendition playlist's segment list cannot
        // change mid-lecture, so yesterday's copy beats today's outage.
        // Playlists keep a long-lived shadow copy for exactly this.
        if (res.status !== 200 && /\.m3u8/i.test(url.searchParams.get("key") || "")) {
          const stale = await cache.match(shadowKey(request)).catch(() => null);
          if (stale) {
            const out = new Response(stale.body, stale);
            out.headers.set("x-ars-cache", "stale");
            return out;
          }
        }
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
              .then(async () => {
                // Shadow copy with a day-long life, read only when the
                // signer is down (see stale-if-error above).
                if (/mpegurl/i.test(res.headers.get("content-type") || "")) {
                  const shadow = new Response(res.clone().body, res);
                  shadow.headers.set("Cache-Control", "public, max-age=86400");
                  await cache.put(shadowKey(request), shadow).catch(() => {});
                }
                await prefetchPlaylist(request, res, env, cache);
                await prefetchNextSegments(request, env, cache);
              })
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
