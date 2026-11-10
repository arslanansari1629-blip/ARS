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
  throw new Error(lastError);
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

export function normalizeContents(json, contentType) {
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
        if (!url) continue;
        docs.push({
          id: att._id || hw._id,
          name: (att.name || hw.topic || "Document").trim(),
          topic: hw.topic || "",
          note: hw.note || "",
          url,
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

  if (isVideo) items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { success: true, items, contentType };
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

export function normalizeSchedule(json, contentId) {
  const d = json && json.data;
  if (!d) throw new Error("Lecture not found");
  const docs = [];
  const seen = new Set();
  const push = (hw) => {
    for (const att of hw.attachmentIds || []) {
      const url = asset(att);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      docs.push({
        id: att._id || hw._id,
        name: (att.name || hw.topic || "Document").trim(),
        topic: hw.topic || "",
        note: hw.note || "",
        url,
      });
    }
  };
  for (const hw of d.homeworkIds || []) push(hw);
  if (d.dpp && Array.isArray(d.dpp.homeworkIds)) d.dpp.homeworkIds.forEach(push);

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
