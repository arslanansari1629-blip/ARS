import { cors, json, query, badRequest, methodNotAllowed, modeOf, relayUrl } from "../lib/http.mjs";
import hlsHandler from "../lib/hls.mjs";
import downloadHandler from "../lib/download-route.mjs";
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

/**
 * A video folder is a bare UUID.
 *
 * Checked as a whole value rather than by looking for dots: the shortcut below
 * turns this string into an upstream request, so anything that is not exactly a
 * folder id — a path, a URL, an empty string — must not reach it.
 */
const FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isFolderId(value) {
  return FOLDER_ID.test(String(value || ""));
}

/**
 * How long a plan may sit in the shared edge cache.
 *
 * Two kinds of plan exist. An HLS plan's URL is *our own relay path*
 * (`/api/sign?videoKey=…`) — no signature is embedded in it, because the
 * relay signs every playlist and segment as it is asked. That plan is the
 * same for every viewer and stays true for minutes, so caching it for 60 s
 * turns a popular lecture's resolution (a signer probe, ~1–3 s) into an
 * edge hit. A plan built from an already-signed CDN URL *does* embed its
 * signature, and a retry (`attempt > 0`) exists precisely because the last
 * plan died — neither may ever be served from a cache.
 */
function planCacheSeconds(plan, attempt) {
  if (!plan || !plan.playable) return 0;
  if (Number(attempt || 0) > 0) return 0;
  if (plan.kind === "hls" && String(plan.url || "").startsWith("/api/sign?")) return 60;
  return 0;
}

export default async function handler(req, res) {
  // `/api/hls` is rewritten onto this function (see vercel.json): the Hobby plan
  // allows twelve serverless functions per deployment and this project needs
  // thirteen routes. The HLS gateway keeps its own CORS and caching rules, so it
  // is mounted before this route's headers are written.
  const action = query(req).action;
  if (action === "hls") return hlsHandler(req, res);
  // `/api/download` is rewritten onto this function for the same reason: it is
  // one more route, and the plan allows twelve functions. It keeps its own CORS,
  // its own headers and its own attachment behaviour, so it is dispatched before
  // this route writes anything.
  if (action === "download") return downloadHandler(req, res);

  cors(res, req);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { url, folder, id, batch, subject, attempt, level } = query(req);
  const mode = modeOf(req);

  try {
    let rawUrl = url || "";
    let folderHint = folder || "";
    let detail = null;

    // A retry mid-lecture does not need the schedule.
    //
    // `&folder=` names the video folder the *first* resolution already found, and
    // that folder is what a plan is probed from. Re-reading the schedule on every
    // retry cost two upstream calls with 25-second timeouts apiece, so a student
    // who hit a dead signature ten minutes into a two-hour lecture waited on
    // Physics Wallah's schedule endpoint before the player even started looking
    // for a new signature — for information the page already had. The schedule is
    // still read when there is no folder, which is every first load.
    if (!rawUrl && isFolderId(folderHint)) {
      // `&level=` is the rendition the student was watching when playback broke.
      // A recovery should come back at that quality, not restart them at
      // whichever rung a cold probe would pick.
      const plan = await resolveStream({
        rawUrl: "",
        folder: folderHint,
        fresh: Number(attempt || 0) > 0,
        startLevel: level || "",
      });
      if (plan.playable) {
        return json(res, 200, { success: true, ...plan, resolvedFrom: "", fastPath: "folder" }, planCacheSeconds(plan, attempt));
      }
      // No rendition answered. The schedule may still know something we do not
      // (a re-encoded folder, a lecture that moved), so fall through to it.
    }

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

    // `&attempt=N` (the player sends one on every retry) means "do not hand me
    // the plan you cached" — a cached plan points at the signer host that was
    // reachable a few minutes ago, which is exactly the one that just failed.
    const plan = await resolveStream({
      rawUrl,
      folder: folderHint || parseFolder(rawUrl),
      fresh: Number(attempt || 0) > 0,
      startLevel: level || "",
    });

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
        resolvedFrom: rawUrl,
        ...(detail ? { lecture: detail } : {}),
      },
      planCacheSeconds(plan, attempt)
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
