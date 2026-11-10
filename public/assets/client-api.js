/* =========================================================================
   Browser-side upstream access.

   Some networks block direct server → upstream calls (the API host rejects
   certain datacenter IPs). When that happens our API answers with
   `{ needsProxy: true }` and the browser fetches the same live PW JSON through
   a public CORS relay, normalising it exactly like the server does.
   Either way every value on screen comes from the live PW catalogue.
   ========================================================================= */

export const UPSTREAM = "https://www.learnxpw.site/api";

const RELAYS = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
];

export async function upstream(target) {
  const path = target.startsWith("http") ? target : `${UPSTREAM}${target}`;
  let lastError = "relay unreachable";
  for (const relay of RELAYS) {
    try {
      const res = await fetch(relay(path), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        lastError = `relay ${res.status}`;
        continue;
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        lastError = "relay returned non-JSON";
        continue;
      }
    } catch (err) {
      lastError = err.message;
    }
  }
  // Every relay failed. The raw cause is a browser string — "fetch failed",
  // "Failed to fetch", "relay 502" — which the chapter page would otherwise
  // render as its entire explanation of why a lecture list is missing. Say what
  // a student can act on instead.
  const err = new Error(
    /\b(5\d\d|429)\b|fetch|network|non-JSON|unreachable/i.test(lastError)
      ? "Physics Wallah did not answer for this chapter just now. The chapter and its lectures still exist — this is their server, not this site — so reload in a minute."
      : lastError
  );
  err.relayFailure = true;
  err.cause = lastError;
  throw err;
}

/* --------------------------- PDF key resolution --------------------------- */

/**
 * `attachmentId -> storage key`, for the browser-relay path.
 *
 * The server route resolves unkeyed attachments through `GetPdf` before it
 * answers (see `lib/api-data.mjs`). When the server cannot reach PW at all the
 * page falls back to this module and fetches the same JSON in the browser —
 * and that path used to skip `GetPdf` entirely, so every unkeyed Class Notes
 * attachment rendered as a dead link (`static.pw.live/<attachmentId>`). The
 * relay has to finish the job or the tab is wrong in a different way.
 *
 * Only successes are stored, for the same reason as the server: `GetPdf` is
 * rate-limited, and remembering "throttled once" as "never resolvable" is how
 * a whole tab stays empty for the rest of the session.
 */
const keyCache = new Map();

/** Ask PW for an attachment's storage key. `""` means it could not be had. */
async function pdfKey(batchId, subjectSlug, pdfId, attachmentId) {
  const cacheKey = `${pdfId}:${attachmentId}`;
  const known = keyCache.get(cacheKey);
  if (known) return known;
  if (!batchId || !subjectSlug || !pdfId || !attachmentId) return "";
  try {
    const json = await upstream(
      `/GetPdf?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
        subjectSlug
      )}&PdfId=${encodeURIComponent(pdfId)}&AttachmentId=${encodeURIComponent(attachmentId)}`
    );
    const d = json && json.data;
    const key = d && (d.key || d.path);
    if (key) keyCache.set(cacheKey, String(key));
    return key ? String(key) : "";
  } catch {
    // A relay failure here is not fatal: the rest of the tab still renders, and
    // the row says the file did not resolve instead of lying about it.
    return "";
  }
}

/**
 * Resolve the attachments that arrived without a storage key, three at a time.
 *
 * The cap matters as much as it does on the server: a 118-entry chapter asked
 * for all at once is throttled into returning nothing at all.
 */
async function resolveDocUrls(docs, batchId, subjectSlug) {
  const CONCURRENCY = 3;
  let cursor = 0;
  let failed = 0;
  async function worker() {
    while (cursor < docs.length) {
      const doc = docs[cursor++];
      const key = await pdfKey(batchId, subjectSlug, doc.pdfId, doc.attachmentId);
      if (key) {
        doc.url = `${ASSET_BASE}${String(key).replace(/^\/+/, "")}`;
        delete doc.pending;
      } else {
        failed++;
      }
    }
  }
  const start = Math.min(CONCURRENCY, docs.length);
  await Promise.all(Array.from({ length: start }, worker));
  return { needed: docs.length, failed };
}

/* ------------------------------ normalisers ------------------------------ */

const ASSET_BASE = "https://static.pw.live/";

export function asset(input) {
  if (!input) return "";
  if (typeof input === "string") {
    const v = input.trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    return `${ASSET_BASE}${v.replace(/^\/+/, "")}`;
  }
  const base = (input.baseUrl || ASSET_BASE).replace(/\/+$/, "");
  const rel = input.key || input.path;
  if (rel) return `${base}/${String(rel).replace(/^\/+/, "")}`;
  // An attachment that *carries* a `key` field but leaves it empty is PW saying
  // "this object has no storage key" — the file is only reachable through
  // `GetPdf`. Falling back to the attachment `_id` here invented a URL that
  // looks real (`static.pw.live/<id>`), so the row rendered a PDF link that
  // 403s and the file could never be resolved. Only descriptors that have no
  // key field at all (some cover images are addressed by id) may use `_id`.
  if ("key" in input || "path" in input) return "";
  if (input._id) return `${base}/${input._id}`;
  return "";
}

export function stripHtml(input) {
  if (!input || typeof input !== "string") return "";
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function batch(raw) {
  if (!raw || !raw._id) return null;
  return {
    id: raw._id,
    name: (raw.name || raw.batchName || "Untitled batch").trim(),
    byName: raw.byName || "",
    slug: raw.slug || "",
    language: raw.language || "",
    startDate: raw.startDate || "",
    endDate: raw.endDate || "",
    feeTotal: typeof raw.feeTotal === "number" ? raw.feeTotal : null,
    type: raw.type || "",
    image: asset(raw.previewImage) || raw.previewImageUrl || "",
  };
}

export function normalizeCatalog(json, page = 1) {
  return {
    success: true,
    page: (json && json.currentPage) || page,
    totalPages: (json && json.totalPages) || 1,
    total: (json && json.total) || ((json && json.batches) || []).length,
    batches: ((json && json.batches) || []).map(batch).filter(Boolean),
    source: "pw-arsvibe (browser relay)",
  };
}

export function normalizeSearch(json, page = 1) {
  const batches = ((json && json.batches) || []).map(batch).filter(Boolean);
  // `total` is the number of matches across the whole catalogue, which is not the
  // length of this list: the API caps a first page at 80 hits. Dropping it made
  // the page report "80 results" for a search that really had 143.
  return {
    success: true,
    batches,
    page: (json && json.page) || page,
    totalPages: (json && json.totalPages) || 1,
    total: typeof json?.total === "number" ? json.total : batches.length,
    unfilteredTotal: typeof json?.unfilteredTotal === "number" ? json.unfilteredTotal : undefined,
  };
}

export function normalizeBatch(json, id) {
  const d = json && json.data;
  if (!d) throw new Error("Batch not found");
  const card = (d.config && d.config.card) || {};
  return {
    success: true,
    batch: {
      id: d._id || id,
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
      image: asset(d.previewImage) || d.previewImageUrl || "",
      banners: (card.files || []).map((f) => f && f.url).filter(Boolean),
      isFree: !d.feeTotal,
    },
    subjects: (Array.isArray(d.subjects) ? d.subjects : [])
      .map((s) => ({
        id: s._id || "",
        subjectId: s.subjectId || "",
        name: (s.subject || "Subject").trim(),
        slug: s.slug || s.subjectId || "",
        lectureCount: Number(s.lectureCount || 0),
        tagCount: Number(s.tagCount || 0),
        displayOrder: Number.isFinite(s.displayOrder) ? s.displayOrder : 999,
        image: asset(s.imageId),
      }))
      .filter((s) => s.slug && s.name)
      .sort((a, b) => a.displayOrder - b.displayOrder),
  };
}

export function normalizeChapters(json) {
  const arr = (json && json.data) || [];
  return {
    success: true,
    chapters: arr
      .map((c) => ({
        id: c._id,
        name: (c.name || "Chapter").trim(),
        videos: Math.max(Number(c.videos || 0), Number(c.lectureVideos || 0)),
        notes: Number(c.notes || 0),
        exercises: Number(c.exercises || 0),
        displayOrder: Number.isFinite(c.displayOrder) ? c.displayOrder : 999,
      }))
      .sort((a, b) => a.displayOrder - b.displayOrder),
  };
}

export async function normalizeContents(json, contentType, batchId = "", subjectSlug = "") {
  const arr = (json && json.data) || [];
  const isVideo = contentType === "videos" || contentType === "DppVideos";

  const items = arr.map((item) => {
    if (isVideo) {
      const vd = item.videoDetails || {};
      return {
        id: item._id,
        kind: "video",
        title: (vd.name || item.topic || "Lecture").trim(),
        thumbnail: vd.image || "",
        duration: vd.duration || "",
        date: item.startTime || item.date || "",
        lectureType: item.lectureType || "",
      };
    }
    const docs = [];
    const push = (hw) => {
      for (const att of hw.attachmentIds || []) {
        const url = asset(att);
        // An attachment with no key and no URL is not a missing document — it
        // is one whose key only `GetPdf` can name. Keep it (with `pending`) so
        // the resolver below can fill `url` in; dropping it here is what made
        // the relay render a shorter notes list than the chapter really has.
        if (!url && !att._id) continue;
        docs.push({
          id: att._id || hw._id,
          name: (att.name || hw.topic || "Document").trim(),
          topic: hw.topic || "",
          note: hw.note || "",
          url,
          pdfId: item._id,
          attachmentId: att._id || "",
          ...(url ? {} : { pending: true }),
        });
      }
    };
    for (const hw of item.homeworkIds || []) push(hw);
    if (item.dpp && Array.isArray(item.dpp.homeworkIds)) item.dpp.homeworkIds.forEach(push);

    return {
      id: item._id,
      kind: contentType === "DppNotes" ? "dpp" : "notes",
      title: (item.topic || (docs[0] && docs[0].name) || "Document").trim(),
      date: item.startTime || item.date || "",
      docs,
    };
  });

  if (isVideo) {
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return { success: true, items, contentType };
  }

  // Same contract the server route answers with, so the chapter page can report
  // an incomplete tab identically whichever path produced it.
  const pending = items.flatMap((it) => (it.docs || []).filter((d) => d.pending));
  const diagnostics = { listed: items.length, attachments: pending.length, needed: pending.length, failed: 0 };
  if (pending.length) {
    const { failed } = await resolveDocUrls(pending, batchId, subjectSlug);
    diagnostics.failed = failed;
    // A row whose only attachment never resolved would render "No file
    // attached", which is a claim about the chapter rather than about the
    // lookup. Drop those rows and let `failed` say why the list is short.
    for (const it of items) {
      it.docs = (it.docs || []).filter((d) => d.url);
    }
  }
  for (const it of items) for (const d of it.docs || []) delete d.pending;
  return { success: true, items, contentType, diagnostics };
}

export function normalizeAnnouncements(json) {
  const arr = (json && json.data) || [];
  return {
    success: true,
    items: arr.map((a) => {
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
          ? { name: a.attachment.name || "Attachment", url: asset(a.attachment) }
          : null,
      };
    }),
  };
}

export async function normalizeSchedule(json, contentId, batchId = "", subjectSlug = "") {
  const d = json && json.data;
  if (!d) throw new Error("Lecture not found");
  const docs = [];
  const seen = new Set();
  const pending = [];
  const push = (hw) => {
    for (const att of hw.attachmentIds || []) {
      const url = asset(att);
      if (url) {
        if (seen.has(url)) continue;
        seen.add(url);
      }
      const doc = {
        id: att._id || hw._id,
        name: (att.name || hw.topic || "Document").trim(),
        topic: hw.topic || "",
        note: hw.note || "",
        url,
        pdfId: d._id,
        attachmentId: att._id || "",
      };
      docs.push(doc);
      // Attachments arrive without a key; the lecture page must not show them
      // as downloadable until `GetPdf` has named one.
      if (!url) pending.push(doc);
    }
  };
  for (const hw of d.homeworkIds || []) push(hw);
  if (d.dpp && Array.isArray(d.dpp.homeworkIds)) d.dpp.homeworkIds.forEach(push);

  if (pending.length) await resolveDocUrls(pending, batchId, subjectSlug);
  // A file that did not resolve is not a file with a dead link.
  for (let i = docs.length - 1; i >= 0; i--) if (!docs[i].url) docs.splice(i, 1);

  const vd = d.videoDetails || {};
  return {
    success: true,
    lecture: {
      id: d._id || contentId,
      title: (vd.name || d.topic || "Lecture").trim(),
      description: stripHtml(vd.description),
      duration: vd.duration || "",
      thumbnail: vd.image || "",
      videoUrl: vd.videoUrl || d.url || "",
      drm: Boolean(vd.drmProtected),
      date: d.startTime || d.date || "",
      topicInfo: (d.topicData || "").trim(),
      tags: Array.isArray(d.tags) ? d.tags : [],
    },
    docs,
  };
}
