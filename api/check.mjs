import crypto from "node:crypto";
import { cors, json, query } from "../lib/http.mjs";
import { resolveStream, parseFolder } from "../lib/api-data.mjs";
import { upstreamJson } from "../lib/upstream.mjs";
import { explainNoVideo } from "../lib/playback.mjs";

/**
 * GET /api/check?batch=&subject=&id=   → verify one lecture plays, end to end
 * GET /api/check?url=<video url>       → verify a known stream URL
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const { batch, subject, id, url } = query(req);
  const report = { success: true, checkedAt: new Date().toISOString(), steps: {} };

  try {
    /* 1 ── resolve a stream plan ------------------------------------------ */
    let rawUrl = url || "";
    if (!rawUrl) {
      if (!batch || !subject || !id) {
        return json(res, 400, {
          success: false,
          error: "Provide url, or batch + subject + id",
        });
      }
      const sched = await scheduleInfo(batch, subject, id);
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
        return json(res, 200, report);
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
      return json(res, 200, report);
    }

    /* 2 ── playlist -------------------------------------------------------- */
    const base = selfBase(req);
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
      return json(res, 200, report);
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
        return json(res, 200, report);
      }
    }

    if (!segments.length) {
      report.ok = false;
      report.result = "no_segments";
      report.explain = "The playlist lists no media segments.";
      return json(res, 200, report);
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
      return json(res, 200, report);
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
      return json(res, 200, report);
    }

    report.ok = true;
    report.result = "plays";
    report.explain = "Manifest, AES key and media segments all resolve. This lecture plays.";
    return json(res, 200, report);
  } catch (err) {
    return json(res, 200, {
      success: false,
      ok: false,
      result: "error",
      error: err?.message || "Check failed",
      steps: report.steps,
    });
  }
}
