/**
 * `GET /api/pw?path=v3/batches/<id>/details` — the query-string form.
 *
 * Vercel's filesystem router will not let `api/pw.mjs` and `api/pw/[...path].mjs`
 * both own `/api/pw/*`, so the wildcard lives in the directory. This sibling
 * keeps the bare `/api/pw` (no trailing path) answering with usage instead of a
 * 404, which makes the route discoverable.
 */
import { cors, json } from "../lib/http.mjs";
import { UPSTREAMS } from "../lib/pw-proxy.mjs";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  return json(res, 400, {
    success: false,
    error: "Append a PW API path: /api/pw/v3/batches/<id>/details",
    examples: [
      "/api/pw/v3/batches/698ad3519549b300a5e1cc6a/details",
      "/api/pw/v2/batches/<batch>/subject/<subject>/topics?page=1",
      "/api/pw/v2/batches/<batch>/subject/<subject>/contents?page=1&contentType=videos&tag=<topic>",
      "/api/pw/v1/videos/get-otp?key=<hex>&isEncoded=true",
      "/api/pw/v1/videos/get-hls-key?videoKey=<folder>&key=720/main.m3u8",
    ],
    upstreams: UPSTREAMS,
  });
}
