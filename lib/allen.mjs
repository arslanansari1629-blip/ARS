/**
 * The Allen section's upstream client.
 *
 * `/allen` is a second platform on this site, modelled on the Next
 * Allen catalogue at stream.nexthope.sbs/Allen: Allen batch codes,
 * JEE Main / Advanced / NEET filters, subjects, lectures, playback.
 * That site serves its Allen data from its own backend (donated
 * Allen accounts behind it); this module speaks to that backend so
 * the catalogue and streams stay live instead of being baked in.
 *
 * Their Allen route names are not documented, so each view carries a
 * candidate list and the first candidate that answers with usable
 * data owns the view until the cache expires. `ALLEN_API_BASE`
 * re-points the whole section at another compatible backend, and
 * `view=probe` (admin aid) reports every candidate's status so a
 * renamed upstream route is a five-minute diagnosis, not a mystery.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function allenBase() {
  return String(process.env.ALLEN_API_BASE || "https://stream.nexthope.sbs").replace(/\/+$/, "");
}

/** Candidate upstream paths per view. `{code}`/`{subject}`/`{id}` expand. */
export const ALLEN_CANDIDATES = {
  batches: [
    "/api/allen/batches",
    "/api/allen-courses",
    "/api/allenbatches",
    "/api/Allen/batches",
    "/Allen/api/batches",
    "/api/allen/explore",
    "/api/courses/allen",
    "/api/v1/allen/batches",
    "/api/nextallen/batches",
    "/allen-api/batches",
    "/api/allen/all-batches",
    "/api/allen/list",
  ],
  subjects: [
    "/api/allen/subjects/{code}",
    "/api/allen/subjects?code={code}",
    "/api/allen/batch/{code}",
    "/api/allen/courses/{code}",
    "/api/allen/courses/{code}/subjects",
    "/api/allen/explore/{code}",
  ],
  lectures: [
    "/api/allen/lectures/{code}/{subject}",
    "/api/allen/lectures?code={code}&subject={subject}",
    "/api/allen/subjects/{code}/{subject}",
    "/api/allen/topics/{code}/{subject}",
    "/api/allen/chapters/{code}/{subject}",
  ],
  stream: [
    "/api/allen/stream/{id}",
    "/api/allen/watch/{id}",
    "/api/allen/lecture/{id}",
    "/api/allen/play/{id}",
    "/api/allen/stream?id={id}",
  ],
};

const cache = new Map(); // key → { at, value }
const CACHE_MS = 5 * 60 * 1000;

function expand(path, params) {
  return path
    .replaceAll("{code}", encodeURIComponent(params.code || ""))
    .replaceAll("{subject}", encodeURIComponent(params.subject || ""))
    .replaceAll("{id}", encodeURIComponent(params.id || ""));
}

async function ask(path, params, timeoutMs = 12000) {
  const url = allenBase() + expand(path, params);
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
      /* not JSON — shape check below will reject it */
    }
    return { url, status: res.status, ok: res.ok, body, text: text.slice(0, 400) };
  } catch (err) {
    return { url, status: 0, ok: false, body: null, text: "", error: String(err?.message || err).slice(0, 160) };
  }
}

/** First array hiding in an upstream body, under any of the usual keys. */
function pickArray(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  for (const key of ["batches", "courses", "data", "subjects", "chapters", "topics", "lectures", "videos", "items", "results", "list"]) {
    if (Array.isArray(body[key])) return body[key];
    if (body[key] && Array.isArray(body[key].items)) return body[key].items;
    if (body[key] && Array.isArray(body[key].data)) return body[key].data;
  }
  if (body.data && typeof body.data === "object") return pickArray(body.data);
  return null;
}

function examOf(raw, name) {
  const rawExam = String(raw.exam || raw.category || raw.courseType || raw.target || "");
  if (/neet/i.test(rawExam)) return "NEET";
  if (/main/i.test(rawExam)) return "JEE Main";
  if (/jee|advanced|iit/i.test(rawExam)) return "JEE Advanced";
  if (/neet|medical|pre-medical/i.test(name)) return "NEET";
  if (/jee/i.test(name)) return "JEE Advanced";
  return rawExam || "JEE Advanced";
}

export function normalizeAllenBatch(raw = {}) {
  const name = String(raw.name || raw.title || raw.courseName || raw.batchName || "Allen batch").trim();
  const code = String(
    raw.code || raw.courseCode || raw.batchCode || raw.slug || raw.id || raw._id || raw.batch_id || ""
  ).trim();
  if (!code) return null;
  return {
    code,
    name,
    class: String(raw.class || raw.grade || raw.className || raw.standard || "").trim(),
    exam: examOf(raw, name),
    language: String(raw.language || raw.medium || "").trim(),
    live: raw.live !== false && !/ended|expired/i.test(String(raw.status || "")),
    image: String(raw.image || raw.photo || raw.thumbnail || raw.banner || "").trim(),
  };
}

export function normalizeAllenSubject(raw = {}) {
  const name = String(raw.name || raw.title || raw.subject || "Subject").trim();
  const id = String(raw.id || raw._id || raw.slug || raw.code || name).trim();
  return {
    id,
    name,
    lectures: Number(raw.lectures || raw.lectureCount || raw.videos || raw.count || 0) || 0,
    image: String(raw.image || raw.photo || raw.thumbnail || "").trim(),
  };
}

export function normalizeAllenLecture(raw = {}) {
  const title = String(raw.title || raw.name || raw.topic || "Lecture").trim();
  const id = String(raw.id || raw._id || raw.lectureId || raw.videoId || raw.slug || title).trim();
  return {
    id,
    title,
    duration: String(raw.duration || raw.length || "").trim(),
    date: String(raw.date || raw.startTime || raw.createdAt || "").trim(),
    live: Boolean(raw.live || /live/i.test(String(raw.status || raw.type || ""))),
  };
}

const NORMALIZERS = {
  batches: normalizeAllenBatch,
  subjects: normalizeAllenSubject,
  lectures: normalizeAllenLecture,
};

async function allenList(view, params) {
  const cacheKey = `${view}:${params.code || ""}:${params.subject || ""}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const tried = [];
  for (const candidate of ALLEN_CANDIDATES[view] || []) {
    const got = await ask(candidate, params);
    tried.push({ url: got.url, status: got.status });
    if (!got.ok || !got.body) continue;
    const rows = pickArray(got.body);
    if (!rows || !rows.length) continue;
    const items = rows.map(NORMALIZERS[view]).filter(Boolean);
    if (!items.length) continue;
    const value = { success: true, view, source: got.url, total: items.length, items, tried };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
  return {
    success: false,
    view,
    total: 0,
    items: [],
    tried,
    error:
      "The Allen upstream did not answer with usable data on any known route. Its route names may have changed — run view=probe for the per-route report.",
  };
}

function pickStreamUrl(body) {
  if (!body || typeof body !== "object") return "";
  const direct =
    body.url || body.streamUrl || body.videoUrl || body.hls || body.m3u8 || body.playbackUrl || body.src || "";
  if (direct) return String(direct);
  if (body.data) return pickStreamUrl(body.data);
  if (body.stream) return pickStreamUrl(body.stream);
  return "";
}

async function allenStream(id) {
  const tried = [];
  for (const candidate of ALLEN_CANDIDATES.stream) {
    const got = await ask(candidate, { id });
    tried.push({ url: got.url, status: got.status });
    if (!got.ok || !got.body) continue;
    const url = pickStreamUrl(got.body);
    if (url) return { success: true, id, url, source: got.url, tried };
  }
  return { success: false, id, url: "", tried, error: "No Allen stream answered for this lecture." };
}

/** Per-candidate upstream report: the five-minute diagnosis. */
export async function allenProbe() {
  const rows = await Promise.all(
    ALLEN_CANDIDATES.batches.map(async (candidate) => {
      const got = await ask(candidate, {}, 8000);
      const arr = got.body ? pickArray(got.body) : null;
      return {
        candidate,
        status: got.status,
        ok: Boolean(got.ok && arr && arr.length),
        rows: arr ? arr.length : 0,
        error: got.error || "",
      };
    })
  );
  return { success: true, base: allenBase(), candidates: rows, working: rows.filter((r) => r.ok).map((r) => r.candidate) };
}

/** Test seam + healer seam: forget the five-minute catalogue memory. */
export function resetAllenCache() {
  cache.clear();
}

/**
 * The /api/allen handler logic (mounted on the batches function as
 * action=allen — see functions route table and vercel.json — so the
 * platform costs no extra serverless function).
 */
export async function allenApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "batches");
  try {
    if (view === "probe") return send(200, await allenProbe());
    if (view === "stream") {
      const id = String(params.id || "");
      if (!id) return send(400, { success: false, error: "id is required" });
      const out = await allenStream(id);
      return send(out.success ? 200 : 502, out);
    }
    if (view === "batches") return send(200, await allenList("batches", {}));
    if (view === "subjects" || view === "lectures") {
      const code = String(params.code || "");
      if (!code) return send(400, { success: false, error: "code is required" });
      if (view === "subjects") return send(200, await allenList("subjects", { code }));
      return send(200, await allenList("lectures", { code, subject: String(params.subject || "") }));
    }
    return send(400, { success: false, error: `unknown Allen view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
