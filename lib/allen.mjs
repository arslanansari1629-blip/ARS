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
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*" },
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
    return { url, status: res.status, ok: res.ok, body };
  } catch (err) {
    return { url, status: 0, ok: false, body: null, error: String(err?.message || err).slice(0, 160) };
  }
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
    if (!got.ok || !items.length)
      return { success: false, view: "subjects", total: 0, items: [], status: got.status, error: "Subjects did not answer upstream for this batch." };
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
    if (!got.ok || !items.length)
      return { success: false, view: "topics", total: 0, items: [], status: got.status, error: "Chapters did not answer upstream for this subject." };
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
  if (!got.ok || !items.length)
    return { success: false, view: "lectures", total: 0, items: [], status: got.status, error: "Lectures did not answer upstream for this chapter." };
  return { success: true, view: "lectures", source: got.url, total: items.length, items };
}

/** Resolve a content `play_url` to the final playable address. */
export async function allenPlay(playUrl) {
  if (!playUrl || !playUrl.startsWith(allenBase())) {
    return { success: false, url: "", error: "That play address is not from the Allen upstream." };
  }
  try {
    const res = await fetch(playUrl, {
      headers: { "User-Agent": UA, Accept: "*/*" },
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

/** Rewrite every media URI in an HLS playlist to ride /api/media. */
export function rewriteAllenPlaylist(text, baseUrl) {
  const wrap = (ref) => `/api/media?url=${encodeURIComponent(absUrl(ref, baseUrl))}`;
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${wrap(ref)}"`);
      }
      return wrap(t);
    })
    .join("\n");
}

async function allenPlaylist(req, res, raw) {
  if (!allenProxyAllowed(raw)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "That host is not part of the Allen platform." }));
  }
  try {
    const upstream = await fetch(raw, {
      headers: { "User-Agent": UA, Accept: "*/*", ...(req.headers?.range ? { Range: req.headers.range } : {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const type = upstream.headers.get("content-type") || "";
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Sniff the body: Allen's token endpoint serves its playlist as
    // text/plain at a URL with no .m3u8 in it, so content-type and
    // file extension both lie. #EXTM3U never does.
    if (!/video|octet-stream/i.test(type) || /mpegurl/i.test(type)) {
      const text = await upstream.text().catch(() => "");
      if (text.trimStart().startsWith("#EXTM3U") || /mpegurl/i.test(type)) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=15");
        return res.end(rewriteAllenPlaylist(text, upstream.url || raw));
      }
    }
    // Not a playlist (an mp4, a segment): hand the browser our media
    // relay instead of proxying bytes through the API function.
    res.statusCode = 302;
    res.setHeader("Location", `/api/media?url=${encodeURIComponent(upstream.url || raw)}`);
    return res.end();
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: String(err?.message || err).slice(0, 160) }));
  }
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

/** Test seam + healer seam: forget the five-minute catalogue memory. */
export function resetAllenCache() {
  cache.clear();
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
  const batchId = String(params.batch || params.batch_id || "");
  const courseId = String(params.course || params.course_id || "");
  try {
    if (view === "probe") return send(200, await allenProbe());
    if (view === "batches") {
      const out = await allenBatches();
      return send(out.success ? 200 : 502, out);
    }
    if (view === "play") {
      const out = await allenPlay(String(params.play || ""));
      // The player always loads OUR proxy URL, never Allen's host:
      // playlists come back rewritten, segments ride the media relay.
      const proxyUrl =
        out.success && out.url ? `/api/allen?view=playlist&u=${encodeURIComponent(out.url)}` : "";
      return send(out.success ? 200 : 502, {
        success: out.success,
        url: out.url || "",
        proxyUrl,
        error: out.error || "",
      });
    }
    if (view === "playlist") return allenPlaylist(req, res, String(params.u || ""));
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
