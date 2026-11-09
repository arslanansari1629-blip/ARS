/* =========================================================================
   Offline saver.

   The hard part of "download a lecture" is not fetching bytes, it is the
   arithmetic of making the result *stay playable*:

     · a signed URL dies in minutes, so the saved file cannot reference one;
     · a two-hour lecture does not fit in one response, so it arrives in slices;
     · a slice is a valid playlist on its own, but three slices are not one file.

   So a download here is: ask the server for a self-contained slice (key and
   segments inlined), pull the media out of it, append it to the parts already
   held, and keep the running result in IndexedDB. The browser's own Blob store
   does the heavy lifting — nothing is held in memory longer than one slice.

   Two things are deliberately *not* clever:
     · the key is kept as the server wrote it, first-seen wins, because a
       mid-lecture key change would silently corrupt everything after it;
     · a slice must be non-empty before it is counted, so a rate-limited signer
       reads as "retrying", never as a finished download that will not play.
   ========================================================================= */

const DB_NAME = "arsvibe.downloads";
const DB_VERSION = 1;
const SAVE_KEY = "lectures";

/* ------------------------------- IndexedDB ------------------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser cannot store downloads offline."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE_KEY)) db.createObjectStore(SAVE_KEY, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open local storage"));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAVE_KEY, mode);
      const store = tx.objectStore(SAVE_KEY);
      let out;
      try {
        out = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(out && out.__value !== undefined ? out.__value : out);
      tx.onerror = () => reject(tx.error || new Error("Storage transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** Every saved lecture, newest first, without their payloads. */
export async function savedLectures() {
  const rows = await withStore("readonly", (store) => {
    const req = store.getAll();
    req.__value = null;
    req.onsuccess = () => {
      req.__value = (req.result || []).map((row) => {
        const { parts, ...meta } = row;
        return { ...meta, bytes: (parts || []).reduce((n, p) => n + (p.size || 0), 0) };
      });
    };
    return req;
  });
  return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function savedLecture(id) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SAVE_KEY, "readonly");
      const req = tx.objectStore(SAVE_KEY).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function removeLecture(id) {
  return withStore("readwrite", (store) => store.delete(id));
}

export async function clearLectures() {
  return withStore("readwrite", (store) => store.clear());
}

/**
 * How much room is left before the browser starts refusing writes.
 * Returns `null` when the browser does not say (Safari), which is not an error.
 */
export async function storageEstimate() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, free: Math.max(0, quota - usage) };
  } catch {
    return null;
  }
}

/** True when this browser can keep downloads between visits. */
export function canStoreOffline() {
  try {
    return typeof indexedDB !== "undefined" && Boolean(indexedDB);
  } catch {
    return false;
  }
}

/**
 * Ask the browser not to evict this origin's storage under pressure.
 * Best effort: a refusal means downloads stay ordinary cached data, not that
 * anything is broken.
 */
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/* ---------------------------- playlist surgery ---------------------------- */

/**
 * Split a self-contained playlist into its key block and its segment lines.
 *
 * The server writes exactly one key and a run of `data:video/MP2T;base64,…`
 * lines, so this is a narrow reader, not a general HLS parser — and it refuses
 * anything that is not already self-contained rather than silently saving a file
 * that points back at this site.
 */
export function readSlice(text) {
  const lines = String(text || "").split("\n");
  const keyLine = lines.find((l) => /^#EXT-X-KEY:/i.test(l) && /URI="data:/i.test(l)) || "";
  const mapLines = lines.filter((l) => /^#EXT-X-MAP:/i.test(l) && /URI="data:/i.test(l));
  const media = [];
  let pending = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      pending = Number((line.match(/^#EXTINF:\s*([\d.]+)/i) || [])[1]) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    const match = line.match(/^data:video\/[^;]*;base64,(.+)$/i);
    if (!match) continue; // a URL: not a self-contained slice, ignore it
    media.push({ duration: pending, data: match[1] });
    pending = 0;
  }

  return { keyLine, mapLines, media };
}

/**
 * A decrypted slice: raw MPEG-TS, not a playlist.
 *
 * The server sends it as `video/mp2t`, so "is this a playlist?" is answered by
 * content, never by the file the person asked for — a `.ts` slice and a `.m3u8`
 * slice both arrive over the same route.
 */
export function isPlaylistText(text) {
  return String(text || "").trimStart().startsWith("#EXTM3U");
}

/** base64 → bytes, without a megabyte-sized string in the middle. */
export function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Turn a stored lecture's parts into one playable file.
 *
 * The parts are consecutive `.ts` fragments (AES-128 encrypted, exactly as they
 * came off the CDN) with one key. Concatenating them and keeping the key in an
 * `#EXT-X-KEY` header is what makes the result a single file — and the same
 * bytes play in VLC, in ffmpeg, and in this site's own player once it is loaded
 * back through `offlineFileUrl`.
 */
export function buildOfflinePlaylist(record) {
  const parts = (record && record.parts) || [];
  const duration = parts.reduce((n, p) => n + (p.seconds || 0), 0);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:12",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  if (record.key) lines.push(record.key);
  if (record.init) lines.push(record.init);
  lines.push(`#EXTINF:${duration.toFixed(3)},`);
  lines.push(parts.map((p) => p.data).join(""));
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/**
 * A `blob:` URL a `<video>` element can play, built from the saved parts.
 *
 * hls.js needs a *playlist* it can fetch, so the blob is a playlist whose one
 * segment is everything the download collected, and the key travels inside it.
 * `kind: "media"` is for browsers that will take the raw media directly.
 */
export function offlineFileUrl(record, { kind = "" } = {}) {
  const shape = kind || (record && record.format === "plain" ? "media" : "playlist");
  if (shape === "media") {
    const blob = new Blob((record.parts || []).map((p) => new Uint8Array(base64ToBytes(p.data))), {
      type: "video/mp2t",
    });
    return { url: URL.createObjectURL(blob), revoke: () => URL.revokeObjectURL(url) };
  }
  const text = buildOfflinePlaylist(record);
  const blob = new Blob([text], { type: "application/vnd.apple.mpegurl" });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/** MPEG-TS packets start with 0x47 and arrive in 188-byte steps. */
export function looksLikeTransportStream(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (data.length < 188 * 2) return false;
  return data[0] === 0x47 && data[188] === 0x47;
}

/** A real file on disk, for "save to device" inside a native browser download. */
export function offlineFile(record) {
  const plainFormat = record && record.format === "plain";
  const parts = (record && record.parts) || [];
  const type = plainFormat ? "video/mp2t" : "application/vnd.apple.mpegurl";
  const content = plainFormat
    ? parts.map((p) => new Uint8Array(base64ToBytes(p.data)))
    : [buildOfflinePlaylist(record)];
  const blob = new Blob(content, { type });
  const title = (record && record.title) || "lecture";
  const label = (record && record.label) || "";
  return {
    blob,
    name: `${title} ${label}.${plainFormat ? "ts" : "m3u8"}`.replace(/\s+/g, " ").trim(),
  };
}

/* ------------------------------- downloading ------------------------------ */

/**
 * Download one lecture, slice by slice, into local storage.
 *
 * `onProgress` is called after every slice with a shape the page can render
 * directly: how many segments of how many, elapsed media seconds, bytes held so
 * far, and whether the browser is retrying.
 *
 * Failure policy, learned from the player: retry each slice a few times with a
 * widening gap *before* reporting anything, because a rate-limited signer is the
 * normal case and it clears itself. Only a slice that fails past its budget ends
 * the download — and it ends it honestly, leaving what was already saved
 * playable instead of discarding an hour of work.
 *
 * @param {object} opts
 * @param {string} opts.id            lecture id (the storage key)
 * @param {string} opts.folder        PW video folder
 * @param {string} [opts.url]         the lecture's stream URL, when the page has one
 * @param {string} [opts.quality]
 * @param {string} [opts.title]
 * @param {number} [opts.sliceSize]
 * @param {Function} [opts.onProgress]
 * @param {Function} [opts.fetchImpl] injectable for tests
 * @param {AbortSignal} [opts.signal]
 */
export async function downloadLecture({
  id,
  folder,
  url = "",
  quality = "",
  title = "Lecture",
  sliceSize = 48,
  format = "",
  onProgress = () => {},
  fetch: fetcher,
  signal,
} = {}) {
  if (!id || !folder) throw new Error("A lecture id and folder are required");

  const perSlice = Math.max(1, Math.min(Number(sliceSize) || 48, 200));
  const query = new URLSearchParams({ folder, mode: "file", limit: String(perSlice) });
  if (url) query.set("url", url);
  if (quality) query.set("quality", quality);
  // A decrypted download is the default for this page: the saved file then
  // plays in any player, with no key to carry and nothing to go stale.
  if (format) query.set("format", format);
  query.set("name", title);

  const parts = [];
  const seen = new Set();
  let start = 0;
  let total = 0;
  let seconds = 0;
  let keyLine = "";
  let mapLine = "";
  let attempts = 0;
  let plain = format === "plain";
  let label = quality ? `${quality}p` : "";
  let encKey = "";

  const retain = {};
  const record = () => ({
    parts,
    key: keyLine,
    init: mapLine,
  });

  const persist = async (done) => {
    const { parts: saved, key, init } = record();
    const createdAt = retain.createdAt || (retain.createdAt = Date.now());
    await withStore("readwrite", (store) =>
      store.put({
        id,
        createdAt,
        folder,
        url,
        title,
        quality,
        label,
        key,
        init,
        keyUrl: encKey,
        parts: saved,
        seconds,
        total,
        done: Boolean(done),
        encrypted: Boolean(key),
        format: plain ? "plain" : "playlist",
        updatedAt: Date.now(),
      })
    );
  };

  for (;;) {
    if (signal && signal.aborted) throw new Error("Cancelled");
    if (attempts > 4) break;

    const q = new URLSearchParams(query);
    q.set("offset", String(start));

    let res;
    try {
      res = await (fetcher || fetch)(`/api/download?${q.toString()}`, { signal });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      attempts += 1;
      onProgress({ phase: "retry", attempt: attempts, segments: parts.length, total, seconds });
      await sleep(600 * attempts);
      continue;
    }

    if (!res.ok) {
      attempts += 1;
      onProgress({ phase: "retry", attempt: attempts, status: res.status, segments: parts.length, total, seconds });
      await sleep(600 * attempts);
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    if (/json/i.test(contentType)) {
      const body = await res.json().catch(() => ({}));
      // "No stream yet" is not a transient fault; retrying it forever would hide
      // the real answer from the person waiting.
      throw new Error(body.error || "This lecture could not be downloaded.");
    }

    const sliceFormat = res.headers.get("x-download-format") || "playlist";

    // A plain slice is media already: store it as one part and move on. There is
    // no key to carry and no playlist to parse, which is exactly the point of
    // the format — the file works everywhere.
    if (sliceFormat === "plain") {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) {
        attempts += 1;
        onProgress({ phase: "retry", attempt: attempts, segments: parts.length, total, seconds });
        await sleep(600 * attempts);
        continue;
      }
      attempts = 0;
      const chunk = 0x8000;
      let b64 = "";
      for (let i = 0; i < buf.length; i += chunk) {
        b64 += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
      }
      const encoded = btoa(b64);
      parts.push({
        index: start + parts.length,
        data: encoded,
        seconds: Number(res.headers.get("x-download-seconds")) || 0,
        size: buf.length,
      });
      seconds += Number(res.headers.get("x-download-seconds")) || 0;
      total = Number(res.headers.get("x-download-total")) || total;
      label = res.headers.get("x-download-quality") ? `${res.headers.get("x-download-quality")}p` : label;
      const nextPlain = Number(res.headers.get("x-download-next")) || start + 1;
      const donePlain = res.headers.get("x-download-done") === "1" || nextPlain <= start;
      plain = true;
      await persist(donePlain);
      onProgress({
        phase: donePlain ? "done" : "downloading",
        segments: parts.length,
        total,
        seconds,
        bytes: parts.reduce((n, p) => n + p.size, 0),
        done: donePlain,
      });
      if (donePlain) return { ok: true, segments: parts.length, total, seconds, format: "plain" };
      start = nextPlain;
      continue;
    }

    const text = await res.text();
    const slice = readSlice(text);
    if (!slice.media.length) {
      attempts += 1;
      onProgress({ phase: "retry", attempt: attempts, segments: parts.length, total, seconds });
      await sleep(600 * attempts);
      continue;
    }

    attempts = 0;
    if (!keyLine && slice.keyLine) keyLine = slice.keyLine;
    if (!mapLine && slice.mapLines.length) mapLine = slice.mapLines[0];
    if (!encKey) encKey = res.headers.get("x-download-enc-key") || "";

    for (const seg of slice.media) {
      // A slice can repeat a segment the previous one already carried if the
      // offset moved while a retry was in flight; the first copy wins.
      if (seen.has(`${seg.data.length}:${seg.data.slice(0, 32)}`)) continue;
      seen.add(`${seg.data.length}:${seg.data.slice(0, 32)}`);
      parts.push({ index: start + parts.length, data: seg.data, seconds: seg.duration || 0, size: seg.data.length });
      seconds += seg.duration || 0;
    }

    total = Number(res.headers.get("x-download-total")) || total;
    label = res.headers.get("x-download-quality")
      ? `${res.headers.get("x-download-quality")}p`
      : label;
    const next = Number(res.headers.get("x-download-next")) || start + slice.media.length;
    const finished = res.headers.get("x-download-done") === "1" || next <= start;

    await persist(finished);
    onProgress({
      phase: finished ? "done" : "downloading",
      segments: parts.length,
      total,
      seconds,
      bytes: parts.reduce((n, p) => n + p.size, 0),
      done: finished,
    });

    if (finished) return { ok: true, segments: parts.length, total, seconds, format: "playlist" };
    start = next;
  }

  // Ran out of retries with something already saved: keep it and say so. The
  // page offers "continue" on the same lecture rather than starting over.
  const kept = parts.length > 0;
  if (kept) await persist(false);
  onProgress({ phase: kept ? "partial" : "failed", segments: parts.length, total, seconds });
  if (!kept) throw new Error("The download could not start — the stream service is not answering.");
  return { ok: false, partial: true, segments: parts.length, total, seconds };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Human-readable size, for the saved list. */
export function fmtBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** `5025` seconds → `1h 23m`. Short lectures stay in minutes. */
export function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}
