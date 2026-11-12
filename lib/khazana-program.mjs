/**
 * Khazana — the archive program inside a batch, and it is readable.
 *
 * ## What this replaces
 *
 * Two earlier attempts got this wrong, and the way they got it wrong is the
 * reason this file is written down in such detail:
 *
 *  - `v3/programs/*` answers 404. It does not exist. Every probe through v3 made
 *    Khazana look like paid content that "needs a subscriber token".
 *  - The **real** surface is `v1` and `v2`, and it needs only the guest
 *    credential this deployment already mints. Verified end to end against
 *    production on `khazanaProgramId: 697c6370cb722a4fac145ef1`:
 *
 *        GET /v1/programs/<program>/subjects?page=1
 *              → Physics, Chemistry, Biology, SST, Maths, Hindi, English,
 *                Computer, Sanskrit — with totalLectures per subject
 *        GET /v2/programs/<program>/subjects/<subjectId>/chapters?page=1&limit=10
 *              → chapters, each carrying its own `slug` and `isPurchased`
 *        GET /v1/programs/<program>/subjects/<subjectSlug>/chapters/<chapterSlug>/topics?page=1
 *              → topics
 *        GET /v1/programs/.../topics/<topicSlug>/contents/sub-topic?page=1
 *              → tabs: Lectures / Notes / Dpp's / Dpp's Sol
 *        GET /v2/programs/contents?programId=&subjectId=&chapterId=&topicId=&page=1
 *              → the actual lectures: `videoUrl` on CloudFront (`master.mpd`,
 *                `types: ["DASH","HLS"]`), plus notes PDFs
 *
 * That last call is what the player already knows how to open — `/api/hls`,
 * `/api/sign` and `lib/hls.mjs` all speak `master.mpd`. So Khazana lectures play
 * through the same path as every other lecture on the site.
 *
 * ## The one real constraint
 *
 * Some chapters come back `isPurchased: false` while their notes come back
 * `isPurchased: true`. That is PW's own entitlement flag, and it is reported —
 * never papered over. A lecture that the upstream marks as not purchased is
 * listed and labelled, because a reader who cannot play something still needs to
 * know it exists and why it will not open.
 */

import { upstreamJson } from "./upstream.mjs";

/** A Khazana program's subjects, with the lecture counts PW reports. */
export async function programSubjects(programId, opts = {}) {
  const id = String(programId || "").trim();
  if (!id) return { ok: false, state: "none", subjects: [] };

  const res = await upstreamJson(
    `/v1/programs/${encodeURIComponent(id)}/subjects?page=1`,
    { cacheSeconds: 300, timeout: 12000 }
  );
  const state = stateOf(res);
  if (state !== "ok") return { ok: false, state, subjects: [], status: res.status, error: res.error };

  const rows = arrayOf(res);
  return {
    ok: true,
    state: rows.length ? "ok" : "empty",
    subjects: rows
      .map((s) => ({
        id: s._id || "",
        name: String(s.name || "").trim(),
        // The *subject* slug, not the id: the topics call is slug-addressed.
        slug: s.slug || "",
        displayOrder: Number(s.displayOrder) || 999,
        lectures: Number(s.totalLectures) || 0,
        chapters: Number(s.totalChapters) || 0,
        topics: Number(s.totalTopics) || 0,
        image: s.backgroundImage || "",
      }))
      .filter((s) => s.id && s.name && s.slug)
      .sort((a, b) => a.displayOrder - b.displayOrder),
  };
}

/** The chapters of one subject in a Khazana program. */
export async function programChapters(programId, subjectId, opts = {}) {
  const res = await upstreamJson(
    `/v2/programs/${encodeURIComponent(programId)}/subjects/${encodeURIComponent(
      subjectId
    )}/chapters?page=1&limit=20`,
    { cacheSeconds: 300, timeout: 12000 }
  );
  const state = stateOf(res);
  if (state !== "ok") return { ok: false, state, chapters: [], status: res.status, error: res.error };

  const rows = arrayOf(res);
  return {
    ok: true,
    state: rows.length ? "ok" : "empty",
    chapters: rows
      .map((c) => ({
        id: c._id || "",
        name: String(c.name || "Chapter").trim(),
        slug: c.slug || "",
        description: String(c.description || "").trim(),
        displayOrder: Number(c.displayOrder) || 999,
        lectures: Number(c.totalLectures) || 0,
        topics: Number(c.totalTopics) || 0,
        // PW's own entitlement flag. Reported, not enforced by us.
        isPurchased: Boolean(c.isPurchased),
      }))
      .filter((c) => c.id && c.slug)
      .sort((a, b) => a.displayOrder - b.displayOrder),
  };
}

/** The topics of one chapter — the level that groups lectures and notes. */
export async function programTopics(programId, subjectSlug, chapterSlug, opts = {}) {
  const res = await upstreamJson(
    `/v1/programs/${encodeURIComponent(programId)}/subjects/${encodeURIComponent(
      subjectSlug
    )}/chapters/${encodeURIComponent(chapterSlug)}/topics?page=1`,
    { cacheSeconds: 300, timeout: 12000 }
  );
  const state = stateOf(res);
  if (state !== "ok") return { ok: false, state, topics: [], status: res.status, error: res.error };

  const rows = arrayOf(res);
  return {
    ok: true,
    state: rows.length ? "ok" : "empty",
    topics: rows
      .map((t) => ({
        id: t._id || "",
        name: String(t.name || "").trim(),
        slug: t.slug || "",
        displayOrder: Number(t.displayOrder) || 999,
        lectures: Number(t.totalLectures) || 0,
        notes: Number(t.totalConcepts) || 0,
      }))
      .filter((t) => t.id && t.slug)
      .sort((a, b) => a.displayOrder - b.displayOrder),
  };
}

/**
 * A topic's tabs — Lectures, Notes, Dpp's, Dpp's Sol.
 *
 * Fetched in one request, then narrowed per tab. The tab slugs are what the
 * contents call needs for the *other* listing shape, so they are kept.
 */
export async function topicSections(programId, subjectSlug, chapterSlug, topicSlug, opts = {}) {
  const res = await upstreamJson(
    `/v1/programs/${encodeURIComponent(programId)}/subjects/${encodeURIComponent(
      subjectSlug
    )}/chapters/${encodeURIComponent(chapterSlug)}/topics/${encodeURIComponent(
      topicSlug
    )}/contents/sub-topic?page=1`,
    { cacheSeconds: 300, timeout: 12000 }
  );
  const state = stateOf(res);
  if (state !== "ok") return { ok: false, state, sections: [], status: res.status, error: res.error };

  const rows = arrayOf(res);
  return {
    ok: true,
    state: rows.length ? "ok" : "empty",
    sections: rows
      .map((s) => ({
        name: String(s.name || "").trim(),
        slug: s.slug || "",
        lectures: Number(s.totalLectures) || 0,
        concepts: Number(s.totalConcepts) || 0,
        displayOrder: Number(s.displayOrder) || 999,
      }))
      .filter((s) => s.name)
      .sort((a, b) => a.displayOrder - b.displayOrder),
  };
}

/**
 * The lectures and notes inside one topic.
 *
 * Returns both kinds because the upstream returns both in one list: `Lecture`
 * rows carry `videoUrl`, `Concept` rows carry a `fileId` PDF. Splitting them
 * here means the player and the notes viewer each get a clean list.
 */
export async function topicContents(programId, subjectSlug, chapterSlug, topicSlug, page = 1, opts = {}) {
  const res = await upstreamJson(
    `/v2/programs/contents?programId=${encodeURIComponent(programId)}` +
      `&subjectId=${encodeURIComponent(subjectSlug)}` +
      `&chapterId=${encodeURIComponent(chapterSlug)}` +
      `&topicId=${encodeURIComponent(topicSlug)}&page=${Number(page) || 1}`,
    { cacheSeconds: 300, timeout: 15000 }
  );
  const state = stateOf(res);
  if (state !== "ok") return { ok: false, state, items: [], status: res.status, error: res.error };

  const rows = arrayOf(res);
  const items = rows.map(normaliseItem).filter((i) => i.title);
  return {
    ok: true,
    state: items.length ? "ok" : "empty",
    items,
    lectures: items.filter((i) => i.kind === "lecture"),
    notes: items.filter((i) => i.kind === "note"),
  };
}

/**
 * One upstream content row → the shape the site's player and viewer expect.
 *
 * `videoUrl` is carried through untouched: it is a CloudFront `master.mpd`,
 * which `/api/stream` and the HLS player already handle for normal lectures.
 * `isPurchased: false` is preserved rather than filtered, so the page can say
 * "PW marks this as not purchased" instead of silently hiding a lecture.
 */
function normaliseItem(row) {
  const inner = Array.isArray(row.content) && row.content[0] ? row.content[0] : {};
  const video = inner.videoDetails || {};
  const file = inner.fileId || {};
  const videoUrl = inner.videoUrl || video.videoUrl || "";
  const fileUrl = file && file.key ? `${file.baseUrl || "https://static.pw.live/"}${file.key}` : "";

  return {
    id: row._id || inner._id || "",
    title: String(row.title || inner.text || "").trim(),
    kind: videoUrl ? "lecture" : "note",
    type: row.type || "",
    videoUrl,
    videoType: inner.videoType || "",
    duration: video.duration || "",
    thumbnail: video.image || "",
    fileUrl,
    fileName: file.name || "",
    // PW's entitlement, reported as-is.
    isPurchased: row.isPurchased !== false,
    displayOrder: Number(row.displayOrder) || 999,
  };
}

/* --------------------------------------------------------------- helpers */

/** Classify an upstream answer, using the status `upstreamJson` now carries. */
function stateOf(res) {
  if (!res) return "error";
  if (res.ok) return "ok";
  const status = Number(res.status) || 0;
  if (status === 401 || status === 403) return "locked";
  if (status === 404) return "missing";
  if (status === 400) return "invalid";
  return "error";
}

/** The rows of an upstream list, however the envelope nests them. */
function arrayOf(res) {
  const body = res && res.data;
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

/**
 * What a Khazana entry point is, in one word a page can branch on.
 *
 * Kept out of the browser: the page must not have to know that "404 on v1" and
 * "404 on v2" mean different things.
 */
export function khazanaStateLabel(state) {
  return (
    {
      none: "This batch has no Khazana archive.",
      ok: "Khazana is readable.",
      empty: "The archive answered but holds nothing yet.",
      locked: "The upstream refused the credential.",
      missing: "The archive id is not a program the upstream serves.",
      invalid: "The archive id is malformed.",
      error: "The archive could not be reached.",
    }[state] || "Khazana status unknown."
  );
}
