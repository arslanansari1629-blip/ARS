/**
 * Selection Way (STUDY HULK {SW}) — TEST-MODE platform client.
 *
 * Built on the operator's instruction: everything comes from
 * https://swstudyhulk.edgeone.dev (a Base44 app) starting from the
 * batch `6a8d695d6a1aff889c4dccf2`. The platform stays in test mode
 * (unlinked, landing card remains Coming Soon) until the operator
 * says "live". This module begins with the confined raw/probe views
 * used to map the upstream honestly; the catalogue views grow on
 * top of whatever the probes prove.
 */

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

export const SW_APP_ID = "6abcc36739e6600c007def69";
export const SW_SITE = "https://swstudyhulk.edgeone.dev";
export const SW_SAMPLE_BATCH = "6a8d695d6a1aff889c4dccf2";

const RAW_ORIGINS = ["https://swstudyhulk.edgeone.dev", "https://app.base44.com", "https://base44.app"];

async function swFetch(url, { method = "GET" } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, type: res.headers.get("content-type") || "", text, url: res.url };
}

/**
 * Raw read, confined to the Selection Way upstreams: the discovery
 * tool the platform is mapped with. `find=` returns the window
 * around a keyword so one call can reach inside a big bundle.
 */
export async function swRaw(params) {
  const path = String(params.path || "/");
  let url;
  try {
    url = new URL(path, `${SW_SITE}/`);
  } catch {
    return { success: false, error: "bad path" };
  }
  if (!RAW_ORIGINS.includes(url.origin)) {
    return { success: false, error: "raw reads stay on the Selection Way upstreams" };
  }
  const got = await swFetch(url.toString()).catch((e) => ({ status: 0, type: "", text: "", url: String(url), error: String(e?.message || e) }));
  const find = String(params.find || "");
  const at = Math.max(0, Number(params.at) || 0);
  let snippet = at ? got.text.slice(at, at + 6000) : got.text.slice(0, 6000);
  if (find) {
    const at = got.text.toLowerCase().indexOf(find.toLowerCase());
    snippet = at >= 0 ? got.text.slice(Math.max(0, at - 400), at + 5600) : `(not found: ${find}) ` + snippet;
  }
  const scripts = [...got.text.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]).slice(0, 30);
  let hits;
  if (find && params.all) {
    hits = [];
    const hay = got.text.toLowerCase();
    const needle = find.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0 && hits.length < 80; i = hay.indexOf(needle, i + 1)) hits.push(i);
  }
  return {
    success: got.status > 0,
    status: got.status,
    type: got.type,
    length: got.text.length,
    url: got.url,
    scripts,
    snippet,
    ...(hits ? { hits } : {}),
    ...(got.error ? { error: got.error } : {}),
  };
}

/** Map the Base44 surface: candidate entity endpoints, both hosts/styles. */
export async function swProbe() {
  const home = await swRaw({ path: "/" });
  const names = ["Course", "Batch", "Class", "Lecture", "Video", "Note", "Notes", "Subject", "Chapter", "Banner"];
  const tries = [];
  for (const host of ["https://app.base44.com", "https://base44.app"]) {
    for (const style of ["entities", "entities-v2"]) {
      for (const name of names.slice(0, 4)) {
        const u = style === "entities"
          ? `${host}/api/apps/${SW_APP_ID}/entities/${name}`
          : `${host}/api/apps/${SW_APP_ID}/entities/${name}/v2/list`;
        const got = await swFetch(u).catch((e) => ({ status: 0, text: "", error: String(e?.message || e) }));
        tries.push({ url: u, status: got.status, sample: got.text.slice(0, 220) });
      }
    }
    break; // first host pass is enough to learn the shape; extend once we see it
  }
  return {
    success: true,
    appId: SW_APP_ID,
    site: SW_SITE,
    sampleBatch: SW_SAMPLE_BATCH,
    home: { status: home.status, length: home.length, scripts: home.scripts, snippet: (home.snippet || "").slice(0, 800) },
    tries,
  };
}

/* ---- real catalogue views (test mode) ----
   Upstream shape (mapped via probes, 2026-11-28):
     GET {site}/api/batches                  → {state, count, data:[batch]}
     GET {site}/api/batches/{id}/classes     → {state, data:{course, topics}}
   A class carries classLink (direct HLS master), recordings[]
   (labelled MP4 ladders) and pdfs[] — all public CDN URLs. The
   classes payload can be megabytes, so classes answers SLIM and
   only play resolves the URLs for one lecture. */

async function swApiJson(path) {
  const got = await swFetch(`${SW_SITE}${path}`);
  if (!got.ok) throw new Error(`Selection Way upstream ${got.status} for ${path}`);
  return JSON.parse(got.text);
}

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(String(v || "[]"));
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
  } catch { return []; }
};

export function swNormBatch(b) {
  return {
    id: String(b.id || ""),
    title: String(b.title || "Untitled batch"),
    shortDescription: String(b.shortDescription || ""),
    banner: b.bannerSquare || b.banner || "",
    bannerWide: b.banner || b.bannerSquare || "",
    price: Number(b.price) || 0,
    discountPrice: Number(b.discountPrice) || 0,
    validity: String(b.validity || ""),
    mainCategory: String(b.mainCategory || ""),
    categoryName: String(b.categoryName || ""),
    facultyName: String(b.facultyName || ""),
    facultyImage: String(b.facultyImage || ""),
    isLive: !!b.isLive,
    isRecorded: !!b.isRecorded,
    isFree: !!b.isFree,
    classesCount: Number(b?._count?.classes) || 0,
    topicsCount: Number(b?._count?.topics) || 0,
    highlights: parseList(b.highlights?.length ? b.highlights : b.description),
  };
}

export async function swBatches() {
  const data = await swApiJson("/api/batches");
  const items = (Array.isArray(data?.data) ? data.data : []).map(swNormBatch).filter((b) => b.id);
  const categories = [...new Set(items.map((b) => b.mainCategory).filter(Boolean))].sort();
  return { success: true, total: items.length, categories, items, testMode: true };
}

export function swSlimClass(c) {
  return {
    id: String(c.id || ""),
    title: String(c.title || "Untitled lecture"),
    teacherName: String(c.teacherName || ""),
    date: c.date || null,
    duration: Number(c.duration) || 0,
    sectionName: String(c.sectionName || ""),
    isLive: !!c.isLive,
    streamStatus: String(c.streamStatus || ""),
    hasVideo: !!c.classLink || (Array.isArray(c.recordings) && c.recordings.length > 0),
    pdfCount: Array.isArray(c.pdfs) ? c.pdfs.length : 0,
  };
}

/* The classes payload is huge; cache the parsed copy per isolate
   for a few minutes so play lookups don't refetch megabytes. */
const classesCache = new Map();
async function swClassesData(batchId) {
  const hit = classesCache.get(batchId);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
  /* Big batches ship megabytes of classes JSON; give the upstream
     real time instead of dying at the probe timeout. */
  const got = await swFetch(`${SW_SITE}/api/batches/${encodeURIComponent(batchId)}/classes`, { timeout: 55000 });
  if (!got.ok) throw new Error(`Selection Way upstream ${got.status} for classes`);
  const data = JSON.parse(got.text);
  classesCache.set(batchId, { at: Date.now(), data: data?.data || {} });
  if (classesCache.size > 8) classesCache.delete(classesCache.keys().next().value);
  return data?.data || {};
}

export async function swClasses(params) {
  const batchId = String(params.id || "");
  if (!batchId) return { success: false, error: "batch id required" };
  const data = await swClassesData(batchId);
  const course = data.course ? swNormBatch(data.course) : null;
  const topics = (Array.isArray(data.topics) ? data.topics : []).map((t) => ({
    topicId: String(t.topicId || ""),
    topicName: String(t.topicName || "General"),
    classes: (Array.isArray(t.classes) ? t.classes : []).map(swSlimClass),
  })).filter((t) => t.classes.length);
  const classes = topics.reduce((n, t) => n + t.classes.length, 0);
  const notes = topics.reduce((n, t) => n + t.classes.reduce((m, c) => m + c.pdfCount, 0), 0);
  return { success: true, course, topics, totalClasses: classes, totalNotes: notes, testMode: true };
}

export async function swPlay(params) {
  const batchId = String(params.id || "");
  const classId = String(params.class || "");
  if (!batchId || !classId) return { success: false, error: "batch id and class id required" };
  const data = await swClassesData(batchId);
  for (const t of Array.isArray(data.topics) ? data.topics : []) {
    for (const c of Array.isArray(t.classes) ? t.classes : []) {
      if (String(c.id) !== classId) continue;
      return {
        success: true,
        title: String(c.title || "Lecture"),
        teacherName: String(c.teacherName || ""),
        topicName: String(t.topicName || ""),
        classLink: String(c.classLink || ""),
        recordings: (Array.isArray(c.recordings) ? c.recordings : []).map((r) => ({
          quality: String(r.quality || ""), url: String(r.url || ""), size: Number(r.size) || 0,
        })).filter((r) => r.url),
        pdfs: (Array.isArray(c.pdfs) ? c.pdfs : []).map((p) => ({
          name: String(p.name || "Notes"), url: String(p.url || ""), kind: String(p.kind || "notes"),
        })).filter((p) => p.url),
        testMode: true,
      };
    }
  }
  return { success: false, error: "class not found in this batch" };
}

/**
 * Stream relay for the hranker CDNs: they serve the browser no CORS
 * headers (and answer playlist reads with a 500 to foreign agents),
 * so playback goes through our own origin. Playlists are rewritten
 * so every segment/key also relays; Range is forwarded for MP4
 * seeking. Confined to hranker hosts — never an open proxy.
 */
export async function swProxy(req, res, params) {
  const target = String(params.url || "");
  let url;
  try { url = new URL(target); } catch { url = null; }
  const hostOk = url && url.protocol === "https:" && (url.hostname === "hranker.com" || url.hostname.endsWith(".hranker.com"));
  if (!hostOk) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "proxy is confined to the Selection Way CDNs" }));
  }
  const headers = { "User-Agent": UA, Accept: "*/*", Referer: `${SW_SITE}/` };
  const range = req?.headers?.range || req?.headers?.Range;
  if (range) headers.Range = range;
  const up = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) }).catch((e) => ({ error: e }));
  if (!up || up.error || (!up.ok && up.status !== 206)) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: `CDN returned ${up?.status || up?.error?.message || "error"}` }));
  }
  const type = up.headers.get("content-type") || "";
  const isPlaylist = /\.m3u8($|\?)/i.test(url.pathname + url.search) || /mpegurl/i.test(type);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (isPlaylist) {
    const text = await up.text();
    const wrap = (u) => {
      try {
        const abs = new URL(u, url).toString();
        return `/api/selectionway?view=proxy&url=${encodeURIComponent(abs)}`;
      } catch { return u; }
    };
    const out = text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${wrap(u)}"`);
      return wrap(t);
    }).join("\n");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    return res.end(out);
  }
  res.statusCode = up.status;
  res.setHeader("Content-Type", type || "application/octet-stream");
  const len = up.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);
  const cr = up.headers.get("content-range");
  if (cr) res.setHeader("Content-Range", cr);
  res.setHeader("Accept-Ranges", "bytes");
  if (!up.body) return res.end();
  const reader = up.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  return res.end();
}

export async function selectionWayApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "probe");
  try {
    if (view === "probe") return send(200, await swProbe());
    if (view === "raw") return send(200, await swRaw(params));
    if (view === "batches") return send(200, await swBatches());
    if (view === "classes") return send(200, await swClasses(params));
    if (view === "play") return send(200, await swPlay(params));
    return send(400, { success: false, error: `unknown Selection Way view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
