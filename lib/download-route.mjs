/**
 * `GET|HEAD /api/download` — hand a lecture to the browser as a saved file.
 *
 * This is the same bytes `/api/sign` already relays to the player, assembled into
 * one response so the browser can keep it. There is no new CDN path and no new
 * host allowlist: a download is the media route with a filename attached, which
 * is why it can ride on an existing serverless function (the Hobby plan's twelve
 * function cap) and why it cannot reach anything the player could not already
 * reach. Seek, decrypt and stream decisions live in `lib/download.mjs`.
 *
 * Three shapes leave here:
 *
 *   asset=<key>   one file, byte for byte — a segment, the key, a rendition
 *   mode=list     the manifest of a lecture, so the page knows what it is asking for
 *   mode=file     a self-contained slice: key and segments inlined as data URIs,
 *                 which plays offline in VLC and in this site's own player
 */

import { cors, json, query } from "./http.mjs";
import { parseFolder, resolveStream } from "./api-data.mjs";
import { fetchSigned } from "./sign.mjs";
import {
  assembleSlice,
  keyOf,
  qualityLabel,
  renditionsOf,
  safeName,
  sliceName,
  parsePlaylist,
  DEFAULT_LIMIT,
} from "./download.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Send one file as an attachment. Streams anything large rather than buffering. */
async function sendFile(res, upstream, filename, type = "") {
  res.statusCode = 200;
  res.setHeader("Content-Type", type || upstream.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "private, max-age=0, no-store");
  res.setHeader("X-Download-Name", encodeURIComponent(filename));
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);

  if (!upstream.body) {
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const { folder, url, asset, quality, mode, offset, limit, name, renditions, format } = query(req);
  const base = `https://${req.headers["x-forwarded-host"] || req.headers.host || "localhost"}`;
  const folderId = folder || parseFolder(url || "");
  const title = safeName(name, "lecture");

  try {
    /* ------------------------------------------------- one known file ---- */
    // A segment, the key, a rendition playlist: whatever the page already knows
    // how to name. This is the call the player makes, plus a filename.
    if (asset) {
      if (!folderId) return json(res, 400, { success: false, error: "folder is required" });
      const key = keyOf(asset) || asset;
      const got = await fetchSigned(folderId, key);
      if (!got.ok || !got.response || !got.response.ok) {
        return json(res, got.status || 502, {
          success: false,
          error: got.error || `the signing service answered ${got.status || "nothing"}`,
        });
      }
      const leaf = key.split("/").pop() || "part";
      const bare = leaf.replace(/\.(ts|m4s|mp4|m3u8|mpd|key)$/i, "");
      const ext = /\.(ts|m4s|mp4|m3u8|mpd|key)$/i.test(leaf) ? leaf.slice(leaf.lastIndexOf(".")) : ".ts";
      const filename = `${title} - ${safeName(bare, "part")}${ext}`;
      const type = /\.m3u8$/i.test(leaf) ? "application/vnd.apple.mpegurl" : "";
      return sendFile(res, got.response, filename, type);
    }

    if (!folderId) {
      return json(res, 400, {
        success: false,
        error: "Provide folder=<video folder>, or url=<lecture stream url>",
      });
    }

    /* ------------------------------------------------------ the plan ----- */
    // The same resolver the player uses. Without a stream URL the resolver can
    // still probe the folder (that is what a plan is), and the page passes the
    // lecture's stream URL whenever it has one.
    const plan = await resolveStream({ rawUrl: url || "", folder: folderId });
    if (plan.engine === "embed" || plan.kind === "youtube" || plan.kind === "vimeo") {
      return json(res, 200, {
        success: true,
        playable: false,
        embed: plan.embed || "",
        error: "This lecture is hosted on YouTube or Vimeo, so it cannot be saved here.",
      });
    }
    if (!plan.playable || !plan.url) {
      return json(res, 200, {
        success: true,
        playable: false,
        error: plan.reason || "This lecture has no downloadable stream right now.",
      });
    }

    const advertised = renditionsOf(plan);
    const available = advertised.length
      ? advertised
      : String(renditions || plan.quality || "720")
          .split(",")
          .map((q) => q.trim())
          .filter((q) => /^\d+$/.test(q));
    const pick = available.includes(String(quality)) ? String(quality) : available[0] || plan.quality || "720";
    const playlistUrl = `${base}/api/sign?videoKey=${encodeURIComponent(folderId)}&key=${encodeURIComponent(
      `${pick}/main.m3u8`
    )}`;

    /* -------------------------------------------------- what is on offer - */
    if (mode === "list" || mode === "info") {
      const probe = await fetch(playlistUrl, {
        headers: { "User-Agent": UA, Accept: "*/*" },
        signal: AbortSignal.timeout(25000),
      });
      const text = probe.ok ? await probe.text() : "";
      const parsed = parsePlaylist(text, playlistUrl);
      const seconds = Math.round(parsed.duration);
      const perSlice = Math.max(1, Math.min(Number(limit || DEFAULT_LIMIT), 200));
      return json(res, 200, {
        success: true,
        playable: probe.ok && parsed.segments.length > 0,
        folder: folderId,
        quality: pick,
        label: qualityLabel(pick),
        renditions: available,
        segments: parsed.segments.length,
        seconds,
        duration: seconds,
        // How much work a lecture is, before anyone starts downloading it.
        slices: Math.max(1, Math.ceil(parsed.segments.length / perSlice)),
        perSlice,
        encrypted: parsed.keys.length > 0,
        key: parsed.keys[0] ? keyOf(parsed.keys[0].uri) : "",
        playlist: playlistUrl,
        files: parsed.segments.map((s, i) => ({
          index: i,
          key: keyOf(s.url),
          seconds: Number((s.duration || 0).toFixed(3)),
        })),
      });
    }

    /* ----------------------------------------------- a whole slice ------- */
    if (mode === "file" || mode === "playlist") {
      const perSlice = Math.max(1, Math.min(Number(limit || DEFAULT_LIMIT), 200));
      const shape = format === "plain" || format === "ts" ? "plain" : "playlist";
      const built = await assembleSlice({
        playlistUrl,
        offset: Math.max(0, Number(offset || 0)),
        limit: perSlice,
        format: shape,
        meta: { folder: folderId, quality: pick },
      });

      if (!built.ok) {
        return json(res, 200, {
          success: false,
          error: built.error || "The lecture could not be assembled",
          total: built.total || 0,
        });
      }

      const filename = sliceName(title, pick, built.start, perSlice, built.done, built.format);
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        built.format === "plain" ? "video/mp2t" : "application/vnd.apple.mpegurl"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "private, max-age=0, no-store");
      res.setHeader("Access-Control-Expose-Headers", "*");
      // The page reads these to keep its own progress honest.
      res.setHeader("X-Download-Name", encodeURIComponent(filename));
      res.setHeader("X-Download-Segments", String(built.segments));
      res.setHeader("X-Download-Next", String(built.next));
      res.setHeader("X-Download-Total", String(built.total));
      res.setHeader("X-Download-Start", String(built.start));
      res.setHeader("X-Download-Start-Seconds", String(Math.round(built.startSeconds)));
      res.setHeader("X-Download-Seconds", String(Math.round(built.duration)));
      res.setHeader("X-Download-Done", built.done ? "1" : "0");
      res.setHeader("X-Download-Bytes", String(built.bytes));
      res.setHeader("X-Download-Quality", pick);
      res.setHeader("X-Download-Format", built.format || "playlist");
      if (built.mediaBytes && built.format === "plain") {
        res.setHeader("X-Download-Media-Bytes", String(built.mediaBytes));
      }
      return res.end(built.body);
    }

    return json(res, 400, {
      success: false,
      error: "Unknown mode. Use mode=list, mode=file, or asset=<key>.",
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err?.message || "The download could not be prepared.",
    });
  }
}
