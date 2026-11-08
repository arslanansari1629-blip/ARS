/**
 * Normalised data access for the PW catalogue.
 *
 * Every function here performs a live request against the upstream API used by
 * the EduVibe PW site — no data is baked into this repository.
 */

import {
  upstreamJson,
  resolveAsset,
  stripHtml,
  normalizeBatch,
  UPSTREAM_BASE,
} from "./upstream.mjs";

const PAGE_LIMIT = 12;

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export async function fetchCatalogPage(page = 1) {
  const p = Math.max(1, Number(page) || 1);
  const res = await upstreamJson(`/AllBatches?page=${p}`);
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error || "Catalogue unavailable", batches: [], page: p };
  }
  const batches = (res.data.batches || []).map(normalizeBatch).filter(Boolean);
  return {
    ok: true,
    page: res.data.currentPage || p,
    totalPages: res.data.totalPages || 1,
    total: res.data.total || batches.length,
    pageSize: res.data.pageSize || batches.length,
    batches,
    source: "pw-eduvibe",
  };
}

export async function searchCatalog(name, limit = PAGE_LIMIT) {
  const q = String(name || "").trim();
  if (!q) return { ok: true, batches: [], total: 0 };
  const res = await upstreamJson(`/searchBatch?name=${encodeURIComponent(q)}`);
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error || "Search unavailable", batches: [] };
  }
  const batches = (res.data.batches || []).map(normalizeBatch).filter(Boolean);
  return { ok: true, batches: batches.slice(0, limit), total: batches.length };
}

/* ------------------------------------------------------------------ */
/* Batch details + subjects                                            */
/* ------------------------------------------------------------------ */

export async function fetchBatch(batchId) {
  const res = await upstreamJson(
    `/BatchInfo?BatchId=${encodeURIComponent(batchId)}&Type=details`,
    25000
  );
  const d = res.ok && res.data && res.data.data;
  if (!d) return { ok: false, error: res.error || "Batch not found", status: res.status };

  const subjects = (Array.isArray(d.subjects) ? d.subjects : [])
    .map((s) => ({
      id: s._id || "",
      subjectId: s.subjectId || "",
      name: (s.subject || "Subject").trim(),
      slug: s.slug || s.subjectId || "",
      lectureCount: Number(s.lectureCount || 0),
      tagCount: Number(s.tagCount || 0),
      displayOrder: Number.isFinite(s.displayOrder) ? s.displayOrder : 999,
      image: resolveAsset(s.imageId),
      isResources: Boolean(s.isResources),
      teachers: (s.teacherIds || []).map((t) => ({
        name: [t.firstName, t.lastName].filter(Boolean).join(" "),
        image: resolveAsset(t.imageId),
        subject: t.subject || "",
        qualification: t.qualification || "",
      })),
      notesPdf: resolveAsset(s.fileId),
    }))
    .filter((s) => s.slug && s.name)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  const card = d.config && d.config.card ? d.config.card : {};
  const preview = resolveAsset(d.previewImage) || d.previewImageUrl || "";

  return {
    ok: true,
    batch: {
      id: d._id || batchId,
      name: d.name || d.batchName || "Untitled batch",
      byName: d.byName || "",
      slug: d.slug || "",
      description: stripHtml(d.description),
      shortDescription: stripHtml(d.shortDescription),
      language: d.language || "",
      startDate: d.startDate || "",
      endDate: d.endDate || "",
      exam: Array.isArray(d.exam) ? d.exam : [],
      className: typeof d.class === "string" ? d.class : "",
      price: typeof d.feeTotal === "number" ? d.feeTotal : null,
      sellingPrice:
        d.config && typeof d.config.sellingPrice === "number" ? d.config.sellingPrice : null,
      discount: d.config && typeof d.config.discount === "number" ? d.config.discount : null,
      image: preview,
      banners: (card.files || []).map((f) => f && f.url).filter(Boolean),
      examTarget: card.examTarget || "",
      target: card.target || "",
      isFree: !d.feeTotal,
    },
    subjects,
  };
}

/* ------------------------------------------------------------------ */
/* Chapters                                                            */
/* ------------------------------------------------------------------ */

export async function fetchChapters(batchId, subjectSlug, maxPages = 8) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await upstreamJson(
      `/SubjectInfo?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
        subjectSlug
      )}&page=${page}`,
      20000
    );
    if (!res.ok) {
      if (page === 1) return { ok: false, error: res.error || "Chapters unavailable", chapters: [] };
      break;
    }
    const arr = res.data && Array.isArray(res.data.data) ? res.data.data : [];
    if (!arr.length) break;
    for (const c of arr) {
      all.push({
        id: c._id,
        name: (c.name || "Chapter").trim(),
        videos: Math.max(Number(c.videos || 0), Number(c.lectureVideos || 0)),
        notes: Number(c.notes || 0),
        exercises: Number(c.exercises || 0),
        displayOrder: Number.isFinite(c.displayOrder) ? c.displayOrder : 999,
        type: c.type || "",
      });
    }
    if (arr.length < 20) break;
  }
  all.sort((a, b) => a.displayOrder - b.displayOrder);
  return { ok: true, chapters: all };
}

/* ------------------------------------------------------------------ */
/* Chapter contents (lectures / notes / DPPs)                          */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES = new Set(["videos", "notes", "DppNotes", "DppVideos"]);

function attachmentUrl(att) {
  if (!att) return "";
  const base = (att.baseUrl || "https://static.pw.live/").replace(/\/+$/, "");
  if (att.key) return `${base}/${String(att.key).replace(/^\/+/, "")}`;
  if (att.baseUrl && /\.pdf($|\?)/i.test(att.baseUrl)) return att.baseUrl;
  return "";
}

function mapVideo(item) {
  const vd = item.videoDetails || {};
  return {
    id: item._id,
    kind: "video",
    title: (vd.name || item.topic || "Lecture").trim(),
    topic: (item.topic || "").trim(),
    thumbnail: vd.image || "",
    duration: vd.duration || "",
    date: item.startTime || item.date || "",
    status: vd.status || item.status || "",
    lectureType: item.lectureType || "",
    urlType: (item.urlType || "").toLowerCase(),
    videoId: vd.videoUrl || item.url || "",
    drm: Boolean(vd.drmProtected),
    types: vd.types || [],
  };
}

/**
 * Collect the PDF attachment descriptors of a schedule item.
 *
 * PW publishes the class notes / DPP file as an attachment whose `key` is
 * usually empty in list responses. The real storage key is only returned by
 * `GetPdf`, so attachments without a resolvable URL are kept with their
 * pdfId + attachmentId and resolved later (see `resolvePendingDocs`).
 */
function mapDoc(item, type) {
  const docs = [];
  const push = (hw) => {
    for (const att of hw.attachmentIds || []) {
      const url = attachmentUrl(att);
      docs.push({
        id: att._id || hw._id,
        name: (att.name || hw.topic || "Document").trim(),
        topic: (hw.topic || "").trim(),
        note: hw.note || "",
        url,
        size: att.size || 0,
        pdfId: item._id,
        attachmentId: att._id || "",
      });
    }
    if (hw.note && !(hw.attachmentIds || []).length && hw.noteUrl) {
      docs.push({ id: hw._id, name: hw.topic || "Document", url: hw.noteUrl, topic: hw.topic || "" });
    }
  };

  for (const hw of item.homeworkIds || []) push(hw);
  if (item.dpp && Array.isArray(item.dpp.homeworkIds)) item.dpp.homeworkIds.forEach(push);

  // A pure-PDF "schedule" (notes tab) often carries attachments at the top level
  if (!docs.length && Array.isArray(item.attachmentIds)) {
    push({ _id: item._id, topic: item.topic, note: "", attachmentIds: item.attachmentIds });
  }

  const label = (docs[0] && docs[0].topic) || (docs[0] && docs[0].name) || (item.topic || "Document");
  return {
    id: item._id,
    kind: type === "DppNotes" ? "dpp" : "notes",
    title: label.trim(),
    date: item.startTime || item.date || "",
    docs,
  };
}

/** Cache of `attachmentId -> signed-ish PDF url`, kept warm across requests. */
const pdfUrlCache = new Map();

/**
 * Fill in `doc.url` for attachments that arrived without a storage key by
 * asking `GetPdf` for each one. Runs in parallel with a small concurrency cap
 * so a 20-item page resolves in a single round trip's worth of latency.
 */
async function resolvePendingDocs(docs, batchId, subjectSlug) {
  const pending = docs.filter((d) => !d.url && d.pdfId && d.attachmentId);
  if (!pending.length) return;
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const doc = pending[cursor++];
      const key = `${doc.pdfId}:${doc.attachmentId}`;
      let url = pdfUrlCache.get(key);
      if (url === undefined) {
        url = await resolvePdfUrl(batchId, subjectSlug, doc.pdfId, doc.attachmentId).catch(() => "");
        if (url) pdfUrlCache.set(key, url);
      }
      if (url) doc.url = url;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
}

export async function fetchChapterContents(
  batchId,
  subjectSlug,
  topicId,
  contentType = "videos",
  maxPages = 6
) {
  if (!CONTENT_TYPES.has(contentType)) {
    return { ok: false, error: "Invalid contentType", items: [] };
  }

  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await upstreamJson(
      `/TopicInfo?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
        subjectSlug
      )}&TopicId=${encodeURIComponent(topicId)}&ContentType=${contentType}&page=${page}`,
      20000
    );
    if (!res.ok) {
      if (page === 1)
        return { ok: false, error: res.error || "Contents unavailable", items: [], contentType };
      break;
    }
    const arr = res.data && Array.isArray(res.data.data) ? res.data.data : [];
    if (!arr.length) break;
    for (const item of arr) {
      items.push(contentType === "videos" || contentType === "DppVideos"
        ? mapVideo(item)
        : mapDoc(item, contentType));
    }
    if (arr.length < 20) break;
  }

  // newest first — matches how the source lists lectures
  if (contentType === "videos" || contentType === "DppVideos") {
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  } else {
    // notes/DPP attachments arrive without a storage key — resolve them
    const docs = items.flatMap((it) => it.docs || []);
    await resolvePendingDocs(docs, batchId, subjectSlug);
    // drop entries whose every attachment failed to resolve
    items.forEach((it) => {
      it.docs = (it.docs || []).filter((d) => d.url);
    });
  }
  return { ok: true, items, contentType };
}

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */

export async function fetchAnnouncements(batchId, page = 1) {
  const res = await upstreamJson(
    `/BatchInfo?BatchId=${encodeURIComponent(batchId)}&Type=announcement&page=${Math.max(
      1,
      Number(page) || 1
    )}`,
    20000
  );
  if (!res.ok) return { ok: false, error: res.error || "Announcements unavailable", items: [] };
  const arr = res.data && Array.isArray(res.data.data) ? res.data.data : [];
  const items = arr.map((a) => {
    const by = a.createdBy || {};
    return {
      id: a._id,
      heading: (a.heading || a.announcement || "Update").trim(),
      message: (a.announcement || "").trim(),
      type: a.type || "",
      useCase: a.announcementUseCase || "",
      createdAt: a.scheduleTime || a.createdAt || "",
      author: [by.firstName, by.lastName].filter(Boolean).join(" ") || "PW Team",
      attachment: a.attachment
        ? {
            name: a.attachment.name || "Attachment",
            url: resolveAsset(a.attachment),
          }
        : null,
    };
  });
  return { ok: true, items };
}

/* ------------------------------------------------------------------ */
/* Schedule detail (notes / DPP links for one lecture)                 */
/* ------------------------------------------------------------------ */

export async function fetchSchedule(batchId, subjectSlug, contentId) {
  const res = await upstreamJson(
    `/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
      subjectSlug
    )}&ContentId=${encodeURIComponent(contentId)}`,
    25000
  );
  const d = res.ok && res.data && res.data.data;
  if (!d) return { ok: false, error: res.error || "Lecture not found", status: res.status };

  const docs = [];
  const seen = new Set();
  const pending = [];
  const push = (hw) => {
    for (const att of hw.attachmentIds || []) {
      const url = attachmentUrl(att);
      if (url) {
        if (seen.has(url)) continue;
        seen.add(url);
      }
      const doc = {
        id: att._id || hw._id,
        name: (att.name || hw.topic || "Document").trim(),
        topic: (hw.topic || "").trim(),
        note: hw.note || "",
        url: url || "",
        pdfId: d._id,
        attachmentId: att._id || "",
        attachment: att,
      };
      docs.push(doc);
      if (!url) pending.push(doc);
    }
  };
  for (const hw of d.homeworkIds || []) push(hw);
  if (d.dpp && Array.isArray(d.dpp.homeworkIds)) d.dpp.homeworkIds.forEach(push);

  // attachments without a storage key need a GetPdf round trip
  for (const doc of pending) {
    const url =
      (await resolvePdfUrl(batchId, subjectSlug, doc.pdfId, doc.attachmentId)) ||
      attachmentUrl(doc.attachment);
    if (url && !seen.has(url)) seen.add(url);
    doc.url = url;
  }
  // drop the raw upstream attachment and any doc that never resolved
  for (let i = docs.length - 1; i >= 0; i--) {
    delete docs[i].attachment;
    if (!docs[i].url) docs.splice(i, 1);
  }

  const vd = d.videoDetails || {};
  return {
    ok: true,
    lecture: {
      id: d._id || contentId,
      title: (vd.name || d.topic || "Lecture").trim(),
      description: stripHtml(vd.description),
      duration: vd.duration || "",
      thumbnail: vd.image || "",
      urlType: (d.urlType || "").toLowerCase(),
      videoUrl: vd.videoUrl || d.url || "",
      drm: Boolean(vd.drmProtected),
      date: d.startTime || d.date || "",
      topicInfo: (d.topicData || "").trim(),
      tags: Array.isArray(d.tags) ? d.tags : [],
    },
    docs,
  };
}

/* ------------------------------------------------------------------ */
/* PDF resolution                                                      */
/* ------------------------------------------------------------------ */

export async function resolvePdfUrl(batchId, subjectSlug, pdfId, attachmentId) {
  const res = await upstreamJson(
    `/GetPdf?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
      subjectSlug
    )}&PdfId=${encodeURIComponent(pdfId)}&AttachmentId=${encodeURIComponent(attachmentId)}`,
    20000
  );
  const d = res.ok && res.data && res.data.data;
  if (!d) return "";
  return attachmentUrl(d);
}

/* ------------------------------------------------------------------ */
/* Stream resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Public relays that return a freshly signed file for a PW video folder:
 *   key=720/main.m3u8 → signed HLS media playlist
 *   key=enc.key       → the 16-byte AES-128 key
 *   key=720/000.ts    → a signed (still encrypted) media segment
 *
 * They are tried in order because availability changes over time.
 */
const SIGNER_HOSTS = [
  "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
  `${UPSTREAM_BASE}/v1/videos/get-hls-key`,
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
];

/** Renditions to try, best first. Not every video has a 720p stream. */
const HLS_QUALITIES = ["720", "480", "360", "240"];

const TOKEN_SOURCES = [
  "https://vidcloud.eu.org/generate_token.php",
  "https://proxy.streamvideo.co.in/generate_token.php",
];

const FALLBACK_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";

let tokenCache = { token: "", expires: 0 };

export async function guestToken() {
  if (tokenCache.token && tokenCache.expires > Date.now()) return tokenCache.token;
  for (const src of TOKEN_SOURCES) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      let text = (await res.text()).trim();
      try {
        const j = JSON.parse(text);
        text = typeof j === "string" ? j : j.token || j.access_token || (j.data && (j.data.token || j.data.access_token)) || "";
      } catch {
        /* plain token */
      }
      text = text.replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
      if (text.length > 15 && !text.includes("<")) {
        tokenCache = { token: text, expires: Date.now() + 10 * 60 * 1000 };
        return text;
      }
    } catch {
      /* try next */
    }
  }
  return FALLBACK_TOKEN;
}

export function parseFolder(url) {
  if (!url) return "";
  const m = String(url).match(
    /(?:cloudfront\.net|pw\.live)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\//i
  );
  return m ? m[1] : "";
}

export function isSigned(url) {
  return !!url && url.includes("Signature=") && url.includes("Key-Pair-Id=");
}

export function kindOf(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".mpd")) return "dash";
  if (clean.endsWith(".m3u8")) return "hls";
  if (/\.(mp4|webm|m4v)$/.test(clean)) return "mp4";
  return "unknown";
}

/** `folder → { plan, expires }` — probing a folder is the slow part. */
const signCache = new Map();

/**
 * Resolve a playable stream plan for a lecture.
 *
 * PW publishes signed CloudFront URLs. When the URL still carries its
 * signature we can proxy the manifest and every segment through this app
 * (CloudFront sends no CORS headers, so the browser cannot fetch them
 * directly). When the signature is missing we ask the upstream signing
 * relay for freshly signed HLS playlists.
 */
export async function resolveStream({ rawUrl, folder: folderHint }) {
  const folder = folderHint || parseFolder(rawUrl);
  const kind = kindOf(rawUrl);

  if (isSigned(rawUrl)) {
    return {
      playable: true,
      kind: kind === "unknown" ? "dash" : kind,
      engine: kind === "hls" ? "hls" : "dash",
      url: `/api/stream?folder=${encodeURIComponent(folder)}&sig=${encodeURIComponent(
        rawUrl.slice(rawUrl.indexOf("?") + 1)
      )}&host=${encodeURIComponent(new URL(rawUrl).hostname)}&asset=master.${kind === "hls" ? "m3u8" : "mpd"}`,
      reason: "",
    };
  }

  if (folder) {
    const cached = signCache.get(folder);
    if (cached && cached.expires > Date.now()) return cached.plan;

    const token = await guestToken();

    for (const host of SIGNER_HOSTS) {
      // Quality levels differ per video, so ask for each rendition's master
      // playlist and take the first that the signer actually has.
      for (const quality of HLS_QUALITIES) {
        try {
          const probe = await fetch(
            `${host}?videoKey=${encodeURIComponent(folder)}&key=${quality}/main.m3u8`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                token,
                "client-type": "WEB",
                "client-version": "1.0.0",
                Accept: "*/*",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
              },
              redirect: "follow",
              signal: AbortSignal.timeout(12000),
            }
          );
          if (!probe.ok) continue;
          const text = await probe.text();
          if (!text.includes("#EXTM3U") && !text.includes("<MPD")) continue;

          const plan = {
            playable: true,
            kind: text.includes("<MPD") ? "dash" : "hls",
            engine: text.includes("<MPD") ? "dash" : "hls",
            quality,
            url: `/api/sign?host=${encodeURIComponent(host)}&videoKey=${encodeURIComponent(
              folder
            )}&key=${quality}/main.m3u8`,
            reason: "",
          };
          // A successful probe is worth caching: it is the expensive step.
          signCache.set(folder, { plan, expires: Date.now() + 10 * 60 * 1000 });
          return plan;
        } catch {
          /* next quality / host */
        }
      }
    }
  }

  return {
    playable: false,
    kind,
    engine: null,
    url: "",
    reason:
      "PW has not published a playable stream for this lecture. It is either an upcoming live class, a notes-only entry, or a video the source has not finished processing — try an older lecture from the same chapter.",
    sourceUrl: rawUrl || "",
  };
}

export { attachmentUrl, mapVideo, mapDoc };
