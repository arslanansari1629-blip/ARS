/**
 * The Allen section's upstream client.
 *
 * `/allen` is a second platform on this site, modelled on the Next
 * Allen catalogue at stream.nexthope.sbs/Allen. Their Allen stack
 * (discovered live, November 2026 — the routes below are the real
 * ones their own pages call):
 *
 *   batches   GET /Allen/batches.json                     (static list)
 *   subjects  GET /Allen/api/subjects?batch_id&course_id
 *   topics    GET /Allen/api/topics?batch_id&course_id&subject_id&taxonomy_id
 *   contents  GET /Allen/api/contents?…&topic_id          (lectures)
 *
 * A batch is a `bt_…` id plus a `cr_…` course id under a hyphenated
 * batch code (D6TL-36-DILC21); the visible code is NOT the id, and
 * neither is a PW ObjectId — Nexthope's shared API answers its PW
 * catalogue under /Allen/api/batches too, and those rows must never
 * be dressed up as Allen batches.
 *
 * Each content row carries a `play_url` (`/api/token?token=…`) that
 * resolves, server-side here, to the playable address. `ALLEN_API_BASE`
 * re-points the whole section at another compatible backend, and
 * `view=probe` reports every upstream route's health.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function allenBase() {
  return String(process.env.ALLEN_API_BASE || "https://stream.nexthope.sbs").replace(/\/+$/, "");
}

const cache = new Map(); // key → { at, value }
const CACHE_MS = 5 * 60 * 1000;

async function askJson(path, timeoutMs = 15000) {
  const url = allenBase() + path;
  // One retry on a refusal/rate-limit/5xx with their player's header
  // shape: these catalogue routes blip (a 403 here, a 429 there), and
  // a single blip used to surface as "subjects are not answering"
  // for a batch that answers fine a second later.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers:
          attempt === 0
            ? { "User-Agent": UA, Accept: "application/json, text/plain, */*" }
            : allenPlayerHeaders({ Accept: "application/json, text/plain, */*" }),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON — the caller treats it as unusable */
      }
      const out = { url, status: res.status, ok: res.ok, body };
      if (out.ok || attempt === 1 || ![401, 403, 429].includes(res.status) && res.status < 500) return out;
    } catch (err) {
      if (attempt === 1)
        return { url, status: 0, ok: false, body: null, error: String(err?.message || err).slice(0, 160) };
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return { url, status: 0, ok: false, body: null };
}

function rows(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.batches)) return body.batches;
  return [];
}

export function normalizeAllenBatch(raw = {}) {
  const code = String(raw.batch_name || raw.code || raw.courseCode || "").trim();
  const batchId = String(raw.batch_id || "").trim();
  // Allen codes are hyphenated (D6TL-36-DILC21, SB-49CBSE11) and the
  // drill-down needs the bt_ id. A 24-hex id is a PW Mongo ObjectId:
  // Nexthope's /Allen/api/batches serves its PW catalogue, and those
  // rows must never wear Allen badges (17,302 of them, seen live).
  if (!code || !batchId.startsWith("bt_") || /^[0-9a-f]{24}$/i.test(code)) return null;
  const stream = String(raw.stream || raw.exam || "").trim();
  return {
    code,
    batchId,
    courseId: String(raw.course_id || "").trim(),
    name: String(raw.course_name || raw.name || code).trim(),
    class: String(raw.class || "").trim(),
    exam: /neet|medical/i.test(stream) ? "NEET" : /main/i.test(stream) ? "JEE Main" : stream || "JEE Advanced",
    stream,
    type: String(raw.batch_type || "").trim(),
    timing: String(raw.batch_timing || "").trim(),
    live: String(raw.batch_status || "LIVE").toUpperCase() === "LIVE",
  };
}

export function normalizeAllenSubject(raw = {}) {
  const name = String(raw.name || "Subject").trim();
  const id = String(raw.subject_id || raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    name,
    taxonomyId: String(raw.taxonomy_id || "").trim(),
    tag: String(raw.tag || "").trim(),
    badge: String(raw.badge || "").trim(),
  };
}

export function normalizeAllenTopic(raw = {}) {
  const id = String(raw.topic_id || raw.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || "Chapter").trim(),
    order: Number(raw.order) || 0,
    completed: Boolean(raw.is_completed),
    videos: Number(raw.videos_count) || 0,
    notes: Number(raw.notes_count) || 0,
  };
}

export function normalizeAllenLecture(raw = {}) {
  const id = String(raw.content_id || raw.id || "").trim();
  if (!id) return null;
  const play = String(raw.play_url || "").trim();
  return {
    id,
    title: String(raw.title || "Lecture").trim(),
    duration: String(raw.duration || "").trim(),
    date: String(raw.description || raw.subtitle || "").trim(),
    thumbnail: String(raw.thumbnail || "").trim(),
    subTopics: Array.isArray(raw.sub_topics) ? raw.sub_topics.map(String) : [],
    playUrl: play ? (play.startsWith("http") ? play : allenBase() + play) : "",
  };
}

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  if (value.success) cache.set(key, { at: Date.now(), value });
  return value;
}

const qs = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

async function allenBatches() {
  return cached("batches", async () => {
    const got = await askJson("/Allen/batches.json");
    const items = rows(got.body).map(normalizeAllenBatch).filter(Boolean);
    if (!got.ok || !items.length)
      return { success: false, view: "batches", total: 0, items: [], status: got.status, error: "The Allen catalogue did not answer with usable data." };
    return { success: true, view: "batches", source: got.url, total: items.length, items };
  });
}

async function allenSubjects(batchId, courseId) {
  return cached(`subjects:${batchId}`, async () => {
    const got = await askJson(`/Allen/api/subjects?${qs({ batch_id: batchId, course_id: courseId })}`);
    const items = rows(got.body).map(normalizeAllenSubject).filter(Boolean);
    // "Answered, but empty" is a different fact from "did not answer":
    // a 200 with zero rows means the upstream itself lists nothing for
    // this batch (most catalogue batches are exactly that). Keep the
    // two apart so the UI can say "empty batch" instead of sending the
    // student into a retry loop that can never succeed.
    if (!got.ok)
      return { success: false, view: "subjects", total: 0, items: [], status: got.status, error: "Subjects did not answer upstream for this batch." };
    if (!items.length)
      return { success: false, empty: true, view: "subjects", total: 0, items: [], status: got.status, error: "Upstream lists no subjects for this batch." };
    // The upstream lists each subject twice (enrolled + curriculum);
    // one card per subject id is what a student needs.
    const seen = new Set();
    const unique = items.filter((s) => !seen.has(s.id) && seen.add(s.id));
    return { success: true, view: "subjects", source: got.url, total: unique.length, items: unique };
  });
}

async function allenTopics(batchId, courseId, subjectId, taxonomyId) {
  return cached(`topics:${batchId}:${subjectId}`, async () => {
    const got = await askJson(
      `/Allen/api/topics?${qs({ batch_id: batchId, course_id: courseId, subject_id: subjectId, taxonomy_id: taxonomyId })}`
    );
    const items = rows(got.body).map(normalizeAllenTopic).filter(Boolean).sort((a, b) => a.order - b.order);
    if (!got.ok)
      return { success: false, view: "topics", total: 0, items: [], status: got.status, error: "Chapters did not answer upstream for this subject." };
    if (!items.length)
      return { success: false, empty: true, view: "topics", total: 0, items: [], status: got.status, error: "Upstream lists no chapters for this subject." };
    return { success: true, view: "topics", source: got.url, total: items.length, items };
  });
}

async function allenLectures(batchId, courseId, subjectId, taxonomyId, topicId) {
  // No cache: every row carries a signed play token, and a stale
  // token is a dead player. The catalogue levels above are cached;
  // the token-bearing level is always fresh.
  const got = await askJson(
    `/Allen/api/contents?${qs({ batch_id: batchId, course_id: courseId, subject_id: subjectId, taxonomy_id: taxonomyId, topic_id: topicId })}`
  );
  const items = rows(got.body).map(normalizeAllenLecture).filter(Boolean);
  if (!got.ok)
    return { success: false, view: "lectures", total: 0, items: [], status: got.status, error: "Lectures did not answer upstream for this chapter." };
  if (!items.length)
    return { success: false, empty: true, view: "lectures", total: 0, items: [], status: got.status, error: "Upstream lists no lectures for this chapter." };
  return { success: true, view: "lectures", source: got.url, total: items.length, items };
}

/**
 * Headers their own player sends. The token endpoint sits behind
 * their site; an ask with no Referer/Origin is a bot-shaped ask and
 * can be refused or served a challenge instead of the playlist.
 */
function allenPlayerHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Accept: "*/*",
    Referer: `${allenBase()}/Allen/player.html`,
    Origin: allenBase(),
    ...extra,
  };
}

/** Resolve a content `play_url` to the final playable address. */
export async function allenPlay(playUrl) {
  if (!playUrl || !playUrl.startsWith(allenBase())) {
    return { success: false, url: "", error: "That play address is not from the Allen upstream." };
  }
  try {
    const res = await fetch(playUrl, {
      headers: allenPlayerHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const type = res.headers.get("content-type") || "";
    if (/json/i.test(type)) {
      const body = await res.json().catch(() => null);
      const url = body?.url || body?.streamUrl || body?.data?.url || body?.data?.streamUrl || "";
      if (url) return { success: true, url: String(url) };
      return { success: false, url: "", error: "The Allen play resolver answered without a stream address." };
    }
    // Their player loads the token URL itself as the HLS source: the
    // endpoint answers the playlist AT that URL, often as text/plain.
    // Sniff the body, never trust the content-type — trusting it was
    // why our player reported "no stream" for a working lecture.
    if (!/video|octet-stream/i.test(type)) {
      const text = await res.text().catch(() => "");
      if (text.trimStart().startsWith("#EXTM3U")) return { success: true, url: res.url || playUrl };
      // A player page instead of a playlist: lift the stream URL out.
      const found = text.match(/https?:[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/i);
      if (found) return { success: true, url: found[0] };
    }
    // A redirect chain that ended on a media address:
    // res.url is the final address the player should load.
    if (res.url && res.url !== playUrl) return { success: true, url: res.url };
    if (/mpegurl|video|octet|text\/plain/i.test(type)) return { success: true, url: playUrl };
    return { success: false, url: "", error: "The Allen play resolver did not lead to a stream." };
  } catch (err) {
    return { success: false, url: "", error: String(err?.message || err).slice(0, 160) };
  }
}

/**
 * The Allen proxy: our own edge between the browser and Allen's CDN.
 * Playlists are fetched here, every segment/key URI inside them is
 * rewritten to ride our media relay, and the browser never talks to
 * Allen's hosts directly — same architecture as the PW side, so CORS,
 * hot-link protection and mixed content on their side stop mattering.
 */
const PROXY_HOSTS = /(^|\.)(allen\.in|allenbpms\.in|nexthope\.sbs|cloudfront\.net|akamaihd\.net|akamaized\.net|amazonaws\.com)$/i;

export function allenProxyAllowed(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" && PROXY_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

const absUrl = (ref, base) => {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
};

/**
 * Rewrite an HLS playlist for our player. Key/asset URIs ride the
 * media relay (binary, one hop). Media lines ride THIS proxy again:
 * a master playlist's variants are playlists too, and sending them
 * through the plain media relay hands the browser an unrewritten
 * variant whose relative segments resolve against the relay URL and
 * die — the exact "lecture work nahi kar raha" failure, proven live
 * (master → variant → segments, all on the upstream host). Segments
 * that reach the proxy get a 302 to the media relay there.
 */
export function rewriteAllenPlaylist(text, baseUrl) {
  const wrapMedia = (ref) => `/api/media?url=${encodeURIComponent(absUrl(ref, baseUrl))}`;
  const wrapPlaylist = (ref) => `/api/allen?view=playlist&u=${encodeURIComponent(absUrl(ref, baseUrl))}`;
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // URI= inside a tag is not always a file: EXT-X-MEDIA points
        // at the separate AUDIO/SUBTITLE *playlists*. Sending those
        // through the plain relay (the old behaviour) handed hls.js
        // an unrewritten audio playlist whose segments resolved
        // against the relay URL and died — video chal raha, audio
        // gayab, aur stream wahi atka raha. Playlist-shaped URIs
        // recurse through this proxy; keys and init segments (real
        // binary) keep the one-hop relay.
        const isPlaylistTag = /^#EXT-X-MEDIA:/i.test(t) || /^#EXT-X-I-FRAME-STREAM-INF/i.test(t);
        return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${isPlaylistTag ? wrapPlaylist(ref) : wrapMedia(ref)}"`);
      }
      return wrapPlaylist(t);
    })
    .join("\n");
}

const playlistCache = new Map(); // url → { at, body }
const PLAYLIST_CACHE_MS = 20000;

/**
 * One upstream playlist ask, with the two header shapes their edge
 * accepts. Their player sends Referer+Origin; some CDN edges want
 * the bare browser ask instead. A refusal on the first shape is
 * retried once on the second before anyone gives up.
 */
async function fetchAllenUpstream(raw, range) {
  const shapes = [
    allenPlayerHeaders(range ? { Range: range } : {}),
    {
      "User-Agent": UA,
      Accept: "*/*",
      Referer: `${allenBase()}/`,
      ...(range ? { Range: range } : {}),
    },
  ];
  let last = null;
  for (const headers of shapes) {
    try {
      const res = await fetch(raw, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      last = res;
      if (res.ok || res.status === 206) return res;
      if (![401, 403, 429].includes(res.status)) return res;
    } catch (err) {
      last = { ok: false, status: 0, error: err };
    }
  }
  return last;
}

async function allenPlaylist(req, res, raw) {
  if (!allenProxyAllowed(raw)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "That host is not part of the Allen platform." }));
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    // Playlists are tiny and every student asks for the same ones:
    // a 20-second in-isolate memo turns a master+variant chain from
    // four upstream asks into one, without ever caching a segment.
    const hit = playlistCache.get(raw);
    if (hit && Date.now() - hit.at < PLAYLIST_CACHE_MS) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=15");
      res.setHeader("X-Allen-Proxy", "playlist-cache");
      return res.end(hit.body);
    }
    const upstream = await fetchAllenUpstream(raw, req.headers?.range);
    if (!upstream || upstream.status === 0 || !upstream.headers) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: "The Allen stream host did not answer." }));
    }
    const type = upstream.headers.get("content-type") || "";
    // Sniff the body: Allen's token endpoint serves its playlist as
    // text/plain at a URL with no .m3u8 in it, so content-type and
    // file extension both lie. #EXTM3U never does.
    if (!/video|octet-stream/i.test(type) || /mpegurl/i.test(type)) {
      const text = await upstream.text().catch(() => "");
      if (text.trimStart().startsWith("#EXTM3U") || /mpegurl/i.test(type)) {
        const body = rewriteAllenPlaylist(text, upstream.url || raw);
        playlistCache.set(raw, { at: Date.now(), body });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=15");
        res.setHeader("X-Allen-Proxy", "playlist");
        return res.end(body);
      }
    }
    // Not a playlist (an mp4, a segment): hand the browser our media
    // relay instead of proxying bytes through the API function.
    res.statusCode = 302;
    res.setHeader("Location", `/api/media?url=${encodeURIComponent(upstream.url || raw)}`);
    res.setHeader("X-Allen-Proxy", "segment-redirect");
    return res.end();
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: String(err?.message || err).slice(0, 160) }));
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};
const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname.slice(-40);
  } catch {
    return "";
  }
};

/**
 * End-to-end playback diagnosis for one chapter: fetch its first
 * lecture's token the way their player does, sniff the answer, then
 * touch the first segment. Hosts and statuses only — never a token.
 * This exists because "lecture work nahi kar raha" is four different
 * failures wearing one sentence, and each has a different fix.
 */
export async function allenPlayProbe(params) {
  const diag = { steps: {} };
  const lectures = await allenLectures(params.batchId, params.courseId, params.subjectId, params.taxonomyId, params.topicId);
  diag.steps.lectures = { ok: lectures.success, count: lectures.items?.length || 0 };
  const first = lectures.items?.[0];
  if (!first?.playUrl) {
    diag.steps.play = { ok: false, error: "first lecture carries no play_url" };
    return { success: false, diag };
  }
  diag.lecture = { title: first.title, duration: first.duration };
  try {
    const res = await fetch(first.playUrl, {
      headers: allenPlayerHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const type = res.headers.get("content-type") || "";
    const text = /video|octet-stream/i.test(type) ? "" : await res.text().catch(() => "");
    const isPlaylist = text.trimStart().startsWith("#EXTM3U");
    diag.steps.play = {
      ok: res.ok,
      status: res.status,
      contentType: type,
      finalHost: hostOf(res.url || ""),
      finalPathTail: pathOf(res.url || ""),
      sniffedPlaylist: isPlaylist,
      bodyHead: isPlaylist ? "" : text.slice(0, 120),
    };
    if (isPlaylist) {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const media = lines.filter((l) => !l.startsWith("#"));
      const keyLine = lines.find((l) => l.includes('URI="'));
      diag.steps.playlist = {
        lines: lines.length,
        mediaLines: media.length,
        hasKeyUri: Boolean(keyLine),
        firstMediaHost: media[0] ? hostOf(absUrl(media[0], res.url)) : "",
      };
      // Verify OUR rewrite, not just their playlist: every media
      // line must come back as a proxy URL whose target is an
      // allowlisted Allen host — a rewrite bug here is invisible
      // upstream and fatal in the browser.
      const rewritten = rewriteAllenPlaylist(text, res.url);
      const rMedia = rewritten.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const firstProxy = rMedia[0] || "";
      let proxyTargetOk = false;
      try {
        const u = new URL(firstProxy, "https://local.invalid");
        proxyTargetOk =
          u.pathname === "/api/allen" &&
          u.searchParams.get("view") === "playlist" &&
          allenProxyAllowed(u.searchParams.get("u") || "");
      } catch {
        proxyTargetOk = false;
      }
      diag.steps.rewrite = { mediaLines: rMedia.length, firstIsProxy: firstProxy.startsWith("/api/allen?view=playlist"), proxyTargetOk };
      // Audio lives in its own playlist (EXT-X-MEDIA TYPE=AUDIO).
      // "Video hai, awaaz nahi" is that playlist dying, so probe it
      // explicitly: present? reachable? and does OUR rewrite route
      // it through the playlist proxy rather than the plain relay?
      const audioLine = lines.find((l) => /^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(l));
      const audioUri = audioLine?.match(/URI="([^"]+)"/)?.[1] || "";
      if (audioUri) {
        const aRes = await fetch(absUrl(audioUri, res.url), {
          headers: allenPlayerHeaders({ Range: "bytes=0-4000" }),
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        }).catch((e) => ({ status: 0, error: String(e?.message || e), text: async () => "" }));
        const aText = aRes.text ? await aRes.text().catch(() => "") : "";
        const rewrittenAudio = rewritten.match(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/i)?.[0] || "";
        diag.steps.audio = {
          present: true,
          status: aRes.status || 0,
          isPlaylist: aText.trimStart().startsWith("#EXTM3U"),
          segments: aText.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).length,
          rewriteViaProxy: /URI="\/api\/allen\?view=playlist/.test(rewrittenAudio),
          error: aRes.error || "",
        };
      } else {
        diag.steps.audio = { present: false };
      }
      if (media[0]) {
        const segUrl = absUrl(media[0], res.url);
        const seg = await fetch(segUrl, {
          headers: allenPlayerHeaders({ Range: "bytes=0-99" }),
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        }).catch((e) => ({ status: 0, headers: { get: () => "" }, error: String(e?.message || e) }));
        diag.steps.segment = {
          status: seg.status || 0,
          contentType: seg.headers.get("content-type") || "",
          viaProxyAllowed: allenProxyAllowed(segUrl),
          error: seg.error || "",
        };
        // A variant playlist is not a segment: go one level deeper so
        // the report ends at real media, not at another playlist.
        if (/mpegurl/i.test(seg.headers.get("content-type") || "") && seg.text) {
          const vtext = await seg.text().catch(() => "");
          const vmedia = vtext.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
          if (vmedia[0]) {
            const realSeg = absUrl(vmedia[0], seg.url || segUrl);
            const seg2 = await fetch(realSeg, {
              headers: allenPlayerHeaders({ Range: "bytes=0-99" }),
              redirect: "follow",
              signal: AbortSignal.timeout(15000),
            }).catch((e) => ({ status: 0, headers: { get: () => "" }, error: String(e?.message || e) }));
            diag.steps.segment2 = {
              host: hostOf(realSeg),
              status: seg2.status || 0,
              contentType: seg2.headers.get("content-type") || "",
              viaProxyAllowed: allenProxyAllowed(realSeg),
              error: seg2.error || "",
            };
          }
        }
      }
    }
  } catch (err) {
    diag.steps.play = { ok: false, status: 0, error: String(err?.message || err).slice(0, 160) };
  }
  diag.success = Boolean(diag.steps.play?.sniffedPlaylist || (diag.steps.play?.ok && diag.steps.segment?.status));
  return { success: diag.success, diag };
}

/** Per-route upstream health: the five-minute diagnosis. */
export async function allenProbe() {
  const sample = await allenBatches().catch(() => ({ items: [] }));
  const first = sample.items?.[0];
  const checks = [{ route: "/Allen/batches.json", status: first ? 200 : 0, ok: Boolean(first) }];
  if (first) {
    const path = `/Allen/api/subjects?${qs({ batch_id: first.batchId, course_id: first.courseId })}`;
    const got = await askJson(path, 8000);
    checks.push({ route: "/Allen/api/subjects", status: got.status, ok: Boolean(rows(got.body).length) });
  }
  return { success: true, base: allenBase(), routes: checks, sampleBatch: first?.code || "" };
}

/**
 * Whole-catalogue audit, in slices: "kuch batches nahi chal rahe"
 * is not actionable until it has names. For each batch in the slice
 * this walks subjects → (deep) first subject's topics → first
 * topic's lectures, and reports the stage where the chain breaks.
 * Lecture rows are only LISTED — their play tokens are never fetched
 * (see view=play: tokens can be single-use). Slices are capped so a
 * single invocation stays far under the subrequest ceiling:
 * subjects-only ≤ 20 batches (≤ ~41 upstream asks with retries),
 * deep ≤ 8 (≤ ~49 worst case, typically ~25).
 */
export async function allenAudit({ offset = 0, limit = 12, deep = false, byCourse = false } = {}) {
  const list = await allenBatches();
  if (!list.success) return { success: false, view: "audit", total: 0, error: list.error || "catalogue down" };
  const cap = deep ? 8 : 20;
  const size = Math.max(1, Math.min(cap, Number(limit) || 12));
  const from = Math.max(0, Number(offset) || 0);
  // By-course mode: batch variants (-DMB, -TEST, -MB…) share a course
  // and, upstream, a subject set — checking one representative per
  // course audits all 517 batches in a fraction of the calls, which
  // is what keeps each invocation under the subrequest ceiling.
  // Batches with no course id keep their own group.
  let groups = null;
  if (byCourse) {
    const byKey = new Map();
    for (const b of list.items) {
      const key = b.courseId || `batch:${b.batchId}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(b);
    }
    groups = [...byKey.values()];
  }
  const slice = (groups || list.items.map((b) => [b])).slice(from, from + size);

  const checkOne = async (group) => {
    const b = group[0];
    const row = {
      code: b.code,
      name: b.name,
      ok: false,
      stage: "subjects",
      subjects: 0,
      ...(groups ? { courseId: b.courseId || "", batches: group.length, codes: group.map((x) => x.code) } : {}),
    };
    const subs = await allenSubjects(b.batchId, b.courseId).catch(() => null);
    if (!subs?.success) {
      row.status = subs?.status || 0;
      // A 401/403/429/timeout under audit load is the upstream's rate
      // limiter talking (a known-good batch 403s mid-audit, and the
      // wall later answers 401), NOT a broken batch. It is reported
      // as `limited` — unknown, retry later — never as bad, or the
      // audit would condemn the healthiest batches on the site for
      // its own behaviour. A 200 that lists zero subjects is the
      // opposite: the upstream truly has nothing for this batch.
      if ([401, 403, 429, 0].includes(row.status)) {
        row.stage = "limited";
        row.error = "upstream rate-limited this ask — result unknown";
      } else if (subs?.empty) {
        row.error = "upstream lists no subjects for this batch (empty batch)";
      } else {
        row.error = subs?.error || "subjects failed";
      }
      return row;
    }
    row.subjects = subs.items.length;
    if (!deep) {
      row.ok = true;
      row.stage = "ok";
      return row;
    }
    // Deep walk: do NOT judge a batch by its first subject or first
    // chapter. Real batches list placeholder subjects (an "IOC" with
    // no chapters in front of a Maths with 83) and chapters whose
    // recordings are not up yet — the batch is healthy if ANY subject
    // answers chapters and ANY of its chapters answers lectures.
    // Tries are capped (6 subjects, 4 chapters) to stay well under
    // the subrequest ceiling; a rate-limit answer stops the walk.
    const limitedRow = (status) => {
      row.status = status;
      row.stage = "limited";
      row.error = "upstream rate-limited this ask — result unknown";
      return row;
    };
    let topics = null;
    let topicsSubject = null;
    let lastTopics = null;
    for (const s of subs.items.slice(0, 6)) {
      const t = await allenTopics(b.batchId, b.courseId, s.id, s.taxonomyId).catch(() => null);
      if (t?.success) {
        topics = t;
        topicsSubject = s;
        break;
      }
      lastTopics = t;
      if (t && [401, 403, 429, 0].includes(t.status || 0)) return limitedRow(t.status || 0);
    }
    if (!topics) {
      row.stage = "topics";
      row.status = lastTopics?.status || 0;
      row.error = lastTopics?.error || "topics failed";
      return row;
    }
    row.topics = topics.items.length;
    row.topicsSubject = topicsSubject.name;
    let lecs = null;
    let lastLecs = null;
    for (const t of topics.items.slice(0, 4)) {
      const l = await allenLectures(b.batchId, b.courseId, topicsSubject.id, topicsSubject.taxonomyId, t.id).catch(() => null);
      if (l?.success) {
        lecs = l;
        break;
      }
      lastLecs = l;
      if (l && [401, 403, 429, 0].includes(l.status || 0)) return limitedRow(l.status || 0);
    }
    if (!lecs) {
      row.stage = "lectures";
      row.status = lastLecs?.status || 0;
      row.error = lastLecs?.error || "lectures failed";
      return row;
    }
    row.lectures = lecs.items.length;
    row.withPlay = lecs.items.filter((l) => l.playUrl).length;
    row.ok = row.withPlay > 0;
    row.stage = row.ok ? "ok" : "noplay";
    if (!row.ok) row.error = "lectures list but none carries a play address";
    return row;
  };

  // Sequential with a breath between asks: the upstream rate-limits
  // bursts (parallel slices made healthy batches answer 403), and a
  // diagnosis that manufactures its own failures is worse than none.
  // Once the wall answers `limited`, every later ask in this slice
  // would hit the same wall — mark the rest limited WITHOUT asking,
  // so the audit stops feeding the limiter it is trying to measure.
  const results = [];
  let wallStatus = null;
  for (const group of slice) {
    if (wallStatus !== null) {
      const b = group[0];
      results.push({
        code: b.code,
        name: b.name,
        ok: false,
        stage: "limited",
        subjects: 0,
        status: wallStatus,
        error: "upstream rate-limited this slice — result unknown",
        ...(groups ? { courseId: b.courseId || "", batches: group.length, codes: group.map((x) => x.code) } : {}),
      });
      continue;
    }
    const row = await checkOne(group);
    if (row.stage === "limited") wallStatus = row.status;
    results.push(row);
    await new Promise((r) => setTimeout(r, 300));
  }
  const bad = results.filter((r) => !r.ok && r.stage !== "limited");
  const limited = results.filter((r) => r.stage === "limited");
  return {
    success: true,
    view: "audit",
    total: list.total,
    groups: groups ? groups.length : undefined,
    offset: from,
    checked: results.length,
    checkedBatches: results.reduce((n, r) => n + (r.batches || 1), 0),
    deep,
    okCount: results.filter((r) => r.ok).length,
    badCount: bad.length,
    limitedCount: limited.length,
    bad,
    limited,
    results,
  };
}

/** Test seam + healer seam: forget the five-minute catalogue memory. */
export function resetAllenCache() {
  cache.clear();
  playlistCache.clear();
}

/**
 * The /api/allen handler logic (mounted on the batches function as
 * action=allen — see the route tables — so the platform costs no
 * extra serverless function).
 */
export async function allenApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "batches");
  let batchId = String(params.batch || params.batch_id || "");
  let courseId = String(params.course || params.course_id || "");
  // Backwards compatibility: a cached older page (the service worker
  // serves /assets cache-first) asks with the visible batch CODE.
  // Resolve code → bt_/cr_ ids here so even a stale client works
  // instead of landing on an empty "not answering" panel.
  if (!batchId && params.code && ["subjects", "topics", "lectures"].includes(view)) {
    const list = await allenBatches().catch(() => ({ items: [] }));
    const found = (list.items || []).find((b) => b.code === String(params.code));
    if (found) {
      batchId = found.batchId;
      courseId = courseId || found.courseId;
    }
  }
  try {
    if (view === "probe") return send(200, await allenProbe());
    if (view === "audit") {
      return send(
        200,
        await allenAudit({
          offset: Number(params.offset) || 0,
          limit: Number(params.limit) || 12,
          deep: params.deep === "1",
          byCourse: params.by === "course",
        })
      );
    }
    if (view === "batches") {
      const out = await allenBatches();
      return send(out.success ? 200 : 502, out);
    }
    if (view === "play") {
      // Do NOT fetch the token here to "check" it. Their player loads
      // the token URL exactly once, as the stream source — play tokens
      // are short-lived and can be single-use, so a resolver pre-fetch
      // burns the token and the player's real ask lands on a dead one
      // (the "lecture never plays" failure, third act). Hand the
      // player our proxy URL for the untouched token and let the
      // proxy's fetch be the one and only consumption.
      const play = String(params.play || "");
      if (!play.startsWith(allenBase())) {
        return send(400, { success: false, error: "That play address is not from the Allen upstream." });
      }
      return send(200, {
        success: true,
        url: play,
        proxyUrl: `/api/allen?view=playlist&u=${encodeURIComponent(play)}`,
      });
    }
    if (view === "playlist") return allenPlaylist(req, res, String(params.u || ""));
    if (view === "playprobe") {
      const need = {
        batchId: String(params.batch || ""),
        courseId: String(params.course || ""),
        subjectId: String(params.subject || ""),
        taxonomyId: String(params.taxonomy || ""),
        topicId: String(params.topic || ""),
      };
      if (!need.batchId || !need.subjectId || !need.topicId)
        return send(400, { success: false, error: "batch, subject and topic are required" });
      return send(200, await allenPlayProbe(need));
    }
    if (!batchId) return send(400, { success: false, error: "batch (bt_ id) is required" });
    if (view === "subjects") {
      const out = await allenSubjects(batchId, courseId);
      return send(out.success ? 200 : 502, out);
    }
    const subjectId = String(params.subject || "");
    const taxonomyId = String(params.taxonomy || "");
    if (!subjectId) return send(400, { success: false, error: "subject is required" });
    if (view === "topics") {
      const out = await allenTopics(batchId, courseId, subjectId, taxonomyId);
      return send(out.success ? 200 : 502, out);
    }
    if (view === "lectures") {
      const topicId = String(params.topic || "");
      if (!topicId) return send(400, { success: false, error: "topic is required" });
      const out = await allenLectures(batchId, courseId, subjectId, taxonomyId, topicId);
      return send(out.success ? 200 : 502, out);
    }
    return send(400, { success: false, error: `unknown Allen view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
