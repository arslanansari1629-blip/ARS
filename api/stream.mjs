import { cors, json, query, badRequest, methodNotAllowed, modeOf, relayUrl } from "../lib/http.mjs";
import { resolveStream, parseFolder, fetchSchedule } from "../lib/api-data.mjs";
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

/**
 * The schedule record for a lecture, via the shared reader.
 *
 * This route used to fetch a hard-coded mirror URL itself, which meant the
 * player and every other page could disagree about the same lecture: the mirror
 * hands back a real `videoDetails.videoUrl` while the modern route leaves it
 * empty, and only one of them was being asked depending on which page you were on.
 */
async function readSchedule(batch, subject, id) {
  const res = await fetchSchedule(batch, subject, id);
  if (!res.ok) return { ok: false, rawUrl: "", detail: null, error: res.error };
  const l = res.lecture;
  return {
    ok: true,
    rawUrl: l.videoUrl,
    detail: {
      title: l.title,
      status: l.videoStatus,
      lectureType: l.urlType,
      drm: l.drm,
      isVideoLecture: l.isVideoLecture,
      hasNotes: res.docs.length > 0,
      startTime: l.date,
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
          relay: relayUrl(
            `/api/pw/Schedule?BatchId=${encodeURIComponent(batch)}&SubjectId=${encodeURIComponent(
              subject
            )}&ContentId=${encodeURIComponent(id)}`
          ),
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
