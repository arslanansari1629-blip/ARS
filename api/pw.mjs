/**
 * `GET /api/pw/<pw api path>` — the authenticated pass-through.
 *
 * Two ways in, because Vercel's filesystem router and the query string disagree
 * about what a path is:
 *
 *   /api/pw/v3/batches/<id>/details                       (rewritten, see vercel.json)
 *   /api/pw?path=v3/batches/<id>/details                  (works anywhere)
 *
 * Both land here. A dedicated catch-all function would be the obvious spelling,
 * but the Hobby plan caps a deployment at 12 serverless functions and this has
 * to share one, so `vercel.json` rewrites `/api/pw/:path*` onto this file and
 * passes the tail as `?path=`.
 *
 * The implementation lives in `lib/pw-proxy.mjs` so the route stays a mount.
 */
import proxy from "../lib/pw-proxy.mjs";

/**
 * This file is only a *mount*, and it must stay one.
 *
 * It used to keep its own copy of the usage text for a bare `/api/pw`, which
 * answered before the dispatcher ever ran — so the discovery page implemented in
 * `lib/pw-proxy.mjs` was unreachable in production while its unit test passed
 * against the library directly. Two places describing the same API surface is
 * exactly how they drift. All behaviour, including what a bare `/api/pw` says,
 * lives in the dispatcher.
 */
export default async function handler(req, res) {
  return proxy(req, res);
}
