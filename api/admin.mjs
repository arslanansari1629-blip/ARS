import { json, query } from "../lib/http.mjs";
import hlsHandler from "../lib/hls.mjs";
import signHandler from "../lib/sign.mjs";
import {
  checkCredentials,
  requestStats,
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
import { reportPlaybackFailure, recordRelayFailure, selfHealReport } from "../lib/selfheal.mjs";
import { auditBatch, auditLecture, auditHeadline } from "../lib/audit.mjs";
import { fetchDppList, fetchDppPaper, dppHeadline } from "../lib/dpp.mjs";
import { readDppPaper, collectDppPapers } from "../lib/dpp-paper.mjs";
import { fetchChapters, fetchChapterContents } from "../lib/api-data.mjs";
import { fetchBatch, signMap, renditionMap } from "../lib/api-data.mjs";
import { loadCatalogIndex } from "../lib/catalog.mjs";
import { healAction, healerReport, sweep, repair, reportFault, SYMPTOMS } from "../lib/healer.mjs";
import { wireHealer } from "../lib/healer-wire.mjs";
import { scheduleReport, restoreSchedulerState, noteExternalTick, selfBaseOf } from "../lib/scheduler.mjs";
import { scanPass, scannerReport, clearFinding } from "../lib/scanner.mjs";

/**
 * The API edge: the operator API, plus two media routes that share this function.
 *
 *   POST   /api/admin               { username, password } → session token
 *   GET    /api/admin?action=stats  → live health, traffic, release info
 *   POST   /api/admin?action=logout → drop the session
 *   GET    /api/admin?action=whoami → is this token still valid?
 *   POST   /api/admin?action=audit  → walk a batch and find lectures that do not play
 *   GET    /api/admin?action=audit  → the last audit this instance ran
 *   GET    /api/admin?action=dpp      → DPP quiz list for one batch subject
 *   GET    /api/admin?action=dpp-papers → the DPP *PDF papers* for one subject
 *   GET    /api/admin?action=dpp-paper→ one paper's questions (from the PDF)
 *   POST   /api/admin?action=rescan → re-check one lecture, on the spot
 *   GET    /api/admin?action=heal    → the healer's state, probe readings, ledger
 *   POST   /api/admin?action=heal    → sweep every probe and repair what is broken
 *   POST   /api/admin?action=heal&symptom=<key> → force one repair, on the spot
 *   GET    /api/admin?action=scan    → the site scanner's coverage, findings, cadence
 *   POST   /api/admin?action=scan    → run one scan pass now and repair what it finds
 *   POST   /api/scan?key=…           → the external five-minute pinger (no session)
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
  // The scanner's own URL. `/api/scan` is a rewrite onto this function, so the
  // external five-minute pinger costs no extra serverless function; the key is
  // what makes it a scheduler rather than an anonymous "scan now" button.
  if (action === "scan") return scanRoute(req, res, params);

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
  if (action === "heal") return healRoute(req, res, finish, params);
  // The panel's scanner section reads the same route with `__session` set, so a
  // signed-in operator sees findings and an anonymous reader does not.
  if (action === "site") return scanRoute(req, res, { ...params, __session: true }, finish);
  if (action === "rescan") return rescanAction(req, res, finish, params);

  /* --------------------------------------------------------------- dpp */
  if (action === "dpp") return dppAction(req, res, finish, params);
  if (action === "dpp-papers") return dppPapersAction(req, res, finish, params);
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

  // The healer rides along with the ordinary stats poll: the panel already
  // refreshes it every few seconds, and a second request would double the cost
  // of watching. Probing is read-only, so a poll never changes the site.
  wireHealer({
    caches: { plans: signMap(), renditions: renditionMap() },
    traffic: () => requestStats(),
    version: process.env.BUILD_STAMP || "",
  });
  const heal = await sweep({ apply: false }).catch(() => null);
  if (heal) payload.heal = { ...healerReport(), applied: false, actions: [] };

  // The scanner's report rides along too. Reading it never scans: the cadence is
  // the scheduler's job (see `lib/scheduler.mjs`), and an operator watching the
  // panel must not be what makes the site change.
  await restoreSchedulerState().catch(() => null);
  payload.scan = scheduleReport();

  return finish(200, { success: true, ...payload });
}

/* -------------------------------------------------------------- scanner */

/**
 * The site scanner, from the operator's chair and from a scheduler.
 *
 *   GET  ?action=scan                → coverage, findings, the cadence's channels
 *   POST ?action=scan                → one full pass, then repair what it names
 *   POST /api/scan?key=$SCAN_KEY     → the same pass, for an external pinger
 *
 * Two rules shape this route, both of them honesty rules:
 *
 * 1. **A GET never scans and never repairs.** Reading the state is not an
 *    action; an operator watching the panel must not be the thing that changes
 *    it, and a crawler must not be able to spend the repair budget.
 * 2. **The scheduler is not the operator.** A POST carrying the shared key runs
 *    a pass; a POST carrying a session runs a pass too, because both are
 *    deliberate acts. Anything else is 401, and the response says which of the
 *    two it wanted — a silent 401 on a cron is an outage you cannot see.
 */
async function scanRoute(req, res, params, finish = null) {
  const done = finish || ((status, payload) => json(res, status, payload));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  // Two credentials can run a pass, and neither is a fixed string in the repo:
  //   · `x-scan-key` / `?key=` — the external pinger, `SCAN_KEY`
  //   · `?cron=1` — Vercel's own cron, proved by the `x-vercel-cron` header it
  //     always sends, and checked against `CRON_SECRET` when one is set.
  const configured = String(process.env.SCAN_KEY || "");
  const offered = String(req.headers["x-scan-key"] || params.key || params.scan_key || "");
  const cronHeader = String(req.headers["x-vercel-cron"] || "");
  const cronSecret = String(process.env.CRON_SECRET || "");
  const cronCall =
    params.cron === "1" &&
    (cronHeader || req.headers["user-agent"] === "vercel-cron/1.0") &&
    (!cronSecret || offered === cronSecret || String(req.headers.authorization || "") === `Bearer ${cronSecret}`);
  const keyed = (Boolean(configured) && offered === configured) || cronCall;

  // The scheduler restores before it reports: a cold instance that has never
  // ticked still knows where the last pass stopped, and the panel must not show
  // "0 of 14,201" every time the function scales to zero.
  await restoreSchedulerState().catch(() => null);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.end();
  }

  if (req.method === "GET") {
    const report = scheduleReport();
    return done(200, {
      success: true,
      scan: report,
      // No session and no key: coverage only, no findings. A public URL must not
      // be a directory of everything that is broken about the site.
      open: keyed ? report.scanner.open : undefined,
      findings: keyed ? report.scanner.open : undefined,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return done(405, { success: false, error: "Method not allowed" });
  }

  if (!keyed && !params.__session) {
    return done(401, {
      success: false,
      error: configured
        ? "Send the scan key in x-scan-key to run a pass."
        : "Set SCAN_KEY on the deployment to allow scheduled scans, or sign in to the panel.",
    });
  }

  // The pass needs an origin to talk to. The request's own host is the honest
  // default; `SELF_BASE` overrides it where the function cannot reach its
  // public alias (deployment protection, restricted egress).
  const base = selfBaseOf(req);
  if (!base) {
    return done(400, { success: false, error: "No origin to scan from — set SELF_BASE." });
  }

  // A repair runs against registered handles. Without this, every repair throws
  // "Cannot read properties of null (reading 'reload')" — a scan that looks like it
  // tried and failed at everything, on a site that is fine.
  wireHealer({
    caches: { plans: planCache(), renditions: renditionCacheHandle() },
    traffic: () => requestStats(),
    version: process.env.BUILD_STAMP || "",
  });

  // The walk needs the catalogue id list. Without it a pass checks the pages and
  // the routes and then reports "0 batches scanned" — a scanner that never looks
  // at content, which is exactly the failure mode this whole round exists to
  // avoid. A catalogue that cannot be read is a finding of its own, not a reason
  // to call the pass complete.
  let ids = [];
  let catalogError = "";
  try {
    const index = await loadCatalogIndex();
    ids = index.batches.map((b) => b.id).filter(Boolean);
  } catch (err) {
    catalogError = err?.message || "the catalogue index could not be read";
  }

  const started = Date.now();
  const pass = await scanPass({
    base,
    batches: ids,
    budget: params.full === "1" ? 45000 : 25000,
    windowSize: params.full === "1" ? 12 : 6,
  }).catch((err) => ({ error: err?.message || "the scan threw", findings: [] }));

  const actions = [];
  if (pass && !pass.error) {
    // Sightings first: a fault the scan found is recorded even when the repair
    // below is refused by a cooldown, or has no rung left.
    for (const f of pass.findings) {
      if (f.symptom && SYMPTOMS[f.symptom] && !f.blind) reportFault(f.symptom, `${f.what} — ${f.where}`);
    }
    const keys = [...new Set(pass.findings.map((f) => f.symptom).filter((s) => s && SYMPTOMS[s]))];
    for (const symptom of keys) {
      const receipt = await repair(symptom, { reason: "scheduled scan" }).catch((err) => ({
        ok: false,
        ran: false,
        error: err?.message || "the repair threw",
      }));
      actions.push({ symptom, ...receipt });
      if (receipt.ran && receipt.ok) {
        for (const f of pass.findings.filter((x) => x.symptom === symptom)) clearFinding(f.key, { repaired: true });
      }
    }
  }

  noteExternalTick(keyed ? "scheduler" : "operator");
  noteLog({
    level: "info",
    route: "scan",
    message: `${keyed ? "scheduled" : "operator"} scan: ${pass?.checks || 0} checks, ${pass?.findings?.length || 0} finding(s), ${actions.filter((a) => a.ran).length} repair(s) in ${Date.now() - started}ms`,
  });

  const report = scheduleReport();
  return done(pass?.error ? 502 : 200, {
    success: !pass?.error,
    error: pass?.error || catalogError || undefined,
    catalogue: { batches: ids.length, error: catalogError || undefined },
    ms: Date.now() - started,
    scan: {
      ...report,
      last: pass && !pass.error ? { at: pass.at, ms: pass.ms, checks: pass.checks, scanned: pass.scanned, perMille: pass.perMille, complete: pass.complete } : report.scanner.last,
      actions,
    },
  });
}

/* --------------------------------------------------------------- healer */

/**
 * The healer, from the operator's chair.
 *
 *   GET  ?action=heal                     → state only; repairs nothing
 *   POST ?action=heal&sweep=1             → probe everything and repair faults
 *   POST ?action=heal&symptom=<key>       → force one repair at its current rung
 *
 * A GET is deliberately read-only. Opening the panel to look at a fault must
 * never be what changes the site, or an operator can never reproduce the state
 * they were paged about.
 */
async function healRoute(req, res, finish, params) {
  if (req.method === "GET") {
    wireHealer({
      caches: { plans: planCache(), renditions: renditionCacheHandle() },
      traffic: () => requestStats(),
      version: process.env.BUILD_STAMP || "",
    });
    // Probing on a read is fine — probes are read-only — but repairing is not.
    await sweep({ apply: false }).catch(() => null);
    const report = healerReport();
    return finish(200, {
      success: true,
      heal: { ...report, applied: false, actions: [] },
      // The reactive ledger too, so one call paints the whole section.
      selfHeal: selfHealReport(),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }

  wireHealer({
    caches: { plans: planCache(), renditions: renditionCacheHandle() },
    traffic: () => requestStats(),
    version: process.env.BUILD_STAMP || "",
  });

  const symptom = String(params.symptom || "").trim();
  const sweepNow = params.sweep === "1" || (!symptom && params.sweep !== "0");
  const out = await healAction({ sweepNow, symptom }).catch((err) => ({
    ...healerReport(),
    error: err?.message || "the healer threw",
    actions: [],
  }));

  noteLog({
    level: "info",
    route: "admin",
    message: `operator ran the healer${symptom ? ` (${symptom})` : ""}: ${out.actions?.length || 0} action(s)`,
  });

  return finish(200, { success: !out.error, heal: out, selfHeal: selfHealReport(), error: out.error });
}

/**
 * The two caches the healer may empty.
 *
 * `lib/api-data.mjs` registers its own maps with `registerCaches` for the
 * reactive healer; the deliberate one is handed the same maps here, through the
 * module's exported handles rather than by reaching into it.
 */
function planCache() {
  return signMap();
}

function renditionCacheHandle() {
  return renditionMap();
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
 * GET /api/admin?action=dpp-papers&batch=&subject=[&chapter=]
 *
 * The DPP *papers*: one PDF per lecture, guest-readable, with the questions and
 * the answer key inside. This is what the panel runs tests against, because the
 * interactive quiz list (`?action=dpp`) needs a paid student session.
 *
 * Without a chapter it walks the subject's chapters and collects every DPP, in
 * the chapter order the source uses, bounded so one call cannot walk a whole
 * batch inside a 60 s function.
 */
async function dppPapersAction(req, res, finish, params) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }
  const batch = String(params.batch || "").trim();
  const subject = String(params.subject || "").trim();
  if (!batch || !subject) {
    return finish(400, { success: false, error: "batch and subject are required." });
  }

  const wantedChapter = String(params.chapter || "").trim();
  const maxChapters = Math.max(1, Math.min(40, Number(params.chapters) || 12));

  const papers = await withDeadline(
    collectDppPapers({ batch, subject, wantedChapter, maxChapters, fetchChapters, fetchChapterContents }),
    45_000
  ).catch((err) => ({ ok: false, error: err?.message || "The DPP papers timed out.", papers: [] }));

  return finish(papers.ok ? 200 : 502, {
    success: papers.ok,
    batch,
    subject,
    ...papers,
    headline: papers.ok
      ? `${papers.papers.length} paper${papers.papers.length === 1 ? "" : "s"}${
          papers.truncated ? ` (first ${papers.papers.length} of ${papers.total} chapters)` : ""
        }`
      : papers.error,
  });
}


/**
 * GET /api/admin?action=dpp-paper
 *
 * Two kinds of paper, and the panel asks for whichever it has:
 *
 *   ?url=<pdf>          the DPP PDF — guest-readable, so this *works*
 *   ?id=<testId>        the interactive quiz — paid-session only, reported locked
 *
 * The PDF path is the one that runs a test: `lib/dpp-paper.mjs` downloads the
 * paper, extracts its text and splits out questions, options and the answer key.
 * Everything is relayed through this origin so the browser never talks to PW.
 */
async function dppPaperAction(req, res, finish, params) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return finish(405, { success: false, error: "Method not allowed" });
  }

  const url = String(params.url || "").trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      return finish(400, { success: false, error: "url must be absolute." });
    }
    const mediaBase = `${selfBase(req)}/api/media`;
    const paper = await withDeadline(
      readDppPaper({ url, name: String(params.name || ""), mediaBase }),
      45_000
    ).catch((err) => ({
      ok: false,
      error: err?.message || "The paper took too long to read.",
      questions: [],
      stats: { total: 0, answerable: 0 },
    }));

    return finish(paper.ok ? 200 : 502, {
      success: paper.ok,
      // `source: "pdf"` tells the panel it may run the test: the questions are
      // the paper's own, not a quiz that would 401 on the first click.
      source: "pdf",
      locked: false,
      ...paper,
    });
  }

  const id = String(params.id || "").trim();
  if (!id) return finish(400, { success: false, error: "url or id is required." });

  const quiz = await withDeadline(fetchDppPaper({ testId: id }), 20_000).catch((err) => ({
    ok: false,
    locked: false,
    error: err?.message || "The paper timed out.",
    questions: [],
  }));

  return finish(200, {
    success: quiz.ok,
    source: "quiz",
    locked: Boolean(quiz.locked),
    ...quiz,
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
