import { cors, json, query, badRequest, methodNotAllowed, modeOf, relayUrl } from "../lib/http.mjs";
import { resolveStream, parseFolder } from "../lib/api-data.mjs";

/**
 * GET /api/stream?batch=&subject=&id=      → resolve a playable plan for a lecture
 * GET /api/stream?url=<signed video url>   → resolve from a known URL
 *
 * The response tells the player how to play:
 *   { playable, kind: "hls"|"dash"|"mp4", url, reason }
 * Cross-origin media is proxied through /api/media so CloudFront's missing
 * CORS headers never reach the browser.
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { url, folder, id, batch, subject } = query(req);
  const mode = modeOf(req);

  try {
    let rawUrl = url || "";
    let folderHint = folder || "";

    if (!rawUrl) {
      if (!batch || !subject || !id) {
        return badRequest(res, "Provide url, or batch + subject + id");
      }
      // Reuse the schedule endpoint upstream exposes (it carries videoDetails.videoUrl)
      const target = `https://www.learnxpw.site/api/Schedule?BatchId=${encodeURIComponent(
        batch
      )}&SubjectId=${encodeURIComponent(subject)}&ContentId=${encodeURIComponent(id)}`;

      if (mode === "proxy") {
        // The browser fetches the schedule itself and re-calls this route with ?url=
        return json(res, 200, {
          success: true,
          playable: false,
          needsClientResolve: true,
          relay: relayUrl(target),
          hint: "Fetch the relay, read data.videoDetails.videoUrl, then call /api/stream?url=",
        });
      }

      const r = await fetch(target, {
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Origin: "https://www.learnxpw.site",
          Referer: "https://www.learnxpw.site/study/batches",
        },
        signal: AbortSignal.timeout(20000),
      });
      const body = await r.json().catch(() => null);
      const d = body && body.data;
      rawUrl = (d && d.videoDetails && d.videoDetails.videoUrl) || (d && d.url) || "";
      if (!rawUrl) {
        return json(res, 200, {
          success: true,
          playable: false,
          kind: "unknown",
          url: "",
          reason:
            "This lecture has no published video yet (it may be a notes-only or upcoming class).",
        });
      }
    }

    const plan = await resolveStream({ rawUrl, folder: folderHint || parseFolder(rawUrl) });
    return json(res, 200, { success: true, ...plan, resolvedFrom: rawUrl }, 60);
  } catch (err) {
    return json(res, 500, {
      success: false,
      playable: false,
      error: err?.message || "Stream resolution failed",
    });
  }
}
