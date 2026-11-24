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
import { watchdogBots } from "../lib/bot-host.mjs";
import { setKvBinding } from "../lib/store.mjs";

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
      const m = line.match(/URI="([^"]+)"/) || line.trim().match(/^((?:https?:\/\/)?\/?\S+)$/);
      if (m && m[1].includes("/api/sign?")) urls.push(new URL(m[1], request.url).toString());
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

/**
 * Warm the whole chain when a lecture resolves.
 *
 * `/api/stream` answers with a plan whose URL is our own master playlist.
 * The student still has to press play, but the edge does not have to wait
 * for that: dispatch the master, then its first variant playlist (which
 * triggers the key + opening-segment warm), all in the background. Press
 * play a second later and every first request is already an edge hit.
 */
async function warmPlan(request, res, env, cache) {
  try {
    const plan = await res.clone().json();
    const target = plan && typeof plan.url === "string" ? plan.url : "";
    if (!target.startsWith("/api/sign?")) return;
    const masterReq = new Request(new URL(target, request.url).toString());
    if (!(await cache.match(masterReq).catch(() => null))) {
      const master = await dispatch(masterReq, env).catch(() => null);
      if (master && master.status === 200) {
        await cache.put(masterReq, master.clone()).catch(() => {});
        const text = await master.text().catch(() => "");
        const variant = text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.includes("/api/sign?"));
        if (variant) {
          const vReq = new Request(new URL(variant, request.url).toString());
          if (!(await cache.match(vReq).catch(() => null))) {
            const vRes = await dispatch(vReq, env).catch(() => null);
            if (vRes && vRes.status === 200) {
              await cache.put(vReq, vRes.clone()).catch(() => {});
              await prefetchPlaylist(vReq, vRes, env, cache);
            }
          }
        }
      }
    }
  } catch {
    /* warming is best-effort */
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // A resolved lecture plan warms its whole playback chain (see
      // warmPlan) — by the time the student presses play, the master,
      // the first variant, its key and its opening segments are edge hits.
      if (
        request.method === "GET" &&
        url.pathname === "/api/stream" &&
        typeof caches !== "undefined" &&
        ctx &&
        typeof ctx.waitUntil === "function"
      ) {
        const cache = caches.default;
        // A resolved plan is only relative relay links (the aryavidya
        // rule), so it cannot expire in a cache the way a signed plan
        // once could. Two minutes at the edge turns repeat opens of a
        // popular lecture into a ~20 ms answer with no schedule walk and
        // no signer probe at all. Only playable plans are stored: a
        // refusal cached for two minutes would park students on an
        // outage that already ended.
        const hit = await cache.match(request).catch(() => null);
        if (hit) {
          const out = new Response(hit.body, hit);
          out.headers.set("x-ars-cache", "edge-plan");
          return out;
        }
        const res = await dispatch(request, env);
        if (res.status === 200) {
          ctx.waitUntil(warmPlan(request, res.clone(), env, cache));
          try {
            const plan = await res.clone().json();
            if (plan && plan.playable) {
              const stored = new Response(res.clone().body, res);
              stored.headers.set("Cache-Control", "public, max-age=120");
              stored.headers.delete("set-cookie");
              ctx.waitUntil(cache.put(request, stored).catch(() => {}));
            }
          } catch {
            /* a non-JSON answer is simply not cached */
          }
        }
        return res;
      }
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

  /**
   * Two clocks share this handler. The daily one re-runs the site
   * scanner (`0 3 * * *`, the `x-vercel-cron` proof the admin route
   * expects from a platform cron). The five-minute one is the bot
   * watchdog: every live Telegram bot's webhook is checked against
   * Telegram's record and re-registered if it drifted — that, plus KV
   * holding the bot records, is what makes hosting 24×7 rather than
   * "until the isolate recycles".
   */
  async scheduled(event, env, ctx) {
    if (event?.cron === "0 3 * * *") {
      ctx.waitUntil(
        dispatch(
          new Request("https://arsvibe.internal/api/admin?action=scan&cron=1", {
            headers: { "x-vercel-cron": "1" },
          }),
          env
        )
      );
      return;
    }
    try {
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          if (typeof v === "string" && process.env[k] === undefined) process.env[k] = v;
        }
        if (env.ARS_KV) setKvBinding(env.ARS_KV);
      }
    } catch { /* bindings are best-effort here; memory still answers */ }
    ctx.waitUntil(watchdogBots().catch(() => null));
  },
};
