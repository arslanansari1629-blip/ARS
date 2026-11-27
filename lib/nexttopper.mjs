/**
 * The Next Toppers section's upstream client.
 *
 * `/nexttopper` is a third platform on this site, modelled on the
 * Allen stack (lib/allen.mjs) and pointed at the same Nexthope
 * backend that serves Allen. Their NT frontend (discovered live via
 * the `view=raw` probe below, November 2026) is a folder-tree app:
 *
 *   courses   POST /nexttopper/api/all-courses    {view_type,cat_id,page,limit,is_free}
 *   overview  POST /nexttopper/api/course-details {course_id,parent_course_id}
 *   content   POST /nexttopper/api/all-content    {course_id,folder_id,parent_course_id,page,limit,is_free}
 *
 * A course page is a tree: folder_id "0" is the root, folders open
 * into folders, and the leaves are videos (m3u8 / mp4 / YouTube —
 * some carry a `vdc_id`, i.e. VdoCipher), PDFs and tests. Their own
 * content parser (parseContentData / isFolderItem in content.html)
 * is mirrored in normalizeNtItem below — same file_type codes, same
 * content_counts badges — so what we list is what their app lists.
 *
 * A course id can arrive as "<id>-p<parent>"; the parent defaults
 * to "1" upstream, and all-content wants "0" when there is no real
 * parent. splitNtCourseId keeps that arithmetic in one place.
 *
 * `view=raw` / `view=apiprobe` are the discovery probes that found
 * this shape; they stay (whitelisted, bounded) as the five-minute
 * diagnosis for the next time the upstream changes its mind.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function ntBase() {
  return String(process.env.NEXTTOPPER_API_BASE || process.env.ALLEN_API_BASE || "https://stream.nexthope.sbs").replace(/\/+$/, "");
}

const cache = new Map(); // key → { at, value }
const CACHE_MS = 5 * 60 * 1000;

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await load();
  if (value.success) cache.set(key, { at: Date.now(), value });
  return value;
}

async function askPost(endpoint, body, timeoutMs = 20000) {
  const url = `${ntBase()}/nexttopper/api/${endpoint}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          Accept: "application/json, */*",
          Referer: `${ntBase()}/nexttopper/content.html`,
          Origin: ntBase(),
        },
        body: JSON.stringify(body),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON — callers treat as unusable */
      }
      const out = { url, status: res.status, ok: res.ok, body: json };
      if (out.ok || attempt === 1 || ![401, 403, 429].includes(res.status) && res.status < 500) return out;
    } catch (err) {
      if (attempt === 1)
        return { url, status: 0, ok: false, body: null, error: String(err?.message || err).slice(0, 160) };
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return { url, status: 0, ok: false, body: null };
}

/** "<id>-p<parent>" → { id, parent }; parent defaults to "1" like their app. */
export function splitNtCourseId(raw) {
  const s = String(raw || "").trim();
  if (!s.includes("-")) return { id: s, parent: "1" };
  const [id, rest] = s.split("-", 2);
  return { id, parent: rest?.startsWith("p") ? rest.slice(1) : rest || "1" };
}

export function normalizeNtCourse(raw = {}) {
  const id = String(raw.id ?? raw.course_id ?? "").trim();
  if (!id) return null;
  const title = String(raw.title || raw.name || `Course ${id}`).trim();
  // Class is read off the title ("10TH ABHAY…", "Class 12th Science",
  // "CUET (Science)") — the catalogue's main filter, like theirs.
  const clsMatch = title.match(/(?:class\s*)?(6|7|8|9|10|11|12)(?:th|st|nd|rd)?\b/i);
  return {
    id,
    title,
    thumbnail: String(raw.thumbnail || raw.image || "").trim(),
    class: clsMatch ? `Class ${clsMatch[1]}` : /cuet/i.test(title) ? "CUET" : /olympiad|ioqm|nsejs/i.test(title) ? "Olympiad" : "All classes",
    price: String(raw.price ?? raw.course_price ?? "").trim(),
    parentId: String(raw.parent_course_id ?? raw.parent_id ?? "").trim(),
  };
}

function coursesFromBody(body) {
  const data = body?.data ?? body;
  if (Array.isArray(data)) {
    const layout = data.find((l) => l?.layout_type === "course_list_layout");
    if (layout) return Array.isArray(layout.list) ? layout.list : [];
    // An array of courses directly, or of layouts without the marker.
    if (data.length && (data[0]?.title || data[0]?.course_id)) return data;
    for (const l of data) if (Array.isArray(l?.list) && l.list.length) return l.list;
    return [];
  }
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(body?.courses)) return body.courses;
  return [];
}

async function ntCoursesPage(page, limit = 100) {
  const got = await askPost("all-courses", { view_type: "1", cat_id: "0", page: String(page), limit: String(limit), is_free: "0" });
  if (!got.ok) return { success: false, status: got.status, items: [], error: "The Next Toppers catalogue did not answer." };
  return { success: true, status: got.status, items: coursesFromBody(got.body).map(normalizeNtCourse).filter(Boolean) };
}

async function ntBatches() {
  return cached("batches", async () => {
    const items = [];
    const seen = new Set();
    // Their index pages 100 at a time; walk a few pages until a short
    // page says the catalogue is done. Capped so one ask stays cheap.
    for (let page = 1; page <= 6; page++) {
      const got = await ntCoursesPage(page);
      if (!got.success) {
        if (!items.length) return { success: false, view: "batches", total: 0, items: [], status: got.status, error: got.error };
        break;
      }
      for (const c of got.items) if (!seen.has(c.id) && seen.add(c.id)) items.push(c);
      if (got.items.length < 100) break;
    }
    if (!items.length)
      return { success: false, empty: true, view: "batches", total: 0, items: [], error: "Upstream lists no Next Toppers courses right now." };
    return { success: true, view: "batches", total: items.length, items };
  });
}

async function ntDetails(courseRaw) {
  const { id, parent } = splitNtCourseId(courseRaw);
  if (!id) return { success: false, view: "details", error: "course id is required" };
  return cached(`details:${id}:${parent}`, async () => {
    const got = await askPost("course-details", { course_id: String(id), parent_course_id: String(parent) });
    if (!got.ok) return { success: false, view: "details", status: got.status, error: "Course details did not answer upstream." };
    const data = got.body?.data ?? got.body;
    let details = null;
    if (Array.isArray(data)) {
      const tab = data.find((d) => d?.type === "overview" || String(d?.title || "").toLowerCase() === "overview") || data[0];
      const section = tab?.data?.find?.((l) => l?.layout_type === "details");
      details = section?.layout_data?.[0] || null;
    } else if (data && typeof data === "object") {
      details = data;
    }
    return {
      success: true,
      view: "details",
      course: details
        ? {
            id,
            title: String(details.title || "").trim(),
            thumbnail: String(details.thumbnail || "").trim(),
            description: String(details.description || "").trim(),
          }
        : { id, title: "", thumbnail: "", description: "" },
    };
  });
}

export function normalizeNtItem(raw = {}) {
  const d = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  const id = String(raw.entity_id || raw.id || raw.content_id || raw.item_id || d.id || d.entity_id || d.content_id || d.item_id || "").trim();
  if (!id) return null;
  const title = String(raw.title || raw.name || d.test_name || d.title || d.name || "Untitled").trim();
  const fileType = Number(d.file_type ?? raw.file_type ?? 0);
  const type = String(raw.type || d.type || "").toLowerCase();
  const counts = d.content_counts || raw.content_counts || null;
  const isFolder =
    type === "folder" || fileType === 3 || type === "3" || Boolean(raw.is_folder || d.is_folder) ||
    Boolean(counts && (counts.folders !== undefined || counts.video !== undefined || counts.pdf !== undefined || counts.test !== undefined || counts.tests !== undefined));
  const fileUrl = String(d.file_url || d.url || raw.file_url || "").trim();
  const clean = fileUrl.split("?")[0].toLowerCase();
  let kind = "video";
  if (type === "test" || fileType === 5 || d.test_name || raw.test_name) kind = "test";
  else if (isFolder) kind = "folder";
  else if (clean.endsWith(".pdf") || fileType === 1 || type === "notes") kind = "pdf";
  const countOf = (...keys) => {
    for (const k of keys) {
      const v = counts?.[k];
      if (typeof v === "number") return v;
      if (v && typeof v === "object") {
        const t = (v.paid || 0) + (v.free || 0) || v.total || 0;
        if (t) return t;
      }
    }
    return 0;
  };
  return {
    id,
    title,
    kind,
    thumbnail: String(d.thumbnail || raw.thumbnail || "").trim(),
    duration: String(d.duration || d.total_time || "").trim(),
    fileUrl,
    vdcId: String(d.vdc_id || raw.vdc_id || "").trim(),
    live: Number(d.live_status) || Number(d.is_live) || 0,
    counts: counts
      ? { folders: countOf("folders", "folder"), videos: countOf("video", "videos"), pdfs: countOf("pdf", "pdfs"), tests: countOf("test", "tests") }
      : null,
  };
}

async function ntContent(courseRaw, folderId = "0") {
  const { id, parent } = splitNtCourseId(courseRaw);
  if (!id) return { success: false, view: "content", error: "course id is required" };
  const parentForApi = parent !== "1" ? parent : "0";
  const load = async () => {
    const got = await askPost("all-content", {
      course_id: String(id),
      folder_id: String(folderId || "0"),
      parent_course_id: String(parentForApi),
      page: "1",
      limit: "200",
      is_free: "0",
    });
    if (!got.ok)
      return { success: false, view: "content", total: 0, items: [], status: got.status, error: "Course content did not answer upstream." };
    const rawItems = got.body?.data ?? got.body ?? [];
    const items = (Array.isArray(rawItems) ? rawItems : []).map(normalizeNtItem).filter(Boolean);
    if (!items.length)
      return { success: false, empty: true, view: "content", total: 0, items: [], status: got.status, error: "Upstream lists no content in this folder." };
    return { success: true, view: "content", courseId: id, folderId: String(folderId || "0"), total: items.length, items };
  };
  // Folder listings are catalogue-shaped (no signed URLs needed to
  // LIST them); cache briefly like the levels above it.
  return cached(`content:${id}:${parent}:${folderId}`, load);
}

/**
 * Playback hosts for the NT proxy. Their thumbnails/streams ride
 * CloudFront (two distributions seen live) and the usual Indian
 * ed-tech CDNs; VdoCipher, when a vdc_id resolves, serves from its
 * own hosts. Same posture as the Allen allowlist: https only, named
 * suffixes only.
 */
const PROXY_HOSTS = /(^|\.)(cloudfront\.net|nexthope\.sbs|akamaihd\.net|akamaized\.net|amazonaws\.com|vdocipher\.com|classplusapp\.com)$/i;

export function ntProxyAllowed(raw) {
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

/** Rewrite an HLS playlist so every hop rides this proxy (see Allen's). */
export function rewriteNtPlaylist(text, baseUrl) {
  const wrapMedia = (ref) => `/api/media?url=${encodeURIComponent(absUrl(ref, baseUrl))}`;
  const wrapPlaylist = (ref) => `/api/nexttopper?view=playlist&u=${encodeURIComponent(absUrl(ref, baseUrl))}`;
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        const isPlaylistTag = /^#EXT-X-MEDIA:/i.test(t) || /^#EXT-X-I-FRAME-STREAM-INF/i.test(t);
        return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${isPlaylistTag ? wrapPlaylist(ref) : wrapMedia(ref)}"`);
      }
      return wrapPlaylist(t);
    })
    .join("\n");
}

function ntPlayerHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Accept: "*/*",
    Referer: `${ntBase()}/nexttopper/play.html`,
    Origin: ntBase(),
    ...extra,
  };
}

async function ntPlaylist(req, res, raw) {
  if (!ntProxyAllowed(raw)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "That host is not part of the Next Toppers platform." }));
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const upstream = await fetch(raw, {
      headers: ntPlayerHeaders(req.headers?.range ? { Range: req.headers.range } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const type = upstream.headers.get("content-type") || "";
    if (!/video|octet-stream/i.test(type) || /mpegurl/i.test(type)) {
      const text = await upstream.text().catch(() => "");
      if (text.trimStart().startsWith("#EXTM3U") || /mpegurl/i.test(type)) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=15");
        res.setHeader("X-NT-Proxy", "playlist");
        return res.end(rewriteNtPlaylist(text, upstream.url || raw));
      }
    }
    res.statusCode = 302;
    res.setHeader("Location", `/api/media?url=${encodeURIComponent(upstream.url || raw)}`);
    res.setHeader("X-NT-Proxy", "segment-redirect");
    return res.end();
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: String(err?.message || err).slice(0, 160) }));
  }
}

/**
 * Resolve one content leaf to something the player can load. Plain
 * file URLs (m3u8/mp4/YouTube) answer directly; a vdc_id leaf is
 * VdoCipher and needs their play-page handshake — reported honestly
 * as `vdc` until that handshake is wired, never faked.
 */
function ntPlay(params) {
  const fileUrl = String(params.file || "");
  const vdcId = String(params.vdc || "");
  if (fileUrl) {
    try {
      const u = new URL(fileUrl);
      if (u.protocol !== "https:") throw new Error("not https");
    } catch {
      return { success: false, error: "That file address is not usable." };
    }
    if (/youtube\.com|youtu\.be/i.test(fileUrl)) return { success: true, kind: "youtube", url: fileUrl };
    if (/\.mp4($|\?)/i.test(fileUrl)) return { success: true, kind: "mp4", url: fileUrl, proxyUrl: `/api/media?url=${encodeURIComponent(fileUrl)}` };
    if (/\.m3u8($|\?)/i.test(fileUrl)) {
      return {
        success: true,
        kind: "hls",
        url: fileUrl,
        proxyUrl: ntProxyAllowed(fileUrl) ? `/api/nexttopper?view=playlist&u=${encodeURIComponent(fileUrl)}` : fileUrl,
      };
    }
    return { success: true, kind: "file", url: fileUrl };
  }
  if (vdcId) return { success: false, vdc: true, error: "This lecture is VdoCipher-encrypted upstream; its playback handshake is not wired yet." };
  return { success: false, error: "This content carries no playable address." };
}

/* ---------------- discovery probes (kept, whitelisted) ---------------- */

async function askText(path, timeoutMs = 15000) {
  const url = ntBase() + path;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { url, finalUrl: res.url, status: res.status, ok: res.ok, type: res.headers.get("content-type") || "", text };
  } catch (err) {
    return { url, finalUrl: "", status: 0, ok: false, type: "", text: "", error: String(err?.message || err).slice(0, 160) };
  }
}

export async function ntRaw(params) {
  const path = String(params.path || "/nexttopper/content.html?id=176");
  if (!path.startsWith("/nexttopper/") || path.includes("..")) {
    return { success: false, error: "path must stay under /nexttopper/" };
  }
  const got = await askText(path);
  const html = got.text || "";
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script(?![^>]+src)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
  const calls = [...new Set([...inline.matchAll(/(?:fetch|axios|url\s*[:=]|api[_-]?url\s*[:=])\s*\(?\s*["'`]([^"'`]{3,180})["'`]/gi)].map((m) => m[1]))].slice(0, 60);
  const endpoints = [...new Set([...html.matchAll(/["'`](\/(?:nexttopper|api)\/[^"'`\s<>]{2,160})["'`]/g)].map((m) => m[1]))].slice(0, 80);
  // `find=<needle>`: bounded context windows around every occurrence —
  // how a 100 KB player page's resolver section is read without
  // hauling the whole file through three layers of tooling.
  const needle = String(params.find || "");
  const found = [];
  if (needle) {
    let at = 0;
    while (found.length < 4) {
      const i = html.indexOf(needle, at);
      if (i < 0) break;
      found.push(html.slice(Math.max(0, i - 1200), i + 5000));
      at = i + needle.length;
    }
  }
  return {
    success: got.ok,
    view: "raw",
    status: got.status,
    finalUrl: got.finalUrl,
    contentType: got.type,
    bytes: html.length,
    scripts,
    calls,
    endpoints,
    found,
    inlineScript: inline.slice(0, 24000),
    htmlHead: html.slice(0, 4000),
    error: got.error || (got.ok ? "" : `upstream answered ${got.status}`),
  };
}

const NT_API_ENDPOINTS = new Set(["all-courses", "course-details", "all-content", "check-status"]);

export async function ntApiProbe(params) {
  const endpoint = String(params.endpoint || "");
  if (!NT_API_ENDPOINTS.has(endpoint)) return { success: false, error: "endpoint not whitelisted" };
  let body = {};
  try {
    body = params.body ? JSON.parse(String(params.body)) : {};
  } catch {
    return { success: false, error: "body must be JSON" };
  }
  const got = await askPost(endpoint, body);
  return {
    success: got.ok,
    view: "apiprobe",
    endpoint,
    status: got.status,
    json: got.body ? JSON.stringify(got.body).slice(0, 24000) : "",
    error: got.error || "",
  };
}

/** Test seam: forget the five-minute catalogue memory. */
export function resetNtCache() {
  cache.clear();
}

/** The /api/nexttopper handler logic (mounted on the batches function). */
export async function nextTopperApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "batches");
  try {
    if (view === "raw") return send(200, await ntRaw(params));
    if (view === "apiprobe") return send(200, await ntApiProbe(params));
    if (view === "batches") {
      const out = await ntBatches();
      return send(out.success ? 200 : 502, out);
    }
    if (view === "details") {
      const out = await ntDetails(String(params.course || ""));
      return send(out.success ? 200 : 502, out);
    }
    if (view === "content") {
      const out = await ntContent(String(params.course || ""), String(params.folder || "0"));
      return send(out.success ? 200 : 502, out);
    }
    if (view === "play") return send(200, ntPlay(params));
    if (view === "playlist") return ntPlaylist(req, res, String(params.u || ""));
    if (view === "probe") {
      const out = await ntBatches();
      return send(200, {
        success: out.success,
        base: ntBase(),
        routes: [{ route: "/nexttopper/api/all-courses", ok: out.success, count: out.total || 0 }],
        sampleCourse: out.items?.[0]?.title || "",
      });
    }
    return send(400, { success: false, error: `unknown Next Toppers view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
