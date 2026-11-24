import { cors, json, query, badRequest } from "../lib/http.mjs";
import { maintenanceGate } from "../lib/maintenance.mjs";
import { getSession } from "../lib/admin.mjs";
import { resolvePdfUrl, fetchBatch, fetchChapters, fetchChapterContents } from "../lib/api-data.mjs";
import { fetchDppPaper, fetchDppList, quizPayload, scoreQuiz } from "../lib/dpp.mjs";
import { collectDppPapers } from "../lib/dpp-paper.mjs";
import {
  readDppPaper,
  scorePaper,
  testPayload,
  extractPdfDocument,
  fetchPaperBytes,
  inferColumns,
  layoutLines,
  layoutLinesInColumns,
  checkPaper,
} from "../lib/dpp-paper.mjs";

/**
 * GET /api/pdf?batch=&subject=&pdf=&attachment=
 *   Resolves the real PW PDF location from the upstream API and redirects the
 *   browser to our own /api/media relay (so the PDF viewer can read it).
 *
 * GET  /api/pdf?dpp=<paper url>   → a DPP paper, as a runnable test
 * POST /api/pdf?dpp=<paper url>   → the marked paper, with the analysis
 *
 * The DPP half of this route is the public practice test. It lives here, rather
 * than in a file of its own, because a deployment may only carry twelve
 * serverless functions and this one is already "the PDF route" — a DPP paper is
 * a PDF.
 *
 * Why the test is split in two calls: the questions and options are handed out
 * on the GET, the answer key only on the POST that submits the attempt. The key
 * is not a secret from anyone who opens the paper PDF (it is printed at the
 * bottom of it), but it should not be sitting in the page source of a test a
 * student is halfway through — the same reasoning that keeps `/api/admin`'s
 * interactive quiz locked.
 */

/** Anything larger than a paper is not one. Mirrors lib/dpp-paper.mjs. */
const MAX_PAPER_BYTES = 12 * 1024 * 1024;

/**
 * Only PW's own asset hosts may be read.
 *
 * Without this the route is an open proxy: `?dpp=https://example.test/huge.pdf`
 * would make the function fetch and parse a stranger's file on this deployment's
 * bill. `fetchPaperBytes` also refuses anything that is not a PDF, which is the
 * second half of the same guard.
 */
const PAPER_HOSTS = ["pw.live", "cloudfront.net", "learnxpw.site", "penpencil"];

/**
 * Is the caller an operator?
 *
 * Only used to decide whether a *diagnostic* is answered. The practice test
 * itself is public and stays public; what is gated is `?probe=…`, which returns
 * the paper's raw extracted text — a page of a stranger's PDF, refetched on this
 * deployment's bill, and nothing a student needs. It exists for the operator
 * panel, so it asks the operator panel's own session (the `x-admin-token`
 * header, or `?token=` for curl).
 */
function isOperator(req, params) {
  try {
    return Boolean(getSession(params.token || req.headers["x-admin-token"] || ""));
  } catch {
    return false;
  }
}

/**
 * …plus the host the dev server is pointed at.
 *
 * Local development and the test suite serve the papers from a fixture upstream
 * on 127.0.0.1 (`PW_UPSTREAM_BASE`). Honouring that one host keeps the guard
 * above meaningful without making the feature untestable, and the variable is
 * unset in production, where the list is the whole story.
 */
function devUpstreamHost() {
  try {
    const base = process.env.PW_UPSTREAM_BASE || "";
    if (!/^https?:\/\//i.test(base)) return "";
    return new URL(base).hostname;
  } catch {
    return "";
  }
}

function allowedPaperHost(url) {
  try {
    const host = new URL(url).hostname;
    if (host === devUpstreamHost()) return true;
    return PAPER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Per-client budget for reading papers.
 *
 * A paper read is a download, a PDF parse and two passes of text extraction —
 * the most expensive thing an anonymous visitor can ask this deployment to do.
 * A student never needs more than a handful a minute; a scraper does, and gets
 * a 429 instead.
 */
const HITS = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 45;

function overBudget(key) {
  const now = Date.now();
  const row = HITS.get(key) || { n: 0, at: now };
  if (now - row.at > WINDOW_MS) {
    row.n = 0;
    row.at = now;
  }
  row.n += 1;
  HITS.set(key, row);
  // Keep the map from growing without bound on a long-lived instance.
  if (HITS.size > 2000) {
    for (const [k, v] of HITS) if (now - v.at > WINDOW_MS) HITS.delete(k);
  }
  return row.n > MAX_HITS;
}

function clientOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "anon");
}

/** Vercel pre-parses a JSON body; the dev shim streams it. */
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // A test submission is a few hundred bytes: one answer letter per question.
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16384) {
        req.destroy();
        finish();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", finish);
    req.on("error", finish);
    setTimeout(finish, 2000);
  }).then((raw) => {
    if (!String(raw || "").trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  });
}

/**
 * Our own origin, for the media relay fallback.
 *
 * PW's CDN occasionally refuses a bare server fetch from one region and answers
 * a browser-shaped one through `/api/media`; the paper reader uses that as its
 * second attempt.
 */
function selfBase(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  if (!host) return "";
  const local = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|$)/.test(host);
  const proto = local
    ? "http"
    : String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}

async function dppRoute(req, res, params) {
  if (overBudget(clientOf(req))) {
    res.setHeader("Retry-After", "600");
    return json(res, 429, {
      success: false,
      error: "That is a lot of papers in a few minutes. Try again shortly.",
    });
  }

  const url = String(params.dpp || params.url || "").trim();
  if (!url) return badRequest(res, "A dpp paper url is required.");
  if (!/^https?:\/\//i.test(url)) return badRequest(res, "The paper url must be absolute.");
  if (!allowedPaperHost(url)) {
    return badRequest(res, "Papers are only read from Physics Wallah's own asset hosts.");
  }

  const name = String(params.name || "").trim().slice(0, 200);

  if (req.method === "POST") {
    const payload = await readBody(req);
    const answers = payload && typeof payload.answers === "object" ? payload.answers : {};
    const elapsedMs = Number(payload?.elapsedMs) || 0;
    // `index` is what the practice page sends. `number` exists for a caller
    // holding the paper's own question numbers, and is never mixed with it.
    const keyedBy = payload?.keyedBy === "number" ? "number" : "index";

    // Re-read (cached) rather than trusting anything the client sends about the
    // key: the paper is the only authority on what the answer is.
    const paper = await readDppPaper({ url, name, mediaBase: `${selfBase(req)}/api/media` });
    if (!paper.ok) {
      return json(res, 502, { success: false, error: paper.error, stats: paper.stats });
    }

    const result = scorePaper(paper, answers, { elapsedMs, keyedBy });
    return json(res, 200, {
      success: true,
      title: paper.title,
      url,
      pages: paper.pages,
      parser: paper.parser,
      result,
      // The review list, per question: what was asked, what was chosen, and what
      // the paper's key says. This is the analysis the page is for.
      review: result.rows,
    });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  // Which diagnostic was asked for. `lines` and `runs` are needed precisely when a
  // paper *fails* to read, so they are answered before the failure is returned.
  const wantsLayout = params.lines === "1";

  const paper = await readDppPaper({ url, name, mediaBase: `${selfBase(req)}/api/media` });
  if (!paper.ok) {
    return json(res, 502, {
      success: false,
      error: paper.error || "The paper could not be read.",
      url,
      pages: paper.pages || 0,
      bytes: paper.bytes || 0,
      stats: paper.stats || { total: 0, answerable: 0 },
      // A diagnostic, not a feature: the raw text of a paper is only returned
      // to a signed-in operator (see isOperator).
      ...(params.probe === "extract" && isOperator(req, params)
        ? {
            probed: await (async () => {
              const got = await fetchPaperBytes(url);
              if (!got.bytes) return { error: got.error };
              const doc = await extractPdfDocument(got.bytes);
              return {
                ok: doc.ok,
                pages: doc.pages,
                firstPageText: String(doc.pageTexts?.[0] || "").slice(0, 300),
                firstRuns: (doc.items?.[0] || []).slice(0, 10).map((it) => it.str),
              };
            })(),
          }
        : {}),
      // A paper nobody can read is the case where the geometry matters most — a
      // scanned sheet and a sheet the reader got wrong look identical from the
      // answer, so the layout is attached to the failure too.
      ...(wantsLayout
        ? {
            layout: await describeLayout(url, {
              runs: params.runs === "1",
              dumpPage: Number(params.page) || 0,
            }),
          }
        : {}),
    });
  }

  // `?lines=1` appends how the paper was laid out: the columns the reader found
  // and the visual lines it read. A paper that comes out with the wrong options
  // is a geometry problem, and there is no way to diagnose one from the answers
  // alone. The text is public (it is the PDF) and the shape is bounded, so this
  // is a diagnostic, not a leak.
  // `?check=1` answers one question: *does this paper mark correctly?* It marks a
  // perfect attempt — every question answered with the paper's own key, which the
  // server reads itself — and reports how many of those came back correct. Fourteen
  // of fourteen means the options are attached to the right questions and the key
  // is attached to the right numbers; anything less names the questions that are
  // wrong. Without it the only way to check a deployed paper is to sit the paper by
  // hand and compare with the printed key, which is exactly the mistake that let a
  // green suite ship over a wrongly-marking production.
  //
  // It leaks nothing: the caller supplies no answers, the response carries only
  // counts plus the text of any question that failed to mark, and the questions'
  // own key is never in it.
  if (params.check === "1") {
    return json(res, 200, { success: true, url, ...checkPaper(paper) });
  }

  if (wantsLayout) {
    const layout = await describeLayout(url, {
      runs: params.runs === "1",
      dumpPage: Number(params.page) || 0,
    });
    return json(res, 200, {
      success: true,
      source: "pdf",
      url,
      bytes: paper.bytes,
      parser: paper.parser,
      ...testPayload(paper),
      layout,
    });
  }

  // Note what is *absent*: `questions[].answer`, `answerKey`. Deliberate.
  return json(res, 200, {
    success: true,
    source: "pdf",
    url,
    bytes: paper.bytes,
    parser: paper.parser,
    truncated: (paper.bytes || 0) > MAX_PAPER_BYTES,
    ...testPayload(paper),
  });
}

/**
 * How the reader saw the page.
 *
 * Bounded on purpose: the question markers (which is what decides the columns),
 * the column boundaries, and the first lines of each page — enough to see why a
 * paper came out wrong, small enough to read in a browser.
 */
async function describeLayout(url, { runs = false, dumpPage = 0 } = {}) {
  const fetched = await fetchPaperBytes(url);
  if (!fetched.bytes) return { ok: false, error: fetched.error };
  const doc = await extractPdfDocument(fetched.bytes);
  if (!doc.ok) return { ok: false, error: doc.error };

  return {
    ok: true,
    pages: doc.pages,
    pageDetail: doc.items.slice(0, 4).map((page, index) => {
      const markers = page
        .map((it) => ({ x: Math.round(it.x), y: Math.round(it.y), str: String(it.str).trim() }))
        .filter((r) => /^Q\s*\d+\b/.test(r.str))
        .map((r) => ({ x: r.x, y: r.y, q: (r.str.match(/^Q\s*(\d+)/) || [])[1] }));
      const columns = inferColumns(page);
      // The lines are read from the paper *up to its answer key*. Everything from
      // the key onwards is replaced by one line, because this route is public and
      // the whole point of the practice page is that the key is withheld until the
      // student submits — a diagnostic that echoes `Q1 (B) Q8 (D)` would hand it
      // over to anyone who appends `&lines=1`.
      const read = columns.length > 1 ? layoutLinesInColumns(page, columns) : layoutLines(page);
      const keyY = read.reduce(
        (at, line) => (at === null && /answer\s*key/i.test(line.text) ? line.y : at),
        null
      );
      const keyAt = read.findIndex((line) => /answer\s*key/i.test(line.text));
      const body = keyAt < 0 ? read : read.slice(0, keyAt);
      const lines = body.slice(0, 45).map((line) => line.text.slice(0, 110));
      if (keyAt >= 0) lines.push(`[answer key withheld: ${read.length - keyAt} lines]`);
      // `&runs=1` dumps every run of one page (`&page=1` picks which), compactly.
      // That is how a real paper's geometry gets into the test fixtures: the paper
      // cannot be downloaded from a sandbox, but its runs can be read back as JSON.
      const dump = runs && index === dumpPage
        ? page
            .slice()
            // The key page's runs are geometry, not text: its `(B)` cells would
            // spell the answers out just as plainly as the lines above.
            .filter((it) => keyY === null || (Number(it.y) || 0) > keyY)
            .sort((a, b) => b.y - a.y || a.x - b.x)
            .map((it) => [
              String(it.str).slice(0, 60),
              Math.round(Number(it.x) || 0),
              Math.round(Number(it.y) || 0),
              Math.round(Number(it.width) || 0),
              Math.round((Number(it.fontSize) || 0) * 10) / 10,
            ])
        : undefined;

      return { index, runs: page.length, markers, columns, ...(dump ? { dump } : {}), lines };
    }),
  };
}

/**
 * GET  /api/pdf?quiz=<testId>  → the test, without its key
 * POST /api/pdf?quiz=<testId>  → the marked attempt, with the analysis
 *
 * The split is the same honesty rule as the PDF paper: questions are
 * public, the key is only revealed against a submitted attempt.
 */
async function quizRoute(req, res, params) {
  if (overBudget(clientOf(req))) {
    res.setHeader("Retry-After", "600");
    return json(res, 429, { success: false, error: "Too many tests in a few minutes. Try again shortly." });
  }
  const testId = String(params.quiz || "").trim();
  if (!/^[0-9a-f]{24}$/i.test(testId)) {
    return json(res, 200, { success: false, error: "A DPP test id is required." });
  }

  const paper = await fetchDppPaper({ testId });
  if (!paper.ok) {
    // 200 with the refusal spelled out: the practice page reads the body
    // either way, and a bare 403 hides which of the two honest outcomes
    // (locked vs unreachable) the student actually hit.
    const body = {
      success: false,
      locked: Boolean(paper.locked),
      error: paper.error || "The test could not be read.",
    };
    // Locked is PW's enrollment wall, not the end of the road: the same
    // DPP ships in the chapter as a guest-readable PDF paper, and the
    // paper test is the same test sat a different way. Find its twin and
    // hand the page the address to open instead.
    // Mirrors disagree on the refusal's shape (401 on the official host,
    // 404 through a proxy that does not serve the test service); both mean
    // "not readable with this session", so both earn the twin hunt.
    const refused = paper.locked || /401|403|404/.test(String(paper.error || ""));
    if (refused && req.method === "GET" && params.batch && params.subject) {
      body.fallback = await paperTwin(params).catch((err) => ({ error: String(err?.message || err).slice(0, 120) }));
    }
    return json(res, 200, body);
  }

  if (req.method === "POST") {
    const payload = await readBody(req);
    const answers = payload && typeof payload.answers === "object" ? payload.answers : {};
    const result = scoreQuiz(paper, answers, { elapsedMs: Number(payload?.elapsedMs) || 0 });
    return json(res, 200, {
      success: true,
      source: "quiz",
      title: paper.name || String(params.name || ""),
      result,
      review: result.rows,
    });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const payload = quizPayload(paper);
  return json(res, 200, {
    success: true,
    source: "quiz",
    ...payload,
    title: paper.name || String(params.name || "") || payload.title,
  });
}

const normTitle = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/\(quiz\)/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The chapter's DPP PDF whose title best matches the quiz's, if any. */
async function paperTwin(params) {
  const wanted = normTitle(params.name || params.title || "");
  if (!wanted) return null;
  // Known chapter: read its DPP tab directly instead of walking the
  // chapter list first — one upstream walk, and it keeps working in
  // windows where the chapter list itself is refused.
  if (params.chapter) {
    const out = await fetchChapterContents(
      String(params.batch),
      String(params.subject),
      String(params.chapter),
      "DppNotes"
    ).catch(() => null);
    const papers = [];
    for (const item of out?.items || []) {
      for (const doc of item.docs || []) {
        if (doc.url) papers.push({ url: doc.url, title: (doc.topic || item.title || doc.name || "DPP").trim() });
      }
    }
    const twin = matchTwin(papers, wanted);
    if (twin) return twin;
  }
  const collected = await collectDppPapers({
    batch: String(params.batch),
    subject: String(params.subject),
    wantedChapter: String(params.chapter || ""),
    maxChapters: 1,
    fetchChapters,
    fetchChapterContents,
  });
  if (!collected.ok || !collected.papers?.length) return null;
  return matchTwin(collected.papers, wanted);
}

/** Best title match for the quiz name among candidate papers. */
function matchTwin(papers, wanted) {
  const wantedWords = new Set(wanted.split(" ").filter((w) => w.length > 2));
  let best = null;
  for (const p of papers) {
    const t = normTitle(p.title);
    if (t === wanted) return { paperUrl: p.url, name: p.title };
    const words = t.split(" ").filter((w) => w.length > 2);
    const overlap = words.filter((w) => wantedWords.has(w)).length;
    const score = words.length ? overlap / words.length : 0;
    if (score >= 0.6 && (!best || score > best.score)) best = { paperUrl: p.url, name: p.title, score };
  }
  return best ? { paperUrl: best.paperUrl, name: best.name } : null;
}

/**
 * GET /api/pdf?dppList=1&batch=&subject= → the subject's DPP tests.
 *
 * `subject` may be the slug the chapter page carries or the batch-subject
 * document id the test service keys on; the slug is resolved through the
 * batch, the same way the operator route does it.
 */
async function dppListRoute(req, res, params) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const batch = String(params.batch || "").trim();
  const asked = String(params.subject || "").trim();
  if (!batch || !asked) return badRequest(res, "batch and subject are required.");

  let batchSubjectId = asked;
  if (!/^[0-9a-f]{24}$/i.test(asked)) {
    const info = await fetchBatch(batch).catch(() => null);
    const match = (info?.subjects || []).find(
      (s) => s.slug === asked || s.subjectId === asked || s.id === asked
    );
    if (!match) return json(res, 404, { success: false, error: "That subject is not part of this batch." });
    batchSubjectId = match.id || match.subjectId || "";
  }

  const list = await fetchDppList({
    batch,
    batchSubjectId,
    page: Math.max(1, Math.min(50, Number(params.page) || 1)),
  });

  /* The guest wall must not empty the shelf. When the native index
     refuses (it needs a paid session), the same tests exist in the
     chapters as guest-readable papers. The walk is deliberately
     sequential with an early exit: a parallel twelve-chapter walk
     spends the whole subrequest budget host-hunting before it can
     name a single paper, while one chapter read at a time — the
     chapter page's own pattern — lands. First chapter with papers
     answers; the rest are the chapter page's job. */
  if (!list.ok) {
    const chaptersOut = await fetchChapters(batch, asked).catch(() => null);
    const chapters = (chaptersOut?.chapters || []).slice(0, 6);
    for (const chapter of chapters) {
      const out = await fetchChapterContents(batch, asked, chapter.id, "DppNotes", 1).catch(() => null);
      if (!out?.ok) continue;
      const papers = [];
      for (const item of out.items || []) {
        for (const doc of item.docs || []) {
          if (doc.url) papers.push({ url: doc.url, title: (doc.topic || item.title || doc.name || "DPP").trim(), chapter: chapter.name || "" });
        }
      }
      if (papers.length) {
        return json(res, 200, {
          success: true,
          source: "papers",
          batch,
          batchSubjectId,
          items: papers.map((p) => ({ id: "", name: p.title, paperUrl: p.url, chapter: p.chapter })),
          total: papers.length,
          page: 1,
          pages: 1,
          error: "",
          note: "Native test index needs a paid session; these are the same DPPs as papers.",
        });
      }
    }
    return json(res, 200, {
      success: false,
      batch,
      batchSubjectId,
      items: [],
      total: 0,
      page: 1,
      pages: 1,
      error: list.error || "",
      fallback: { chapters: chapters.length, papers: 0 },
    });
  }

  return json(res, 200, {
    success: list.ok,
    batch,
    batchSubjectId,
    items: (list.items || []).map((it) => ({
      id: it.id,
      name: it.name,
      questions: it.questions,
      marks: it.marks,
      minutes: it.minutes,
      free: it.free,
    })),
    total: list.total || 0,
    page: list.page || 1,
    pages: list.pages || 1,
    error: list.error || "",
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (await maintenanceGate(req, res)) return;

  const params = query(req);

  // The interactive DPP quiz (PW's test service, the aryavidya shape):
  // students ask for a test by id and sit it here. This used to exist only
  // behind the operator sign-in on /api/admin, which meant the one audience
  // it was built for could never reach it.
  if (params.quiz) {
    try {
      return await quizRoute(req, res, params);
    } catch (err) {
      return json(res, 502, { success: false, error: err?.message || "The test could not be read." });
    }
  }
  if (params.dppList) {
    try {
      return await dppListRoute(req, res, params);
    } catch (err) {
      return json(res, 502, { success: false, error: err?.message || "The DPP list could not be read." });
    }
  }

  // The practice test: a paper read here, marked here, answers kept here.
  if (params.dpp) {
    try {
      return await dppRoute(req, res, params);
    } catch (err) {
      const message =
        err?.name === "TimeoutError"
          ? "The paper took too long to read."
          : err?.message || "The paper could not be read.";
      return json(res, 502, { success: false, error: message });
    }
  }

  const { batch, subject, pdf, attachment, url } = params;

  try {
    let target = url || "";
    let why = "";

    if (!target) {
      if (!batch || !subject || !pdf || !attachment) {
        return badRequest(res, "Provide url, or batch + subject + pdf + attachment");
      }
      const resolved = await resolvePdfUrl(batch, subject, pdf, attachment);
      target = resolved.url;
      why = resolved.error;
    }

    if (!target) {
      return json(res, 404, {
        success: false,
        error: "PDF is not available for this item",
        detail: why || "no url returned",
      });
    }

    const proxied = `/api/media?url=${encodeURIComponent(target)}`;
    res.statusCode = 302;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", proxied);
    return res.end();
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "PDF resolution failed" });
  }
}
