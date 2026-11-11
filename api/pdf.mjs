import { cors, json, query, badRequest } from "../lib/http.mjs";
import { resolvePdfUrl } from "../lib/api-data.mjs";
import { readDppPaper, scorePaper, testPayload } from "../lib/dpp-paper.mjs";

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

  const paper = await readDppPaper({ url, name, mediaBase: `${selfBase(req)}/api/media` });
  if (!paper.ok) {
    return json(res, 502, {
      success: false,
      error: paper.error || "The paper could not be read.",
      url,
      pages: paper.pages || 0,
      bytes: paper.bytes || 0,
      stats: paper.stats || { total: 0, answerable: 0 },
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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const params = query(req);

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
