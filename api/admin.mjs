import { json, query } from "../lib/http.mjs";
import hlsHandler from "../lib/hls.mjs";
import signHandler from "../lib/sign.mjs";
import {
  checkCredentials,
  createSession,
  destroySession,
  getSession,
  rateLimited,
  noteFailure,
  clearFailures,
  cooldownMinutes,
  dashboard,
  clientKey,
  recordRequest,
  noteLog,
} from "../lib/admin.mjs";
import { reportPlaybackFailure, recordRelayFailure } from "../lib/selfheal.mjs";
import { auditBatch, auditLecture, auditHeadline } from "../lib/audit.mjs";
import { fetchDppList, fetchDppPaper, dppHeadline } from "../lib/dpp.mjs";
import { fetchBatch } from "../lib/api-data.mjs";

/**
 * The API edge: the operator API, plus two media routes that share this function.
 *
 *   POST   /api/admin               { username, password } → session token
 *   GET    /api/admin?action=stats  → live health, traffic, release info
 *   POST   /api/admin?action=logout → drop the session
 *   GET    /api/admin?action=whoami → is this token still valid?
 *   POST   /api/admin?action=audit  → walk a batch and find lectures that do not play
 *   GET    /api/admin?action=audit  → the last audit this instance ran
 *   GET    /api/admin?action=dpp      → DPP papers for one batch subject
 *   GET    /api/admin?action=dpp-paper→ one paper's questions
 *   POST   /api/admin?action=rescan → re-check one lecture, on the spot
 *
 *   GET    /api/hls  → `action=hls`   (rewritten here, see vercel.json)
 *   GET    /api/sign → `action=sign`  (rewritten here, see vercel.json)
 *
 * Why they share this file: the Hobby plan allows twelve serverless functions per
 * deployment and the project needs fourteen routes. Vercel still routes `/api/hls`
 * and `/api/sign` to their own URLs; the rewrite only decides which function
 * answers, so nothing the player asks for changed.
 *
 * Admin auth is a bearer token in `x-admin-token`. Nothing here echoes the
 * operator's password, and a wrong username and a wrong password are
 * indistinguishable.
 */

/** The header a client must send. Also accepted as a query param for curl. */
function tokenOf(req, params) {
  const header = req.headers["x-admin-token"];
  return (Array.isArray(header) ? header[0] : header) || params.token || "";
}

/** Read the request body. Vercel may pre-parse it; the dev shim streams it. */
async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const raw = await new Promise((resolve) => {
    // Bounded: a sign-in body is two short strings, and an unbounded read from
    // the network is a trivial way to waste a function's memory.
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > 8192) {
        req.destroy();
        finish();
        return;
      }
      chunks.push(c);
    });
    req.on("end", finish);
    req.on("error", finish);
    setTimeout(finish, 2000);
  });
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * The site's own origin, for the self-check probe.
 *
 * Vercel sets the forwarded proto/host headers; locally there are none, so a
 * plain dev server on 127.0.0.1 must not be probed over https or the check
 * fails for the wrong reason.
 */
function selfBase(req) {
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  if (!host) return "";
  const local = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|$)/.test(host);
  const proto = local
    ? "http"
    : (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  const params = query(req);
  const action = params.action || "";

  // Media routes keep their own CORS and caching rules; only the mount is shared.
  if (action === "hls") return hlsHandler(req, res);
  if (action === "repair") return repairAction(req, res);
  if (action === "sign") return signHandler(req, res, true);

  // No permissive CORS here: this route is same-origin only, by construction.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");

  const key = clientKey(req);
  const started = Date.now();

  const finish = (status, payload) => {
    recordRequest({ route: "admin", status, ms: Date.now() - started });
    return json(res, status, payload);
  };

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.end();
  }

  /* ---------------------------------------------------------- sign in */
  if (req.method === "POST" && (!action || action === "login")) {
    if (rateLimited(key)) {
      noteLog({ level: "warn", route: "admin", message: "sign-in blocked by cooldown" });
      return finish(429, {
        success: false,
        error: `Too many attempts. Try again in ${cooldownMinutes(key)} minute(s).`,
      });
    }

    const payload = await body(req);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");

    if (!username || !password) {
      return finish(400, { success: false, error: "Username and password are required." });
    }

    if (!checkCredentials(username, password)) {
      noteFailure(key);
      // One message for both fields: never confirm which half was right.
      noteLog({ level: "warn", route: "admin", message: "failed sign-in attempt" });
      return finish(401, { success: false, error: "Invalid username or password." });
    }

    clearFailures(key);
    const session = createSession(key);
    noteLog({ level: "info", route: "admin", message: "operator signed in" });
    return finish(200, {
      success: true,
      token: session.id,
      idleMinutes: session.idleMinutes,
      maxHours: session.maxHours,
    });
  }

  /* -------------------------------------------------- everything else */
  const session = getSession(tokenOf(req, params));

  if (action === "logout") {
    destroySession(tokenOf(req, params));
    noteLog({ level: "info", route: "admin", message: "operator signed out" });
    return finish(200, { success: true });
  }

  if (action === "whoami") {
    return finish(session ? 200 : 401, {
      success: Boolean(session),
      signedIn: Boolean(session),
    });
  }

  if (!session) {
    return finish(401, { success: false, error: "Sign in to view live stats." });
  }

  /* ------------------------------------------------------------- audit */
  if (action === "audit") return auditAction(req, res, finish, params);
  if (action === "rescan") return rescanAction(req, res, finish, params);

  /* --------------------------------------------------------------- dpp */
  if (action === "dpp") return dppAction(req, res, finish, params);
  if (action === "dpp-paper") return dppPaperAction(req, res, finish, params);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }

  const payload = await dashboard({
    req,
    selfBase: selfBase(req),
    deep: params.deep === "1",
  });
  return finish(200, { success: true, ...payload });
}

/**
 * GET /api/admin?action=dpp&batch=&subject=&page=
 *
 * `subject` here is the *batch subject document id* (`subjects[].id` from the
 * batch payload). The slug is accepted too and resolved to the id, because an
 * operator pasting what the site's own URLs use should not get an empty list.
 */
async function dppAction(req, res, finish, params) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }
  const batch = String(params.batch || "").trim();
  const asked = String(params.subject || "").trim();
  if (!batch || !asked) {
    return finish(400, { success: false, error: "batch and subject are required." });
  }

  // Resolve a slug (or a PW subject id) to the batch-subject document id that
  // the DPP route actually keys on.
  let batchSubjectId = asked;
  let label = "";
  if (!/^[0-9a-f]{24}$/i.test(asked)) {
    const info = await fetchBatch(batch);
    const match = (info?.subjects || []).find(
      (s) => s.slug === asked || s.subjectId === asked || s.id === asked
    );
    if (!match) {
      return finish(404, {
        success: false,
        error: "That subject is not part of this batch.",
      });
    }
    batchSubjectId = match.id || match.subjectId || "";
    label = match.name || "";
  }

  const list = await withDeadline(
    fetchDppList({ batch, batchSubjectId, page: params.page }),
    20_000
  ).catch((err) => ({ ok: false, error: err?.message || "The DPP list timed out.", items: [], total: 0 }));

  return finish(list.ok ? 200 : list.auth ? 403 : 502, {
    success: list.ok,
    batch,
    batchSubjectId,
    subject: label || asked,
    ...list,
    headline: dppHeadline(list),
  });
}

/**
 * GET /api/admin?action=dpp-paper&id=<testId>
 *
 * A locked paper answers 200 with `locked: true`: the panel's job is to explain
 * who can open it, not to dress a 401 up as a server fault.
 */
async function dppPaperAction(req, res, finish, params) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }
  const id = String(params.id || "").trim();
  if (!id) return finish(400, { success: false, error: "id is required." });

  const paper = await withDeadline(fetchDppPaper({ testId: id }), 20_000).catch((err) => ({
    ok: false,
    locked: false,
    error: err?.message || "The paper timed out.",
    questions: [],
  }));

  return finish(200, {
    success: paper.ok,
    locked: Boolean(paper.locked),
    ...paper,
  });
}

/**
 * The last audit this instance ran.
 *
 * An audit is minutes of upstream work, so it cannot be a polled GET: the panel
 * starts one, watches it, and reads the result. Keeping the last report in
 * memory means a reopened panel shows the answer immediately instead of making
 * the operator run it again — and a note saying how old it is, because a stale
 * audit is worse than none if nothing says so.
 */
let lastAudit = null;
let auditRunning = false;

/** Progress of the audit currently running, for the panel's polling. */
let auditProgress = null;

async function auditAction(req, res, finish, params) {
  if (req.method === "GET") {
    return finish(200, {
      success: true,
      running: auditRunning,
      progress: auditProgress,
      audit: lastAudit,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }

  if (auditRunning) {
    return finish(409, {
      success: false,
      error: "An audit is already running on this instance.",
      progress: auditProgress,
    });
  }

  const payload = await body(req);
  const batch = String(payload.batch || params.batch || "").trim();
  if (!batch) {
    return finish(400, { success: false, error: "A batch id is required to audit." });
  }

  const limit = Math.max(1, Math.min(200, Number(payload.limit) || 40));
  auditRunning = true;
  auditProgress = { batch, done: 0, total: limit, startedAt: new Date().toISOString(), last: "" };

  const started = Date.now();
  try {
    // Bounded like every other request on this function: a batch sweep can run
    // long, but it must not outlive the request that started it, or the panel
    // polls forever for an answer nothing will ever produce.
    const report = await withDeadline(
      auditBatch({
        batch,
        limit,
        subject: String(payload.subject || params.subject || ""),
        chapter: String(payload.chapter || params.chapter || ""),
        onProgress: (lecture, done, total) => {
          auditProgress = {
            ...auditProgress,
            done,
            total,
            last: lecture.title || lecture.id,
          };
        },
      }),
      50_000
    );

    lastAudit = {
      ...report,
      headline: auditHeadline(report),
      ms: Date.now() - started,
      startedAt: auditProgress.startedAt,
    };
    noteLog({
      level: report.totals && report.totals.plays === report.totals.lectures ? "info" : "warn",
      route: "audit",
      message: `audited ${batch}: ${lastAudit.headline}`,
    });
    return finish(200, { success: true, audit: lastAudit });
  } catch (err) {
    const message =
      err && err.code === "DEADLINE"
        ? `The audit ran out of time after ${Math.round((Date.now() - started) / 1000)}s. Lower the limit and run it again.`
        : err?.message || "The audit failed.";
    noteLog({ level: "error", route: "audit", message });
    return finish(504, { success: false, error: message, audit: lastAudit });
  } finally {
    auditRunning = false;
    auditProgress = null;
  }
}

/** Re-check a single lecture now, without waiting for a whole batch sweep. */
async function rescanAction(req, res, finish, params) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }
  const payload = await body(req);
  const batch = String(payload.batch || params.batch || "").trim();
  const subject = String(payload.subject || params.subject || "").trim();
  const id = String(payload.id || params.id || "").trim();
  if (!batch || !subject || !id) {
    return finish(400, { success: false, error: "batch, subject and id are required." });
  }

  try {
    const lecture = await withDeadline(
      auditLecture({ batch, subject, id, title: String(payload.title || "") }, { fresh: true }),
      25_000
    );
    noteLog({
      level: lecture.state === "plays" ? "info" : "warn",
      route: "audit",
      message: `rescanned ${id}: ${lecture.state}${lecture.detail ? ` — ${lecture.detail}` : ""}`,
    });
    return finish(200, { success: true, lecture });
  } catch (err) {
    return finish(504, {
      success: false,
      error: err?.message || "The lecture could not be re-checked.",
    });
  }
}

/** Reject with a labelled error rather than letting a request hit its timeout. */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("deadline exceeded");
      err.code = "DEADLINE";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * `GET /api/repair?folder=&kind=&detail=` — the player's report line.
 *
 * A player that cannot load a manifest knows something no server metric does:
 * *that* folder, on *that* device, is dead right now. It calls this before it
 * retries, which drops any cached plan for the folder so the retry re-probes
 * instead of receiving the same poisoned URL, and records the fault so the
 * healer can act if it keeps happening.
 *
 * Reachable from `/api/sign?action=repair` (the function is already deployed)
 * and deliberately forgettable: it returns a tiny JSON receipt and nothing that
 * a visitor would recognise as a feature. Rate limited per client so it cannot
 * be used as a cache-flush hammer.
 */
export async function repairAction(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const key = clientKey(req);
  if (repairHits(key) > 40) return json(res, 429, { success: false, error: "slow down" });

  const { folder = "", kind = "manifest", detail = "" } = query(req);
  const healed = reportPlaybackFailure({ folder, kind, detail });
  recordRelayFailure({ relay: "player", kind, detail: folder });

  // A receipt, not a report. The player only needs to know whether a retry is
  // worth making; anything else would be handing the healing system's internals
  // to an unauthenticated caller.
  return json(res, 200, { success: true, ...healed, retry: true });
}

/** Per-client throttle for repairs; nothing else uses this counter. */
const repairCounts = new Map();
function repairHits(key) {
  const now = Date.now();
  const cur = repairCounts.get(key) || { n: 0, at: now };
  if (now - cur.at > 60 * 60 * 1000) {
    cur.n = 0;
    cur.at = now;
  }
  cur.n += 1;
  repairCounts.set(key, cur);
  return cur.n;
}
