import crypto from "node:crypto";
import { cors, json, query } from "../lib/http.mjs";
import { resolveStream, parseFolder } from "../lib/api-data.mjs";
import { upstreamJson } from "../lib/upstream.mjs";
import { explainNoVideo } from "../lib/playback.mjs";

/**
 * GET /api/check?batch=&subject=&id=          → verify one lecture plays, end to end
 * GET /api/check?url=<video url>              → verify a known stream URL
 * GET /api/check?batch=&subject=&chapter=     → verify a whole chapter, lecture by lecture
 *
 * Playback can fail at four distinct points, and a generic "video didn't play"
 * is useless for diagnosis. This route walks the same path a browser walks and
 * reports exactly where it breaks:
 *
 *   1. plan      – can the lecture be resolved to a stream at all?
 *   2. playlist  – does the signing relay return a valid manifest?
 *   3. key       – is the AES-128 key reachable and 16 bytes?
 *   4. segment   – does a media segment download, decrypt, and look like MPEG-TS?
 *
 * It never throws for a normal failure — the JSON always explains what happened,
 * which is what makes it useful from a phone or a support thread.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Verifying a chapter is bounded — a function has a wall-clock limit. */
const SWEEP_LIMIT = 6;
const SWEEP_CONCURRENCY = 3;

function selfBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function grab(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", Referer: "https://pw.eduvibe.cc.cd/" },
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type") || "", buf };
}

/** Pull just the bits of `Schedule` that decide whether anything can play. */
async function scheduleInfo(batch, subject, id) {
  const res = await upstreamJson(
    `/Schedule?BatchId=${encodeURIComponent(batch)}&SubjectId=${encodeURIComponent(
      subject
    )}&ContentId=${encodeURIComponent(id)}`,
    { timeout: 25000 }
  );
  const d = (res.ok && res.data && res.data.data) || {};
  const vd = d.videoDetails || {};
  return {
    ok: res.ok,
    status: res.status || 0,
    videoUrl: vd.videoUrl || d.url || "",
    drm: Boolean(vd.drmProtected || d.isDrmEnabled),
    title: vd.name || d.topic || "",
    lectureType: d.lectureType || "",
    videoStatus: vd.status || d.status || "",
    isVideoLecture: d.isVideoLecture !== false,
    hasNotes: Array.isArray(d.homeworkIds) && d.homeworkIds.length > 0,
  };
}

/**
 * Walk the whole playback path for one lecture.
 * @returns {Promise<object>} always a report — never a thrown error
 */
async function checkLecture({ batch, subject, id, url, base }) {
  const report = { success: true, checkedAt: new Date().toISOString(), steps: {} };

  try {
    /* 1 ── resolve a stream plan ------------------------------------------ */
    let rawUrl = url || "";
    if (!rawUrl) {
      const sched = await scheduleInfo(batch, subject, id);
      report.id = id;
      report.title = sched.title;
      report.steps.schedule = sched;
      rawUrl = sched.videoUrl;
      report.drm = sched.drm;
      if (!rawUrl) {
        report.ok = false;
        report.result = "no_video_url";
        report.explain = explainNoVideo({
          lectureType: sched.lectureType,
          status: sched.videoStatus,
          isVideoLecture: sched.isVideoLecture,
          hasNotes: sched.hasNotes,
        });
        return report;
      }
    }

    const folder = parseFolder(rawUrl);
    report.folder = folder;

    const plan = await resolveStream({ rawUrl, folder });
    report.steps.plan = plan;
    if (!plan.playable || !plan.url) {
      report.ok = false;
      report.result = "no_playable_plan";
      report.explain = plan.reason || "The resolver could not build a playable plan.";
      return report;
    }

    // An embedded lecture has no manifest and no AES key to verify: the only
    // meaningful check is that the host answers for that video id.
    if (plan.engine === "embed") {
      report.result = "embed";
      report.ok = true;
      report.explain =
        "This lecture is hosted on " +
        (plan.kind === "vimeo" ? "Vimeo" : "YouTube") +
        " and plays in an embed — no PW key or segment check applies.";
      report.steps.embed = { url: plan.embed, videoId: plan.videoId };
      return report;
    }

    /* 2 ── playlist -------------------------------------------------------- */
    const playlistUrl = plan.url.startsWith("http") ? plan.url : base + plan.url;
    const pl = await grab(playlistUrl);
    const plText = pl.buf.toString("utf8");
    report.steps.playlist = {
      url: playlistUrl,
      status: pl.status,
      contentType: pl.type,
      bytes: pl.buf.length,
      looksLikeM3U8: plText.includes("#EXTM3U"),
    };
    if (!plText.includes("#EXTM3U")) {
      report.ok = false;
      report.result = "playlist_failed";
      report.explain =
        "The signing relay did not return a media playlist. PW only signs lectures whose video has finished processing.";
      report.steps.playlist.bodyStart = plText.slice(0, 300);
      return report;
    }

    // if this is a master playlist, follow the first variant
    let mediaText = plText;
    let mediaUrl = playlistUrl;
    if (/#EXT-X-STREAM-INF/i.test(plText)) {
      const variant = plText
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      if (variant) {
        mediaUrl = variant.startsWith("http") ? variant : new URL(variant, playlistUrl).toString();
        const v = await grab(mediaUrl);
        mediaText = v.buf.toString("utf8");
        report.steps.variant = { url: mediaUrl, status: v.status, bytes: v.buf.length };
      }
    }

    const lines = mediaText.split("\n").map((l) => l.trim());
    const segments = lines.filter((l) => l && !l.startsWith("#"));
    const keyLine = lines.find((l) => l.startsWith("#EXT-X-KEY"));
    const keyUri = keyLine && (keyLine.match(/URI="([^"]+)"/) || [])[1];
    report.steps.media = {
      url: mediaUrl,
      segments: segments.length,
      encrypted: Boolean(keyUri),
      firstSegment: (segments[0] || "").slice(0, 120),
    };

    /* 3 ── AES key -------------------------------------------------------- */
    let key = null;
    if (keyUri) {
      const kUrl = keyUri.startsWith("http") ? keyUri : new URL(keyUri, mediaUrl).toString();
      const k = await grab(kUrl);
      report.steps.key = { url: kUrl, status: k.status, bytes: k.buf.length };
      if (k.status === 200 && k.buf.length === 16) key = k.buf;
      else {
        report.ok = false;
        report.result = "key_failed";
        report.explain = "The AES key for this lecture could not be fetched; playback would stall.";
        return report;
      }
    }

    if (!segments.length) {
      report.ok = false;
      report.result = "no_segments";
      report.explain = "The playlist lists no media segments.";
      return report;
    }

    /* 4 ── a real segment -------------------------------------------------- */
    const segUrl = segments[0].startsWith("http")
      ? segments[0]
      : new URL(segments[0], mediaUrl).toString();
    const seg = await grab(segUrl);
    report.steps.segment = { url: segUrl, status: seg.status, bytes: seg.buf.length };

    if (seg.status !== 200 || seg.buf.length < 1000) {
      report.ok = false;
      report.result = "segment_failed";
      report.explain = "The first media segment did not download.";
      report.steps.segment.bodyStart = seg.buf.slice(0, 200).toString("utf8");
      return report;
    }

    let data = seg.buf;
    if (key) {
      try {
        const d = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16));
        data = Buffer.concat([d.update(seg.buf), d.final()]);
        report.steps.decrypt = { ok: true };
      } catch (err) {
        report.steps.decrypt = { ok: false, error: err.message };
      }
    }

    // MPEG-TS packets begin with the 0x47 sync byte
    const tsSync = data[0] === 0x47;
    report.steps.mediaCheck = { mpegTs: tsSync, headHex: data.slice(0, 8).toString("hex") };

    if (!tsSync) {
      report.ok = false;
      report.result = "decrypt_mismatch";
      report.explain =
        "The segment downloaded but does not decrypt to MPEG-TS — the key does not match this video.";
      return report;
    }

    report.ok = true;
    report.result = "plays";
    report.explain = "Manifest, AES key and media segments all resolve. This lecture plays.";
    return report;
  } catch (err) {
    return {
      success: false,
      ok: false,
      result: "error",
      error: err?.message || "Check failed",
      id,
      steps: report.steps,
    };
  }
}

/** Lecture ids of a chapter, newest first, plus their titles. */
async function chapterLectures(batch, subject, chapter) {
  const res = await upstreamJson(
    `/TopicInfo?BatchId=${encodeURIComponent(batch)}&SubjectId=${encodeURIComponent(
      subject
    )}&TopicId=${encodeURIComponent(chapter)}&ContentType=videos&page=1`
  );
  const body = (res.ok && res.data) || {};
  const list = body.data || body.items || [];
  return list
    .map((item) => ({
      id: item._id,
      title: (item.topic || (item.videoDetails && item.videoDetails.name) || "").trim(),
      status: (item.videoDetails && item.videoDetails.status) || item.status || "",
    }))
    .filter((l) => l.id);
}

/**
 * Check up to `SWEEP_LIMIT` lectures of a chapter, `SWEEP_CONCURRENCY` at a
 * time. A full sweep of 13 lectures would exceed the function timeout, so the
 * caller is told what was covered.
 */
async function sweepChapter({ batch, subject, chapter, base, limit }) {
  const lectures = await chapterLectures(batch, subject, chapter);
  const take = lectures.slice(0, limit);
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < take.length) {
      const item = take[cursor++];
      const r = await checkLecture({ batch, subject, id: item.id, base });
      results.push({
        id: item.id,
        title: item.title || r.title || "",
        result: r.result,
        ok: Boolean(r.ok),
        quality: (r.steps.plan && r.steps.plan.quality) || "",
        explain: r.explain || r.error || "",
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, take.length) }, worker));

  // keep catalogue order so the answer reads like the chapter list
  const order = new Map(take.map((l, i) => [l.id, i]));
  results.sort((a, b) => order.get(a.id) - order.get(b.id));

  const playing = results.filter((r) => r.result === "plays").length;
  return {
    success: true,
    scope: "chapter",
    chapter,
    checkedAt: new Date().toISOString(),
    verified: results.length,
    totalLectures: lectures.length,
    playing,
    notPlaying: results.length - playing,
    note:
      lectures.length > take.length
        ? `Checked the first ${take.length} of ${lectures.length} lectures to stay within the request limit. Re-run with &limit= and one &id= to check others.`
        : "All lectures in this chapter were checked.",
    lectures: results,
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return json(res, 405, { success: false, error: "GET only" });

  const { batch, subject, id, url, chapter, limit } = query(req);
  const base = selfBase(req);

  if (chapter) {
    if (!batch || !subject) {
      return json(res, 400, { success: false, error: "chapter needs batch + subject" });
    }
    const asked = Number.parseInt(limit, 10);
    const capped = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 12) : SWEEP_LIMIT;
    return json(res, 200, await sweepChapter({ batch, subject, chapter, base, limit: capped }));
  }

  if (!url && (!batch || !subject || !id)) {
    return json(res, 400, {
      success: false,
      error: "Provide url, or batch + subject + id, or batch + subject + chapter",
    });
  }

  return json(res, 200, await checkLecture({ batch, subject, id, url, base }));
}
