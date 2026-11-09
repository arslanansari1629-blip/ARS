/**
 * Normalised data access for the PW catalogue.
 *
 * Every function here performs a live request against the upstream API used by
 * the ArsVibe PW site — no data is baked into this repository.
 */

import {
  upstreamJson,
  resolveAsset,
  stripHtml,
  normalizeBatch,
  UPSTREAM_BASE,
} from "./upstream.mjs";
import { localBatch } from "./catalog.mjs";
import { pwHeaders } from "./pw-auth.mjs";
import { rankSigners, recordSignerResult, registerCaches } from "./selfheal.mjs";

/**
 * Headers for the `get-hls-key` signer relays.
 *
 * They accept the guest token either as a bearer or as a bare `token` header,
 * and answer 401 to a request that does not carry the client identity, so the
 * full PW header set is sent. Shared with `/api/pw` and `/api/sign` so all
 * three cannot drift apart.
 */
export function signerHeaders(token) {
  return pwHeaders(token, { "client-version": "1.0.0" });
}

const PAGE_LIMIT = 12;

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export async function fetchCatalogPage(page = 1) {
  const p = Math.max(1, Number(page) || 1);
  // The catalogue is paginated upstream; the mirror hubs simply walk the same
  // pages, which is why this is exposed as an explicit `page` parameter.
  const res = await upstreamJson(`/AllBatches?page=${p}`, { cacheSeconds: 300 });
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
    source: "pw-arsvibe",
  };
}

export async function searchCatalog(name, limit = PAGE_LIMIT) {
  const q = String(name || "").trim();
  if (!q) return { ok: true, batches: [], total: 0 };
  const res = await upstreamJson(`/searchBatch?name=${encodeURIComponent(q)}`, {
    cacheSeconds: 120,
  });
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
  // `25000` was passed as the timeout argument; use the options object so the
  // TTL can be set too (the signature is (path, opts)).
  // 9 s, not 25: `fetchBatch` already degrades gracefully to the shipped
  // catalogue row when the detail call fails, and a batch page that shows its
  // hero (with a Retry for the subject list) after nine seconds is immeasurably
  // better than a blank page for twenty-five.
  //
  // Two spellings of the same resource. `/BatchInfo?...&Type=details` is the
  // legacy route, and it is gone: the current upstream answers it with a 404
  // (`MONGOOSE_UPGRADE_ERROR`), which used to leave every batch page showing
  // "no subjects" while the data sat one URL away. `/v3/batches/<id>/details`
  // is the route the current web client itself calls. Legacy is still tried
  // second, for the mirror hosts that never migrated.
  const legacy = await upstreamJson(
    `/BatchInfo?BatchId=${encodeURIComponent(batchId)}&Type=details`,
    { timeout: 9000, cacheSeconds: 300 }
  );
  let res = legacy;
  let d = legacy.ok && legacy.data && legacy.data.data;

  if (!d) {
    const modern = await upstreamJson(`/v3/batches/${encodeURIComponent(batchId)}/details`, {
      timeout: 9000,
      cacheSeconds: 300,
    });
    const md = modern.ok && modern.data && (modern.data.data || modern.data);
    // The v3 body carries the subject list as `subjects`; anything else is not
    // a shape this code understands, so it does not count as an answer.
    if (md && (Array.isArray(md.subjects) || md.name || md.batchName)) {
      res = modern;
      d = md;
    }
  }
  if (!d) {
    // The detail endpoint can rate-limit a datacenter IP. A batch that is in the
    // shipped catalogue still deserves a page, so answer with the header data we
    // already have and say plainly that the subject list is unavailable.
    const local = await localBatch(batchId).catch(() => null);
    if (local) {
      return {
        ok: true,
        degraded: true,
        batch: {
          ...local,
          description: "",
          shortDescription: "",
          exam: [],
          className: "",
          sellingPrice: null,
          discount: null,
          banners: [],
          examTarget: "",
          target: "",
          isFree: !local.feeTotal,
        },
        subjects: [],
        reason: res.error || "Batch details are temporarily unavailable",
      };
    }
    return { ok: false, error: res.error || "Batch not found", status: res.status };
  }

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

  // `/BatchInfo` does not return `feeTotal`, which made `isFree: !d.feeTotal`
  // true for every batch on the site — a ₹1,999 batch wore a "Free" pill. The
  // shipped catalogue does carry the fee, so it wins whenever upstream is
  // silent. (The header route reads the same field, so both renders agree.)
  const catalogueRow = await localBatch(batchId).catch(() => null);
  const fee = typeof d.feeTotal === "number" ? d.feeTotal : catalogueRow ? catalogueRow.feeTotal : null;
  const price = typeof fee === "number" ? fee : null;

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
      price,
      sellingPrice:
        d.config && typeof d.config.sellingPrice === "number" ? d.config.sellingPrice : null,
      discount: d.config && typeof d.config.discount === "number" ? d.config.discount : null,
      image: preview,
      banners: (card.files || []).map((f) => f && f.url).filter(Boolean),
      examTarget: card.examTarget || "",
      target: card.target || "",
      isFree: !price,
    },
    subjects,
  };
}

/**
 * The batch hero, from the shipped catalogue only.
 *
 * `/BatchInfo` is the slow call: a cold datacenter IP can wait seconds for it,
 * and the batch page used to paint nothing at all until it answered. The
 * catalogue row already carries the name, faculty line, language, dates, price
 * and cover image — everything the hero shows — so the page asks for that
 * first (one indexed lookup, tens of milliseconds) and lets the subject list
 * arrive separately. `subjects` is `null` rather than `[]` so the client can
 * tell "not asked yet" apart from "there are none".
 */
export async function fetchBatchHeader(batchId) {
  const local = await localBatch(batchId).catch(() => null);
  if (!local) return null;
  return {
    ok: true,
    header: true,
    batch: {
      ...local,
      description: "",
      shortDescription: "",
      exam: [],
      className: "",
      sellingPrice: null,
      discount: null,
      banners: [],
      examTarget: "",
      target: "",
      isFree: !local.feeTotal,
    },
    subjects: null,
  };
}

/* ------------------------------------------------------------------ */
/* Chapters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Turn an upstream error string into something a student can act on.
 *
 * "upstream 401; upstream 404" is accurate and useless: it describes two failed
 * requests rather than the one fact that matters — the PW API now answers the
 * content listings only for a signed-in account, so the catalogue is browsable
 * but the lectures under it are not. Saying that plainly is better than a
 * generic failure, and it stops the emptiness reading as a bug in this site.
 */
function explainUpstream(error) {
  if (/\b401\b|\b403\b|unauthoris|unauthoriz/i.test(error)) {
    return "Physics Wallah is not serving this content to guest sessions right now. The catalogue and batch pages still work; the lectures under a chapter need a signed-in PW account, which this site does not have.";
  }
  if (/\b404\b/.test(error)) {
    return "Physics Wallah no longer serves this section at the address the catalogue points to.";
  }
  return error;
}

export async function fetchChapters(batchId, subjectSlug, maxPages = 8) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await upstreamJson(
      `/SubjectInfo?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
        subjectSlug
      )}&page=${page}`,
      { cacheSeconds: 300 },
      20000
    );
    if (!res.ok) {
      if (page === 1) {
        return {
          ok: false,
          error: explainUpstream(res.error || "Chapters unavailable"),
          auth: /\b401\b|\b403\b|unauthoris|unauthoriz/i.test(res.error || ""),
          chapters: [],
        };
      }
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
  const report = { needed: pending.length, failed: 0, firstError: "" };
  if (!pending.length) return report;

  // The API rate-limits a burst. Asking for eight attachments at once across a
  // twenty-item page turned every lookup into a failure — a whole notes tab came
  // back empty — while a single lookup answered instantly. Three at a time is
  // still fast enough for a page and stays under the limit.
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const doc = pending[cursor++];
      const key = `${doc.pdfId}:${doc.attachmentId}`;
      let url = pdfUrlCache.get(key);
      if (url === undefined) {
        const res = await resolvePdfUrl(batchId, subjectSlug, doc.pdfId, doc.attachmentId);
        url = res.url;
        if (url) pdfUrlCache.set(key, url);
        else {
          report.failed++;
          if (!report.firstError) report.firstError = res.error || "no url returned";
        }
      }
      if (url) doc.url = url;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  return report;
}

/** Content types that the subject listing can filter by chapter (`tag`). */
const CHAPTER_CONTENT_TYPES = new Set(["videos", "notes", "DppNotes", "DppVideos", "exercises"]);

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

  // The API moved on from the legacy `/TopicInfo?...&TopicId=` listing, which now
  // answers 404. What the current deployment serves — and what the site itself
  // renders — is the subject contents listing filtered by `tag` (the chapter id).
  // Ask for that first and fall back to the legacy spelling for mirrors that
  // still have it, so a chapter either lists fully or explains why it did not.
  const tag = CHAPTER_CONTENT_TYPES.has(contentType) ? `&tag=${encodeURIComponent(topicId)}` : "";
  const modern = (page) =>
    `/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(
      subjectSlug
    )}/contents?page=${page}&contentType=${encodeURIComponent(contentType)}${tag}`;
  const legacy = (page) =>
    `/TopicInfo?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
      subjectSlug
    )}&TopicId=${encodeURIComponent(topicId)}&ContentType=${contentType}&page=${page}`;

  const items = [];
  let route = modern;
  let firstError = "";
  for (let page = 1; page <= maxPages; page++) {
    let res = await upstreamJson(route(page), { cacheSeconds: 180, timeout: 20000 });
    if (!res.ok && route === modern) {
      // One retry on the other generation of the route, then give up on the
      // chapter rather than silently returning an empty list.
      firstError = res.error || `status ${res.status}`;
      route = legacy;
      res = await upstreamJson(route(page), { cacheSeconds: 180, timeout: 20000 });
    }
    if (!res.ok) {
      if (page === 1) {
        const combined = firstError
          ? `${firstError}; ${res.error || `status ${res.status}`}`
          : res.error || "Contents unavailable";
        return {
          ok: false,
          error: explainUpstream(combined),
          // `auth` lets a caller distinguish "the upstream will not serve this
          // to a guest" from "this chapter is genuinely empty". The two used to
          // look identical on screen.
          auth: /\b401\b|\b403\b|unauthoris|unauthoriz/i.test(combined),
          items: [],
          contentType,
        };
      }
      break;
    }
    const arr = res.data && Array.isArray(res.data.data) ? res.data.data : [];
    if (!arr.length) break;
    for (const item of arr) {
      // The subject listing returns every item type; a topic page must only show
      // the kind that was asked for.
      if (contentType === "videos" || contentType === "DppVideos") {
        if (item.isVideoLecture === false || (item.videoDetails && item.docs && !item.videoDetails._id)) continue;
        items.push(mapVideo(item));
      } else {
        items.push(mapDoc(item, contentType));
      }
    }
    if (arr.length < 20) break;
  }

  // newest first — matches how the source lists lectures
  if (contentType === "videos" || contentType === "DppVideos") {
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  } else {
    // notes/DPP attachments arrive without a storage key — resolve them
    const docs = items.flatMap((it) => it.docs || []);
    const lookup = await resolvePendingDocs(docs, batchId, subjectSlug);
    // drop entries whose every attachment failed to resolve
    items.forEach((it) => {
      it.docs = (it.docs || []).filter((d) => d.url);
    });
    // Keep the counts in the answer: "the notes tab is empty" is otherwise
    // indistinguishable from "the listing had no attachments" and
    // "the attachment lookup failed", and those need different fixes.
    return {
      ok: true,
      items,
      contentType,
      diagnostics: { listed: items.length, attachments: docs.length, ...lookup },
    };
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
  // Two generations of the same route, and they do not carry the same fields.
  //
  //   /v1/batches/<b>/subject/<s>/schedule/<id>/schedule-details
  //       → current shape, homework, tags … but videoDetails.videoUrl is empty
  //   /Schedule?BatchId=…&SubjectId=…&ContentId=…
  //       → 404 on api.penpencil.co, and on the vidcloud mirror it returns the
  //         real videoDetails.videoUrl (a signed CloudFront master.mpd)
  //
  // Taking the "modern" one first silently dropped the stream URL and made every
  // lecture look unpublished, so ask both and prefer whichever actually carries a
  // stream. The other one still supplies metadata when a video is missing.
  const modern = `/v1/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(
    subjectSlug
  )}/schedule/${encodeURIComponent(contentId)}/schedule-details`;
  const legacy = `/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
    subjectSlug
  )}&ContentId=${encodeURIComponent(contentId)}`;

  const [modernRes, legacyRes] = await Promise.all([
    upstreamJson(modern, 25000),
    upstreamJson(legacy, 25000),
  ]);

  const pick = (res) => (res && res.ok && res.data && res.data.data) || null;
  const candidates = [pick(legacyRes), pick(modernRes)].filter(Boolean);
  const hasStream = (d) =>
    Boolean((d.videoDetails && d.videoDetails.videoUrl) || d.url);

  let res = legacyRes;
  let d = null;
  for (const candidate of candidates) {
    if (hasStream(candidate)) {
      d = candidate;
      break;
    }
  }
  if (!d) {
    // No stream anywhere: keep whichever record has more to say (the modern one
    // usually carries the title, teacher and topic info).
    d = candidates[0] || null;
  }
  if (!d) {
    const why = [modernRes, legacyRes]
      .map((r) => (r.ok ? "" : r.error || `status ${r.status}`))
      .filter(Boolean)
      .join("; ");
    return { ok: false, error: why || "Lecture not found", status: res.status || 0 };
  }

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
      (await resolvePdfUrl(batchId, subjectSlug, doc.pdfId, doc.attachmentId)).url ||
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
      videoStatus: vd.status || d.status || "",
      isVideoLecture: d.isVideoLecture !== false,
      drm: Boolean(vd.drmProtected || d.isDrmEnabled),
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
    { timeout: 20000 }
  );
  const d = res.ok && res.data && res.data.data;
  if (!d) return { url: "", error: res.error || "GetPdf returned nothing" };
  const url = attachmentUrl(d);
  return { url, error: url ? "" : "GetPdf returned no storage key" };
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
  "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
  // Only an explicit absolute base can serve as a signer; the default in-process
  // dispatcher is not a URL, and interpolating it produced "pw/v1/videos/…".
  ...(UPSTREAM_BASE.startsWith("http") ? [`${UPSTREAM_BASE}/v1/videos/get-hls-key`] : []),
];

/** Renditions to try, best first. Not every video has a 720p stream. */
const HLS_QUALITIES = ["1080", "720", "480", "360", "240"];

/**
 * Announce the renditions that exist as a real HLS master playlist.
 *
 * The signing relay stores one rendition per video, not a master playlist —
 * asking it for `master.m3u8` is a 404. Resolution therefore used to stop at the
 * first rendition that answered and hand the player a single media playlist.
 * hls.js saw exactly one level, so the player's quality picker had nothing to
 * switch between and silently did nothing: the *server* had chosen the quality.
 *
 * This builds the master playlist the player needs from the renditions that were
 * verified to exist. Bandwidth is only used by hls.js to order and label levels —
 * every `URI` points back at `/api/sign`, which relays the real bytes — so a
 * nominal value per rendition is honest here and avoids downloading every
 * variant just to measure it.
 */
export function masterPlaylist(renditions) {
  const RESOLUTION = {
    "1080": [1920, 1080],
    "720": [1280, 720],
    "480": [854, 480],
    "360": [640, 360],
    "240": [426, 240],
  };
  // Lowest first: players treat the last entry as the best available level.
  const ordered = [...renditions]
    .filter((q) => q && q.main)
    .sort((a, b) => Number(a.quality) - Number(b.quality));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const r of ordered) {
    const [w, h] = RESOLUTION[r.quality] || [0, Number(r.quality) || 0];
    const kbps = Math.round((Number(r.quality) || 240) * 1.1);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${kbps * 1000},AVERAGE-BANDWIDTH=${kbps * 1000},RESOLUTION=${w}x${h}`);
    lines.push(r.main);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The rendition paths that answered for a folder, best first.
 *
 * `probeRenditions` walks the signer ladder once and returns *all* hits rather
 * than just the best one, which is what lets the player offer a quality choice.
 * A failure to reach any rendition is reported as `[]`, never thrown: a lecture
 * with no stream is a normal state the caller explains.
 *
 * @param {object} opts
 * @param {string} opts.folder      PW video folder (the signer's `videoKey`)
 * @param {Function} [opts.probe]   override used by tests
 * @returns {Promise<{renditions: Array<{quality: string, main: string}>, token: string}>}
 */
export async function probeRenditions({ folder, probe }) {
  if (!folder) return { renditions: [], token: "" };
  const cached = renditionCache.get(folder);
  if (!probe && cached && cached.expires > Date.now()) {
    return { renditions: cached.renditions, token: lastSignerToken };
  }
  const doProbe = probe || defaultRenditionProbe;
  const renditions = await doProbe(folder);
  // The player asks for the manifest on every load, and a lecture page reload is
  // common; re-walking 15 upstream requests each time would add seconds to start.
  if (renditions.length) {
    renditionCache.set(folder, { renditions, expires: Date.now() + 10 * 60 * 1000 });
  }
  return { renditions, token: lastSignerToken };
}

/** The token used by the most recent successful probe, reused by `/api/sign`. */
let lastSignerToken = "";

/** folder → { renditions, expires }. Same ten-minute window as `signCache`. */
const renditionCache = new Map();

// The healer may drop these when they are provably stale (see lib/selfheal.mjs).
// They are registered here, not imported there, so the dependency stays one-way.
registerCaches({ renditions: renditionCache });

/**
 * Ask every signer host for every rendition and keep the ones that answered.
 *
 * Hosts and renditions are both walked exhaustively because availability differs
 * per host (`studyspark` is regularly 403 while `vidcloud` is fine) and per video
 * (renamed renditions, unprocessed 1080p encodes). Probing stops early only when
 * a *single* host has already produced every rendition we could ever need.
 */
async function defaultRenditionProbe(folder) {
  const found = new Map();
  let token = "";
  try {
    token = await guestToken();
  } catch {
    /* signer may still accept an anonymous request */
  }
  lastSignerToken = token;

  // Every host × rendition pair is independent, so ask them all at once: this is
  // one round trip (~1 s) instead of up to fifteen sequential ones (~15 s), and
  // the player waits for this before it can show a manifest.
  // Ask the healthy hosts first. The list is *ordered*, not filtered: a host the
  // healer has quarantined is still tried last, because a slow answer beats none.
  const pairs = HLS_QUALITIES.flatMap((quality) =>
    rankSigners(SIGNER_HOSTS).map((host) => ({ quality, host }))
  );

  await Promise.all(
    pairs.map(async ({ quality, host }) => {
      try {
        const probe = await fetch(
          `${host}?videoKey=${encodeURIComponent(folder)}&key=${quality}/main.m3u8`,
          {
            headers: signerHeaders(token),
            redirect: "follow",
            signal: AbortSignal.timeout(9000),
          }
        );
        if (!probe.ok) {
          recordSignerResult(host, false, { status: probe.status });
          return;
        }
        const text = await probe.text();
        if (!text.includes("#EXTM3U") && !text.includes("<MPD")) return;
        // A DASH body means this rendition is not relayable through `/api/sign`
        // (it only stores HLS), so it must not be advertised as an HLS level.
        if (text.includes("<MPD")) return;
        recordSignerResult(host, true);
        // Whichever host answered first wins for this rendition.
        if (found.has(quality)) return;
        found.set(quality, {
          quality,
          main: `/api/sign?host=${encodeURIComponent(host)}&videoKey=${encodeURIComponent(
            folder
          )}&key=${quality}/main.m3u8`,
          host,
        });
      } catch {
        /* this pair is simply unavailable */
      }
    })
  );

  return HLS_QUALITIES.filter((q) => found.has(q)).map((q) => found.get(q));
}

/* Credential handling lives in `lib/pw-auth.mjs` so the proxy, the signer route
 * and this resolver all resolve the *same* token instead of drifting apart. */
import { guestToken } from "./pw-auth.mjs";
export { guestToken };

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
  if (/youtu\.be|youtube\.com|youtube-nocookie\.com/.test(clean)) return "youtube";
  if (/vimeo\.com/.test(clean)) return "vimeo";
  return "unknown";
}

/**
 * Pull the id out of any YouTube URL shape PW publishes.
 *
 * Not every lecture is a CloudFront VOD — some batches (notably the PW Skills
 * courses) host the recording on YouTube, and `videoDetails.videoUrl` is then a
 * plain watch/short/embed link. Those used to fall through to "PW has not
 * published a video", which is simply false.
 */
export function youtubeId(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  // Already a bare id.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m =
    // youtu.be/<id>
    s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    // /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>
    s.match(/youtube(?:-nocookie)?\.com\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/) ||
    // watch?v=<id>
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

/** Vimeo ids are all digits. */
export function vimeoId(url) {
  const m = String(url || "").match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : "";
}

/** `folder → { plan, expires }` — probing a folder is the slow part. */
const signCache = new Map();
registerCaches({ plans: signCache });

/**
 * Resolve a playable stream plan for a lecture.
 *
 * PW publishes signed CloudFront URLs. When the URL still carries its
 * signature we can proxy the manifest and every segment through this app
 * (CloudFront sends no CORS headers, so the browser cannot fetch them
 * directly). When the signature is missing we ask the upstream signing
 * relay for freshly signed HLS playlists.
 */
export async function resolveStream({ rawUrl, folder: folderHint, fresh = false }) {
  const folder = folderHint || parseFolder(rawUrl);
  const kind = kindOf(rawUrl);

  // Not every lecture is a PW CloudFront VOD. The Skills batches (and a few
  // others) publish the recording as a plain YouTube/Vimeo link, which the
  // player embeds directly. Saying "PW has not published a video" about a
  // lecture that obviously has a video was the most confusing failure we had.
  if (kind === "youtube" || kind === "vimeo") {
    const id = kind === "youtube" ? youtubeId(rawUrl) : vimeoId(rawUrl);
    if (id) {
      return {
        playable: true,
        kind,
        engine: "embed",
        embed: kind === "youtube" ? `https://www.youtube-nocookie.com/embed/${id}` : `https://player.vimeo.com/video/${id}`,
        videoId: id,
        url: rawUrl,
        reason: "",
      };
    }
  }

  if (isSigned(rawUrl)) {
    return {
      playable: true,
      kind: kind === "unknown" ? "dash" : kind,
      engine: kind === "hls" ? "hls" : "dash",
      // The media gateway is `/api/hls`, not `/api/stream`: this used to point the
      // player at the resolver route, which answers with JSON, so every lecture
      // whose schedule already carried a signed URL failed to play.
      url: `/api/hls?folder=${encodeURIComponent(folder)}&sig=${encodeURIComponent(
        rawUrl.slice(rawUrl.indexOf("?") + 1)
      )}&host=${encodeURIComponent(new URL(rawUrl).hostname)}&asset=${kind === "hls" ? "master.m3u8" : "master.mpd"}`,
      reason: "",
    };
  }

  if (folder) {
    const cached = signCache.get(folder);
    // `fresh` skips the cache: a retry exists precisely because the cached plan
    // (and the signer host it points at) stopped working.
    if (!fresh && cached && cached.expires > Date.now()) return cached.plan;
    if (fresh) signCache.delete(folder);

    // Collect *every* rendition that answers, not just the best one, so the
    // player can offer a real quality choice (see `masterPlaylist`).
    const { renditions } = await probeRenditions({ folder });

    if (renditions.length) {
      const best = renditions[0];
      const plan = {
        playable: true,
        kind: "hls",
        engine: "hls",
        quality: best.quality,
        // The player loads a master playlist so hls.js exposes one level per
        // rendition; requesting a rendition path directly would pin playback to
        // that single quality forever. That master is built by our own relay:
        // the signer only stores `720/main.m3u8`-style playlists and answers 403
        // to `master.m3u8`, which is exactly how playback died — the plan looked
        // perfect and the manifest request was a 403.
        url: `/api/sign?videoKey=${encodeURIComponent(folder)}&key=master.m3u8&renditions=${encodeURIComponent(
          renditions.map((r) => r.quality).join(",")
        )}`,
        renditions: renditions.map((r) => r.quality),
        reason: "",
      };
      // A successful probe is worth caching: it is the expensive step.
      signCache.set(folder, { plan, expires: Date.now() + 10 * 60 * 1000 });
      return plan;
    }
  }

  // A URL we recognise but cannot relay (an unknown host, or a YouTube link
  // whose id would not parse) must not be reported as "not published" — the
  // video plainly exists. Say what actually happened and offer the direct link.
  // No PW folder in the URL and no signature → this is not a PW CDN asset at
  // all (an mp4 on some other host, a playlist we do not recognise). It exists;
  // it just cannot be relayed through this site.
  const unrecognised = Boolean(rawUrl) && !folder && !isSigned(rawUrl);
  return {
    playable: false,
    kind: unrecognised ? "external" : kind,
    engine: null,
    url: "",
    reason: unrecognised
      ? "This lecture is hosted outside the PW CDN, so it cannot be relayed here. Use the source player link to watch it."
      : "PW has not published a playable stream for this lecture. It is either an upcoming live class, a notes-only entry, or a video the source has not finished processing — try an older lecture from the same chapter.",
    external: unrecognised ? rawUrl : "",
    sourceUrl: rawUrl || "",
  };
}

export { attachmentUrl, mapVideo, mapDoc };
