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
import { cors, json } from "../lib/http.mjs";
import proxy, { UPSTREAMS } from "../lib/pw-proxy.mjs";

const EXAMPLES = [
  "/api/pw/v3/batches/698ad3519549b300a5e1cc6a/details",
  "/api/pw/v2/batches/<batch>/subject/<subject>/topics?page=1",
  "/api/pw/v2/batches/<batch>/subject/<subject>/contents?page=1&contentType=videos&tag=<topic>",
  "/api/pw/v1/videos/get-otp?key=<hex>&isEncoded=true",
  "/api/pw/v1/videos/get-hls-key?videoKey=<folder>&key=720/main.m3u8",
];

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const hasPath = Boolean(url.searchParams.get("path"));

  // Bare /api/pw is a usage page, not a 404: this route is meant to be
  // discovered from a browser.
  if (!hasPath) {
    cors(res);
    if (req.method === "OPTIONS") return res.end();
    return json(res, 400, {
      success: false,
      error: "Append a PW API path: /api/pw/v3/batches/<id>/details",
      examples: EXAMPLES,
      upstreams: UPSTREAMS,
    });
  }

  return proxy(req, res);
}
