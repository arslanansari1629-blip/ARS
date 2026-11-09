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

/**
 * Read a playlist the way the signer intends it to be read.
 *
 * The playlist is signed by the same upstream the player uses, so the obvious
 * implementation *is* to call our own `/api/sign` and read the rewritten text.
 * That is how this shipped at first, and it 500-ed on the first real download:
 * a serverless function calling its own deployment origin cannot be relied on
 * to get a connection back. The signer is reachable directly, so read the bytes
 * from there and keep the public origin — the one the browser can reach — as
 * the base every relative URL in the playlist resolves against.
 */
/**
 * Fetch one signed asset from the upstream signer.
 *
 * The playlist carries absolute URLs pointing back at this deployment, and
 * fetching those from inside the function means calling the deployment's own
 * origin — which a serverless invocation is not guaranteed to be able to reach
 * (that is what made this route 500 in production while every local test
 * passed). Every URL in a signed playlist names its asset key, so the bytes can
 * be asked for from the signer directly instead.
 */
function assetKey(url, rendition) {
  const raw = String(url || "");
  // A relay URL already states the key it wants; anything else carries it in
  // the path (an absolute pw.live asset) or in the file name (a relative one).
  const key = keyOf(raw);
  if (!key) return "";
  return key.includes("/") ? key : `${rendition}/${key}`;
}

/** One attempt at a signed asset. A segment fetch is retried once upstream. */
async function fetchAsset(folder, key) {
  const first = await fetchSigned(folder, key);
  if (first.ok) return first;
  return fetchSigned(folder, key);
}

function assetReader(folder, rendition) {
  return async (url) => {
    const key = assetKey(url, rendition);
    if (!key) return new Response("{}", { status: 400 });
    const remote = await fetchAsset(folder, key);
    if (!remote.ok || !remote.response) {
      return new Response("{}", { status: remote.status || 502 });
    }
    return remote.response;
  };
}

async function readPlaylist(playlistUrl, folder, quality) {
  const remote = await fetchSigned(folder, `${quality}/main.m3u8`);
  if (!remote.ok || !remote.response || !remote.response.ok) {
    return { ok: false, status: remote.status || 502, text: "" };
  }
  return { ok: true, status: 200, text: await remote.response.text() };
}
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

  const params = query(req);
  const { folder, url, asset, quality, mode, offset, limit, name, renditions, format } = params;
  // Behind Vercel the request arrives over https, but a local dev server speaks
  // http — hardcoding https here made every signed fetch fail off-production.
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const base = `${proto}://${host}`;
  const folderId = folder || parseFolder(url || "");
  const title = safeName(name, "lecture");

  try {
    /* ------------------------------------------------- one known file ---- */
    // A segment, the key, a rendition playlist: whatever the page already knows
    // how to name. This is the call the player makes, plus a filename.
    if (asset) {
      if (!folderId) return json(res, 400, { success: false, error: "folder is required" });
      // An asset that already names a rendition path (`720/000.ts`) is used as
      // given: reducing it to a bare leaf asks the signer for the wrong file.
      const key = assetKey(asset, String(quality || "720"));
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
      const probe = await readPlaylist(playlistUrl, folderId, pick);
      const text = probe.text || "";
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
        // The segment list is only reported when it is asked for: a 55-minute
        // lecture is 554 entries, and the page needs the count, not the roster.
        ...(query(req).files
          ? {
              files: parsed.segments.map((s, i) => ({
                index: i,
                // Reported the way the page requests it back: `720/000.ts` can be
                // handed to `asset=`, while a bare `000.ts` cannot.
                key: assetKey(s.url, pick),
                seconds: Number((s.duration || 0).toFixed(3)),
              })),
            }
          : {}),
      });
    }

    /* ----------------------------------------------- a whole slice ------- */
    if (mode === "file" || mode === "playlist") {
      const perSlice = Math.max(1, Math.min(Number(limit || DEFAULT_LIMIT), 200));
      const shape = format === "plain" || format === "ts" ? "plain" : "playlist";
      const built = await assembleSlice({
        playlistUrl,
        // The slice reads the playlist through the same door as `mode=list`:
        // calling our own origin from inside the function is what made this
        // route answer 500 in production while working in every local test.
        readPlaylist: () => readPlaylist(playlistUrl, folderId, pick),
        get: assetReader(folderId, pick),
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

      // `probe=1` answers with the shape of the assembled slice instead of the
      // slice itself: the only way to inspect a binary body from outside.
      if (params.probe) {
        const magic = Buffer.from(built.body || []).subarray(0, 4);
        return json(res, 200, {
          success: true,
          playable: true,
          format: built.format,
          bytes: built.bytes,
          mediaBytes: built.mediaBytes || 0,
          start: built.start,
          next: built.next,
          total: built.total,
          segments: built.segments,
          done: built.done,
          magic: magic.toString("hex"),
          // 0x47 is the MPEG-TS sync byte: the file starts with a packet header.
          looksLikeTs: magic[0] === 0x47,
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
