import { cors, json, query, badRequest, methodNotAllowed, modeOf, relayUrl } from "../lib/http.mjs";
import { resolveStream, parseFolder } from "../lib/api-data.mjs";
import { explainNoVideo } from "../lib/playback.mjs";

/**
 * GET /api/stream?batch=&subject=&id=      → resolve a playable plan for a lecture
 * GET /api/stream?url=<signed video url>   → resolve from a known URL
 *
 * The response tells the player how to play:
 *   { playable, kind: "hls"|"dash"|"mp4", url, reason }
 * Cross-origin media is proxied through /api/sign (HLS) or /api/hls (DASH) so
 * CloudFront's missing CORS headers never reach the browser.
 *
 * Failure answers are always `success: true` with `playable: false` plus a
 * human-readable `reason` — a lecture without a published video is a normal
 * state, not a server error, and the page shows that reason verbatim.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function scheduleTarget(batch, subject, id) {
  return `https://www.learnxpw.site/api/Schedule?BatchId=${encodeURIComponent(
    batch
  )}&SubjectId=${encodeURIComponent(subject)}&ContentId=${encodeURIComponent(id)}`;
}

async function readSchedule(batch, subject, id) {
  const res = await fetch(scheduleTarget(batch, subject, id), {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": UA,
      Origin: "https://www.learnxpw.site",
      Referer: "https://www.learnxpw.site/study/batches",
    },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);
  const d = (body && body.data) || null;
  if (!d) return { ok: false, rawUrl: "", detail: null };
  const vd = d.videoDetails || {};
  return {
    ok: true,
    rawUrl: vd.videoUrl || d.url || "",
    detail: {
      title: vd.name || d.topic || "",
      status: vd.status || d.status || "",
      lectureType: d.lectureType || d.urlType || "",
      drm: Boolean(vd.drmProtected || d.isDrmEnabled),
      isVideoLecture: d.isVideoLecture !== false,
      hasNotes: Array.isArray(d.homeworkIds) && d.homeworkIds.length > 0,
      startTime: d.startTime || d.date || "",
    },
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { url, folder, id, batch, subject } = query(req);
  const mode = modeOf(req);

  try {
    let rawUrl = url || "";
    let folderHint = folder || "";
    let detail = null;

    if (!rawUrl) {
      if (!batch || !subject || !id) {
        return badRequest(res, "Provide url, or batch + subject + id");
      }

      if (mode === "proxy") {
        // The browser fetches the schedule itself and re-calls this route with ?url=
        return json(res, 200, {
          success: true,
          playable: false,
          needsClientResolve: true,
          relay: relayUrl(scheduleTarget(batch, subject, id)),
          hint: "Fetch the relay, read data.videoDetails.videoUrl, then call /api/stream?url=",
        });
      }

      const sched = await readSchedule(batch, subject, id);
      detail = sched.detail;
      rawUrl = sched.rawUrl;

      if (!rawUrl) {
        return json(
          res,
          200,
          {
            success: true,
            playable: false,
            kind: "none",
            url: "",
            reason: explainNoVideo(detail),
            lecture: detail,
          },
          60
        );
      }
    }

    const plan = await resolveStream({ rawUrl, folder: folderHint || parseFolder(rawUrl) });

    // The schedule succeeded but no rendition answered: upstream signing is
    // usually rate-limited for a few seconds, not permanently broken, so say
    // so and tell the player it may retry instead of dead-ending the lecture.
    if (!plan.playable && !plan.retryAfter) plan.retryAfter = 6;

    return json(
      res,
      200,
      {
        success: true,
        ...plan,
        // Playback plans carry a live signed path, so they must never be cached.
        resolvedFrom: rawUrl,
        ...(detail ? { lecture: detail } : {}),
      },
      0
    );
  } catch (err) {
    return json(res, 200, {
      success: true,
      playable: false,
      kind: "unknown",
      url: "",
      reason:
        "The stream service could not be reached just now. Reload the page to try again — your notes and DPPs still work.",
      error: err?.message || "Stream resolution failed",
    });
  }
}
