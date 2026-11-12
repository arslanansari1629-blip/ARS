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

/**
 * Is this program an *archive* rather than a course?
 *
 * PW uses "program" for two different things, and the difference only shows up
 * one level down:
 *
 *  - a **course** program — "Udaan English Khazana 2027" — whose subjects are
 *    Physics, Chemistry, Biology…
 *  - an **archive** program — the one attached to "Power Batch : 11th Khazana
 *    JEE" — whose subjects are *Complete Physics - 11th*, *Complete Chemistry*…
 *    and whose chapters are the same chapter from every past batch ("Physics
 *    by" × 30, Arjuna JEE 2021–2026).
 *
 * Both are readable, but an archive needs its *chapters* opened before it looks
 * like anything a student recognises. This tells the page which it is holding.
 */
export async function programShape(programId) {
  const out = await programSubjects(programId);
  if (!out.ok) return { ...out, kind: "none" };

  // A course names its subjects after subjects. An archive names them after
  // collections — "Complete Physics", "Complete Mathematics" — or groups them by
  // class year. Two signals, either is enough.
  const names = out.subjects.map((s) => s.name.toLowerCase());
  const looksLikeArchive =
    names.some((n) => /\b(complete|archive|all|full)\b/.test(n)) ||
    out.subjects.reduce((n, s) => n + (s.chapters || 0), 0) > out.subjects.length * 8;

  return { ...out, kind: looksLikeArchive ? "archive" : "course" };
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
    // The subject's own count is the honest denominator: if it says 40 and the
    // list holds 30, the page can say "showing 30 of 40" instead of implying the
    // archive is smaller than it is.
    chapters: disambiguate(rows
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
        // A big archive holds the same chapter from every past batch, and PW
        // names them all "Physics by". Thirty identical rows are thirty
        // identical clicks. `description` carries what actually differs —
        // teacher, batch, year — so the distinct part is promoted to a label.
        label: chapterLabel(c),
        teacher: String(CLEAN_DESC(c.description).teacher || ""),
        year: String(c.year?.value || c.year?.name || ""),
      }))
      .filter((c) => c.id && c.slug)
      .sort((a, b) => a.displayOrder - b.displayOrder)),
  };
}

/** The topics of one chapter — the level that groups lectures and notes. */
export async function programTopics(programId, subjectSlug, chapterSlug, opts = {}) {
  const res = await upstreamJson(
    // `limit` is not optional here. The endpoint's default page size is 20, and a
    // real chapter routinely has more: Arjuna JEE 2026 Physics reports 39 topics.
    // Without this, 19 topics vanished and — because an empty topic lists as
    // "Coming soon" — the ones that survived were the empty ones. The chapter
    // looked full of holes rather than truncated. 100 covers every chapter seen.
    `/v1/programs/${encodeURIComponent(programId)}/subjects/${encodeURIComponent(
      subjectSlug
    )}/chapters/${encodeURIComponent(chapterSlug)}/topics?page=1&limit=100`,
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
 * Every item of a topic, walking pages until the source stops growing.
 *
 * The contents route answers page 1 for any page number, so this cannot loop
 * blindly — it stops when a page adds nothing new. That bound is what keeps a
 * misbehaving upstream from turning one page view into an infinite request chain.
 */
export async function topicContentsAll(programId, subjectSlug, chapterSlug, topicSlug, opts = {}) {
  const first = await topicContents(programId, subjectSlug, chapterSlug, topicSlug, 1, opts);
  if (!first.ok) return first;

  const seen = new Set(first.items.map((i) => i.id));
  const items = [...first.items];
  const maxPages = 20; // A topic with more than this is a data problem, not a UI one.

  for (let page = 2; page <= maxPages; page += 1) {
    const next = await topicContents(programId, subjectSlug, chapterSlug, topicSlug, page, opts);
    if (!next.ok || !next.items.length) break;
    const fresh = next.items.filter((i) => !seen.has(i.id));
    if (!fresh.length) break; // The source ignored `page` and replayed page 1.
    for (const item of fresh) {
      seen.add(item.id);
      items.push(item);
    }
  }

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

/**
 * Split a chapter `description` into the parts that identify it.
 *
 * The source writes them as `"<Teacher>; <Batch>; <Board>"` — e.g.
 * `"Saleem Ahmad Sir; Arjuna JEE 2026"` or `"Yug Sir (2022);Physics;Pathshala"`.
 * The separator and spacing are both inconsistent, so this is tolerant rather
 * than clever: split on semicolons, trim each part, and treat the first as the
 * teacher because that is the position it occupies in every sample checked.
 */
function CLEAN_DESC(description) {
  const parts = String(description || "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  return { teacher: parts[0] || "", rest: parts.slice(1) };
}

/**
 * The shortest name that still tells two chapters apart.
 *
 * Only used when the plain name is ambiguous (see `disambiguate`), so a small
 * archive still shows "Physics by" and a big one shows
 * "Physics by — Saleem Ahmad Sir, Arjuna JEE 2026".
 */
function chapterLabel(c) {
  const raw = String(c.description || "").trim();
  if (!raw) return "";
  const { rest } = CLEAN_DESC(raw);
  const batch = String(c.batchType?.name || c.batchType?.value || rest.join(", ")).trim();
  return [batch, String(c.year?.value || c.year?.name || "").trim()]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Give every chapter a distinct display name.
 *
 * Two rules, in order: keep `name` when it is already unique, and only fall back
 * to `label` when it is not. That way a chapter list that reads well today keeps
 * reading well, and a list of thirty "Physics by" rows becomes thirty rows a
 * reader can choose between.
 */
function disambiguate(chapters) {
  const counts = new Map();
  for (const c of chapters) counts.set(c.name, (counts.get(c.name) || 0) + 1);

  return chapters.map((c) => {
    if ((counts.get(c.name) || 0) <= 1) return { ...c, displayName: c.name };
    const extra = c.label || c.year || "";
    return {
      ...c,
      displayName: extra ? `${c.name} — ${extra}` : `${c.name} (${c.id.slice(-6)})`,
    };
  });
}

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
