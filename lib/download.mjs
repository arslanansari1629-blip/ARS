/**
 * Offline-download assembly.
 *
 * A signed lecture URL dies within minutes, so a `.m3u8` saved from the player is
 * worthless by the next morning: every line in it points at this site. For a
 * lecture to keep playing offline the key and the media have to travel *inside*
 * the file, which is what `assembleSlice` does — it rewrites a rendition
 * playlist so the AES key and every segment are `data:` URIs.
 *
 * Three properties matter and are easy to lose:
 *
 *   1. **The key comes first.** A file with segments but no key is unplayable and
 *      looks corrupt; failing loudly is better than shipping that.
 *   2. **A slice is complete.** A two-hour lecture cannot be assembled in one
 *      request, so it is cut into slices at segment boundaries. Each slice has
 *      its own key block and `#EXT-X-ENDLIST`, so every part plays on its own.
 *   3. **Nothing here trusts the playlist.** Relative URIs, absolute relay URIs
 *      and `URI="…"` attributes all appear in the wild, so every child is resolved
 *      against the playlist's own URL before it is fetched.
 */

import crypto from "node:crypto";

/** One response may carry this much media; far below the function's ceiling. */
export const MAX_BYTES = 60 * 1024 * 1024;
/** Segments per slice by default — about ten minutes at the usual six seconds. */
export const DEFAULT_LIMIT = 48;

/** Longest segment the writer expects; only used to pick a TARGETDURATION. */
const TARGET_DURATION = 12;

const QUALITY_NAME = {
  1080: "1080p",
  720: "720p",
  480: "480p",
  360: "360p",
  240: "240p",
};

/** A filename every browser and every filesystem will accept. */
export function safeName(input, fallback = "lecture") {
  const clean = String(input || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return clean || fallback;
}

/** `240` → `240p`; anything unexpected passes through unchanged. */
export function qualityLabel(quality) {
  return QUALITY_NAME[Number(quality)] || `${quality}p`;
}

/** Absolute URL for something a playlist names, given where the playlist lives. */
export function absolute(ref, base) {
  const raw = String(ref || "").trim();
  if (!raw || /^data:/i.test(raw)) return "";
  try {
    return new URL(raw, base).toString();
  } catch {
    return "";
  }
}

/** The `key` query parameter of a relay URL, which is what the signer wants. */
export function keyOf(url) {
  const raw = String(url || "");
  // A relative entry in a media playlist (`000.ts`) is not a URL, and `new URL`
  // throws on it — but it still names an asset, so read the leaf instead of
  // reporting none. This is what a playlist needs to be re-fetchable through the
  // signer by key alone.
  try {
    const fromQuery = new URL(raw, "https://playlist.invalid").searchParams.get("key");
    if (fromQuery) return fromQuery;
  } catch {
    /* fall through to the path */
  }
  const path = raw.split("?")[0].replace(/^https?:\/\/[^/]+/i, "");
  const leaf = path.split("/").filter(Boolean).pop() || "";
  return /\.[a-z0-9]{2,5}$/i.test(leaf) ? leaf : "";
}

/** The quality ladder a plan advertises, best first. */
export function renditionsOf(plan) {
  const list = Array.isArray(plan && plan.renditions) ? plan.renditions : [];
  return list
    .map((q) => String(q))
    .filter((q) => /^\d+$/.test(q))
    .sort((a, b) => Number(b) - Number(a));
}

/**
 * Pull a playlist apart into the pieces a downloader cares about.
 *
 * Tolerant on purpose: our relay emits absolute `/api/sign?key=…` children while
 * a raw signer emits siblings of the playlist, and both are handled by resolving
 * every child against `base`.
 */
export function parsePlaylist(text, base) {
  const segments = [];
  const keys = [];
  const maps = [];
  let duration = 0;
  let pending = 0;

  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      if (/^#EXTINF:/i.test(line)) {
        pending = Number((line.match(/^#EXTINF:\s*([\d.]+)/i) || [])[1]) || 0;
      } else if (/^#EXT-X-KEY:/i.test(line)) {
        const method = (line.match(/METHOD=([^,]+)/i) || [])[1] || "";
        const uri = (line.match(/URI="([^"]+)"/i) || [])[1] || "";
        const iv = (line.match(/IV=0x([0-9a-f]+)/i) || [])[1] || "";
        if (/^AES-128$/i.test(method) && uri) keys.push({ uri: absolute(uri, base), iv });
      } else if (/^#EXT-X-MAP:/i.test(line)) {
        const uri = (line.match(/URI="([^"]+)"/i) || [])[1] || "";
        if (uri) maps.push(absolute(uri, base));
      }
      continue;
    }

    duration += pending;
    segments.push({ url: absolute(line, base), duration: pending });
    pending = 0;
  }

  return { segments, keys, maps, duration };
}

/**
 * Decrypt one AES-128 fragment in place, the way the CDN encrypted it.
 *
 * The IV is the media sequence number as a 128-bit big-endian counter when the
 * playlist does not name one, which is what these streams do. Getting this wrong
 * produces a file that is the right size and plays as noise, so a caller that
 * asks for plain text is told exactly which segment failed rather than being
 * handed a corrupt file.
 */
export function decryptFragment(ciphertext, key, sequence, explicitIv = "") {
  const iv = explicitIv
    ? Buffer.from(explicitIv.replace(/^0x/i, "").padStart(32, "0").slice(-32), "hex")
    : (() => {
        const buf = Buffer.alloc(16);
        buf.writeUInt32BE(Math.max(0, Math.floor(sequence)) >>> 0, 12);
        return buf;
      })();
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Whatever `assembleSlice` needs from a URL: status, bytes, and text. */
async function readAll(get, url) {
  const res = await get(url);
  if (!res || !res.ok) {
    return { ok: false, status: (res && res.status) || 0, bytes: Buffer.alloc(0), text: "" };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status || 200, bytes, text: bytes.toString("utf8") };
}

/**
 * Assemble one slice of a lecture into a self-contained playlist.
 *
 * @param {object} opts
 * @param {string} opts.playlistUrl  the signed rendition playlist to slice
 * @param {number} [opts.offset]     first segment index
 * @param {number} [opts.limit]      how many segments this slice may carry
 * @param {Function} [opts.get]      `url → Response`; injectable for tests
 * @param {number} [opts.maxBytes]   byte ceiling for this slice
 * @param {object} [opts.meta]       copied onto the result (`folder`, `quality`…)
 * @param {string} [opts.format]      `playlist` (self-contained .m3u8) or
 *                                    `plain` (decrypted MPEG-TS, plays anywhere)
 * @returns {Promise<object>} never throws on an ordinary failure
 */
export async function assembleSlice({
  playlistUrl,
  offset = 0,
  limit = DEFAULT_LIMIT,
  get = fetch,
  maxBytes = MAX_BYTES,
  meta = {},
  format = "playlist",
  readPlaylist = null,
} = {}) {
  if (!playlistUrl) return { ok: false, error: "no playlist to read" };

  const playlist = readPlaylist
    ? await readPlaylist()
    : await readAll(get, playlistUrl);
  if (!playlist.ok) {
    return { ok: false, status: playlist.status, error: `rendition answered ${playlist.status}` };
  }
  if (!/#EXTINF|#EXT-X-MAP/i.test(playlist.text)) {
    return { ok: false, status: playlist.status, error: "that rendition is not a media playlist" };
  }

  const parsed = parsePlaylist(playlist.text, playlistUrl);
  const total = parsed.segments.length;
  if (!total) return { ok: false, error: "the playlist listed no segments" };

  const start = Math.max(0, Math.min(Math.floor(offset) || 0, total - 1));
  const wanted = parsed.segments.slice(start, start + Math.max(1, Math.floor(limit) || 1));

  // The key first. A slice without it decrypts to noise, so an unreachable key
  // is an error, not a partial file that looks fine until it is played.
  let keyLine = "";
  if (parsed.keys.length) {
    const key = parsed.keys[0];
    const keyFile = await readAll(get, key.uri);
    if (!keyFile.ok) return { ok: false, status: keyFile.status, error: `key answered ${keyFile.status}` };
    if (keyFile.bytes.length !== 16) {
      return { ok: false, error: `key was ${keyFile.bytes.length} bytes, not 16` };
    }
    const iv = key.iv ? `,IV=0x${String(key.iv).replace(/^0x/i, "")}` : "";
    keyLine = `#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,${keyFile.bytes.toString(
      "base64"
    )}"${iv}`;
  }

  const extra = [];
  let bytes = parsed.keys.length ? 16 : 0;

  for (const mapUrl of parsed.maps) {
    const init = await readAll(get, mapUrl);
    if (!init.ok) continue;
    bytes += init.bytes.length;
    extra.push(`#EXT-X-MAP:URI="data:video/mp4;base64,${init.bytes.toString("base64")}"`);
  }

  const plain = format === "plain";
  const carried = [];
  let segmentKey = null;
  if (plain && parsed.keys.length) {
    const keyFile = await readAll(get, parsed.keys[0].uri);
    if (!keyFile.ok || keyFile.bytes.length !== 16) {
      return { ok: false, error: "the key could not be read for a decrypted download" };
    }
    segmentKey = keyFile.bytes;
  }

  for (let i = 0; i < wanted.length; i += 1) {
    const seg = wanted[i];
    if (!seg.url) continue;
    if (bytes >= maxBytes) break;
    const media = await readAll(get, seg.url);
    if (!media.ok) {
      return { ok: false, status: media.status, error: `segment answered ${media.status}`, total };
    }
    let body = media.bytes;
    if (plain && segmentKey) {
      // A decrypted download is only worth having if it is *actually* decrypted:
      // a segment that will not come apart is an error, not a corrupt file.
      try {
        body = decryptFragment(body, segmentKey, start + i, (parsed.keys[0] || {}).iv || "");
      } catch {
        return { ok: false, error: `segment ${start + i} would not decrypt`, total };
      }
    }
    if (bytes + body.length > maxBytes && carried.length) break;
    bytes += body.length;
    carried.push({ duration: seg.duration, body });
  }

  if (!carried.length) return { ok: false, error: "no segment could be fetched", total };

  if (plain) {
    const media = Buffer.concat(carried.map((c) => c.body));
    const secondsBefore = parsed.segments.slice(0, start).reduce((n, s) => n + (s.duration || 0), 0);
    const next = start + carried.length;
    return {
      ok: true,
      body: media,
      buffer: media,
      mediaBytes: media.length,
      bytes: media.length,
      start,
      next,
      total,
      segments: carried.length,
      duration: carried.reduce((n, c) => n + (c.duration || 0), 0),
      startSeconds: secondsBefore,
      done: next >= total,
      format: "plain",
      ...meta,
    };
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${TARGET_DURATION}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  if (keyLine) lines.push(keyLine);
  lines.push(...extra);
  for (const seg of carried) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(`data:video/MP2T;base64,${seg.body.toString("base64")}`);
  }
  lines.push("#EXT-X-ENDLIST");

  const body = `${lines.join("\n")}\n`;
  const secondsBefore = parsed.segments.slice(0, start).reduce((n, s) => n + (s.duration || 0), 0);
  const covered = carried.reduce((n, s) => n + (s.duration || 0), 0);
  const next = start + carried.length;

  return {
    ok: true,
    body,
    format: "playlist",
    bytes: Buffer.byteLength(body),
    mediaBytes: bytes,
    start,
    next,
    total,
    segments: carried.length,
    duration: covered,
    startSeconds: secondsBefore,
    done: next >= total,
    ...meta,
  };
}

/** Where a slice's file name says it belongs. */
export function sliceName(title, quality, start, limit, done, format = "playlist") {
  const part = done ? "" : ` part ${Math.floor(start / Math.max(1, limit)) + 1}`;
  // A plain slice is bare MPEG-TS media, so it gets the extension that makes
  // every player treat it as video rather than as a broken playlist.
  return `${safeName(title)} ${qualityLabel(quality)}${part}.${format === "plain" ? "ts" : "m3u8"}`;
}
