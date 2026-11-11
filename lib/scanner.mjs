/**
 * The full-site scanner.
 *
 * The healer in `lib/healer.mjs` watches the *machinery* — the catalogue index,
 * the token ladder, the signer ranking, the relays. It cannot see what a visitor
 * sees: a page that answers 200 with the wrong thing in it, a PDF that 404s, a
 * batch page whose subject list is empty, a chapter whose DPP tab has nothing
 * behind it. This module is the part that walks the site itself.
 *
 * ## The shape of a scan
 *
 * A real scan of this site is 18 pages, 10 routes and 14 201 batches. That does
 * not fit in one request, and pretending otherwise would mean either a function
 * that times out and reports nothing, or a "scan" that only ever looks at page
 * one. So a scan is a **pass** with a budget and a cursor:
 *
 *   • static checks  18 pages + the asset manifest, cheap, every pass
 *   • api checks     the public routes, cheap, every pass
 *   • content checks a *window* of batches, taken from a cursor that persists,
 *                    so consecutive passes walk the whole catalogue and the last
 *                    batch is as likely to be checked as the first
 *
 * A pass stops when its deadline arrives, saves its cursor, and says how much of
 * the site it has covered. `progress.perMille` is the honest number, and the
 * admin panel draws it rather than implying a full sweep that never happened.
 *
 * ## What a check is allowed to do
 *
 * Nothing here repairs. A scanner that also fixes is a scanner you cannot trust
 * to tell you the truth. Findings are *matched to the healer's symptoms* and the
 * healer applies its own ladder — with its own cooldowns, budget and evidence
 * rules. This module's job is to be the eyes, and to be honest about a blind spot
 * it cannot fix at all (`notesOperator`).
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

/** How long one pass may run before it must save its cursor and answer. */
export const PASS_BUDGET_MS = 45000;
/** How many batches a pass walks. Chosen to fit the budget with its API calls. */
export const BATCH_WINDOW = 12;
/** Parallel fetches inside a window. */
const CONCURRENCY = 4;
/** Findings kept for the panel, newest first. */
const FINDINGS_MAX = 120;

/**
 * When any instance last wrote its progress.
 *
 * This is the only *shared* evidence of the cadence: each function instance keeps
 * its own scheduler, so a panel running in one lambda cannot see a slice that ran
 * in another. A timestamp in the store can be seen by all of them — and when no
 * store is attached it is per-instance, which the panel says out loud rather than
 * pretending otherwise.
 *
 * Declared here, above `resetScanner`, because that function clears it: a `let`
 * below a function that assigns it is a crash waiting for the first caller.
 */
let sharedAt = 0;

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

/**
 * The scanner's memory.
 *
 * A pass is *resumable*: `cursor` is where the catalogue walk stopped, and
 * `pass` counts how many passes have run. Both are exported so `lib/scheduler.mjs`
 * can persist them to a store — otherwise a cold start would restart the walk
 * from the first batch every time and twenty batches would be "scanned" forever.
 */
const state = {
  cursor: 0,
  pass: 0,
  lastPassAt: 0,
  lastFullCycleAt: 0,
  consecutiveEmptyPasses: 0,
  /** Findings, newest first, deduped by key. */
  findings: [],
  /** Totals across all passes on this instance. */
  totals: { passes: 0, checks: 0, failures: 0, repaired: 0, needsOperator: 0 },
  /** The last pass's own numbers, for the panel. */
  last: null,
};

export function scannerState() {
  return {
    cursor: state.cursor,
    pass: state.pass,
    lastPassAt: state.lastPassAt,
    lastFullCycleAt: state.lastFullCycleAt,
  };
}

export function restoreScanner(saved = {}) {
  if (!saved || typeof saved !== "object") return;
  if (Number.isFinite(saved.cursor)) state.cursor = Math.max(0, Number(saved.cursor));
  if (Number.isFinite(saved.pass)) state.pass = Math.max(0, Number(saved.pass));
  if (Number.isFinite(saved.lastPassAt)) state.lastPassAt = Number(saved.lastPassAt);
  if (Number.isFinite(saved.lastFullCycleAt)) state.lastFullCycleAt = Number(saved.lastFullCycleAt);
}

/* ---------------------------------------------------------------- */
/* Findings                                                          */
/* ---------------------------------------------------------------- */

/**
 * A finding names *what* is wrong, *where*, and — crucially — *who fixes it*:
 * `symptom` routes it into the healer's ladder, `needsOperator` is the honest
 * "this one needs a human", and `none` means it is informational.
 */
function finding({ severity = "low", area = "content", where = "", what = "", symptom = "", detail = "", at = Date.now(), blind = false, key = "" }) {
  return {
    // A stable key makes a *class* of fault one row: twelve batches with no
    // subjects is one finding seen twelve times, not twelve rows crowding out the
    // page that is actually down. Without it the panel's 120-row budget fills with
    // the same low finding and hides the high one underneath.
    key: (key || `${area}:${where}:${symptom || what}`).slice(0, 180),
    severity,
    area,
    where,
    what,
    symptom,
    detail,
    at,
    atIso: new Date(at).toISOString(),
    // A blind spot is the scanner's own failing, not the site's: the panel draws
    // it differently and the healer is never asked to repair it.
    blind: Boolean(blind),
  };
}

function remember(list, { now = Date.now() } = {}) {
  for (const item of list) {
    const at = item.at || now;
    const existing = state.findings.findIndex((f) => f.key === item.key);
    // `seen` is what makes an aggregate honest: one row for "some batches list no
    // subjects" that says it was seen 40 times is more useful than forty rows.
    const prior = existing >= 0 ? state.findings[existing] : null;
    const record = {
      ...item,
      at,
      atIso: new Date(at).toISOString(),
      seen: (prior ? prior.seen : 0) + 1,
      firstAt: prior ? prior.firstAt || prior.atIso : new Date(at).toISOString(),
    };
    if (existing >= 0) state.findings.splice(existing, 1);
    state.findings.unshift(record);
  }
  state.findings.length = Math.min(state.findings.length, FINDINGS_MAX);
  return list.length;
}

/** A finding that has gone away is *resolved*, not forgotten: the panel says so. */
export function clearFinding(key, { repaired = false } = {}) {
  const i = state.findings.findIndex((f) => f.key === key);
  if (i < 0) return false;
  const [gone] = state.findings.splice(i, 1);
  gone.resolvedAt = new Date().toISOString();
  if (repaired) state.totals.repaired += 1;
  state.resolved = [gone, ...(state.resolved || [])].slice(0, 40);
  return true;
}

export function findings() {
  return {
    open: state.findings.slice(0, 60),
    resolved: (state.resolved || []).slice(0, 12),
    counts: countBy(state.findings),
  };
}

function countBy(list) {
  const out = { high: 0, medium: 0, low: 0 };
  for (const item of list) out[item.severity] = (out[item.severity] || 0) + 1;
  return out;
}

/* ---------------------------------------------------------------- */
/* Fetching                                                          */
/* ---------------------------------------------------------------- */

/**
 * Every check goes through this, so one hung host cannot eat a pass: the
 * deadline is per request *and* per pass, and the pass deadline is what the
 * cursor is saved against.
 */
async function probe(base, pathname, { timeout = 8000, expect = "html", accept = "" } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(new URL(pathname, base), {
      headers: {
        accept: accept || (expect === "json" ? "application/json" : "text/html,application/xhtml+xml"),
        "cache-control": "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
    });
    const type = String(res.headers.get("content-type") || "");
    let body = "";
    // A scan reads bodies to check *content*, not just status — but never more
    // than enough to answer the question.
    if (expect === "json") {
      body = await res.text().catch(() => "");
    } else if (res.ok) {
      body = await res.text().catch(() => "");
    }
    return {
      ok: res.ok,
      status: res.status,
      type,
      body,
      ms: Date.now() - started,
      url: res.url || pathname,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      type: "",
      body: "",
      ms: Date.now() - started,
      error: err?.cause?.code || err?.message || "unreachable",
      url: pathname,
    };
  }
}

/* ---------------------------------------------------------------- */
/* Static checks: the pages a browser can be sent to                 */
/* ---------------------------------------------------------------- */

/**
 * A page is "good" when it answers 200, is HTML, carries its landmark and is not
 * an error page. The site's own 404 has a distinct shape, so a soft 404 served
 * with status 200 is caught here — the failure mode that makes a status-only
 * monitor useless.
 */
function pageFault(res, html) {
  if (res.status === 0) return `unreachable (${res.error || "no answer"})`;
  if (res.status !== 200) return `answered ${res.status}`;
  if (!/text\/html/i.test(res.type)) return `served ${res.type || "no content type"} instead of HTML`;
  if (!/id="main"/.test(html)) return "no <main id=\"main\"> landmark — this is an error shell, not the page";
  if (/<title>\s*404/i.test(html)) return "served the 404 shell with a 200 status";
  return "";
}

/**
 * Is this the site's own not-found page?
 *
 * The status is the honest signal, but it is not the only one a deployment can
 * show: a static host that rewrites everything to `404.html` answers 200 with the
 * right page in it, and the visitor's experience is correct. Judging the *body*
 * keeps the check useful without turning a hosting quirk into a permanent red row.
 */
function notFoundShell(body) {
  return /<title>\s*(404|page not found)/i.test(body) || /went off-syllabus|does not exist \(or moved\)/i.test(body);
}

/** What each page must contain to be worth serving at all. */
export const PAGE_CONTRACT = {
  "index.html": [/Every Physics Wallah batch/i, /id="catalogGrid"/],
  "batches.html": [/id="grid"/, /id="pager"/],
  "batch.html": [/id="tabBody"/],
  // The subject page renders its chapter list into `#list`; there is no
  // `#chapterList` here (that id belongs to the downloads page).
  "subject.html": [/id="list"/, /id="chapterFilter"/],
  "chapter.html": [/id="body"/],
  // The player page is built around `#embed`; a lecture page without it is a
  // shell with no video in it.
  "lecture.html": [/id="embed"/],
  "dpp.html": [/id="dppClock"/, /id="dppAnalysis"/],
  "dashboard.html": [/id="resumeBand"/, /id="historyList"/],
  "leaderboard.html": [/id="boardList"/],
  "library.html": [/id="tabs"/],
  "favourites.html": [/id="body"/],
  "downloads.html": [/id="lectureList"/, /id="chapterList"/],
  "login.html": [/id="googleForm"/],
  // The four pages that are easy to forget and expensive to break: the operator
  // panel (a gate, so a *different* main id), the offline shell the service worker
  // serves, the open-with link handler and the document viewer.
  "admin.html": [/id="gate"/],
  "offline.html": [/id="retry"/],
  "open.html": [/id="openTree"/],
  "viewer.html": [/id="frame"/],
  "404.html": [/404|not found/i],
};

export async function checkPages(base, { budget = PASS_BUDGET_MS, deadline = Date.now() + budget } = {}) {
  const found = [];
  let checks = 0;

  const pages = Object.keys(PAGE_CONTRACT).filter((file) => file !== "404.html");
  const results = await mapLimit(pages, CONCURRENCY, async (file) => {
    if (Date.now() > deadline) return null;
    const pathname = file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`;
    const res = await probe(base, pathname);
    return { file, pathname, res };
  });

  // Blind spot, not outage. A function that cannot reach its own public origin
  // (deployment protection, restricted egress, a wrong SELF_BASE) fails every
  // probe at the transport layer. Reporting that as eighteen broken pages would
  // be a lie the healer would act on — it would burn its repair budget on a fault
  // that is on the scanner's side of the wire. One finding, no symptom, operator.
  const answered = results.filter((row) => row && row.res.status !== 0);
  if (results.some(Boolean) && answered.length === 0) {
    return {
      findings: [
        finding({
          severity: "medium",
          area: "pages",
          where: base,
          what: "the scanner could not reach the site from inside the deployment",
          symptom: "",
          detail: `${results.filter(Boolean).length} page(s) tried and none answered — set SELF_BASE to the public origin`,
          blind: true,
        }),
      ],
      checks: results.filter(Boolean).length,
      blind: true,
    };
  }

  for (const row of results) {
    if (!row) continue;
    checks += 1;
    const { file, pathname, res } = row;
    const fault = pageFault(res, res.body);
    if (fault) {
      found.push(
        finding({
          severity: file === "404.html" ? "low" : "high",
          area: "pages",
          where: pathname,
          what: `${file} is not being served correctly`,
          symptom: "site.page",
          detail: fault,
        })
      );
      continue;
    }
    // A page can answer 200 and still be missing the thing it exists for.
    for (const pattern of PAGE_CONTRACT[file] || []) {
      if (!pattern.test(res.body)) {
        found.push(
          finding({
            severity: "medium",
            area: "pages",
            where: pathname,
            what: `${file} answered but is missing its content`,
            symptom: "site.page",
            detail: `no match for ${String(pattern).slice(0, 60)} — the shell served, the page inside did not`,
          })
        );
        break;
      }
    }
  }

  // The not-found shell is checked where it actually has to work: on a URL that
  // does not exist. A 404 page that is present but never served is invisible to
  // every other check on this list.
  const missing = await probe(base, "/this-page-does-not-exist-scan-check");
  checks += 1;
  if (missing.status === 0) {
    found.push(
      finding({
        severity: "low",
        area: "pages",
        where: "/<missing>",
        what: "the not-found route did not answer",
        symptom: "site.page",
        detail: missing.error || "unreachable",
      })
    );
  } else if (missing.status !== 404 && !notFoundShell(missing.body)) {
    found.push(
      finding({
        severity: "medium",
        area: "pages",
        where: "/<missing>",
        what: `an unknown URL answered ${missing.status} instead of 404`,
        symptom: "site.page",
        detail: "a catch-all is swallowing typos, so broken links never look broken",
      })
    );
  }

  return { findings: found, checks };
}

/* ---------------------------------------------------------------- */
/* API checks: the routes the pages call                             */
/* ---------------------------------------------------------------- */

/**
 * The public API surface. Each entry says what a good answer looks like, because
 * "200 with `{success:false}`" is the site's own way of reporting a failure and a
 * status-only check would call it healthy.
 */
export const API_CONTRACT = [
  {
    path: "/api/batches?page=1",
    json: true,
    ok: (d) => Array.isArray(d?.batches) && d.batches.length > 5,
    what: "the catalogue route returned no batches",
    symptom: "catalog.unreadable",
  },
  {
    // The pages' own data routes. `/api/batches` is the catalogue; these three are
    // what a browser calls when someone opens a batch, a subject and a chapter,
    // and they fail differently. Checked with arguments the site itself ships, so
    // a bad answer here is a bad answer for a real visitor.
    path: "/api/batch?id=698ad3519549b300a5e1cc6a&header=1",
    json: true,
    ok: (d) => Boolean(d?.batch && (d.batch.id || d.batch._id)),
    what: "a batch page's data route returned no batch",
    symptom: "api.upstream",
  },
  {
    path: "/api/contents?batch=698ad3519549b300a5e1cc6a",
    json: true,
    // The subject route answers chapters; an empty list is the failure worth
    // catching, because the page then renders a subject with nothing in it.
    ok: (d) => Array.isArray(d?.chapters) && d.chapters.length > 0,
    what: "a batch's subject returned no chapters",
    symptom: "api.upstream",
  },
  {
    path: "/api/batches?page=1&pageSize=1",
    json: true,
    ok: (d) => Array.isArray(d?.batches) && d.batches.length === 1,
    what: "paging is broken — asking for one batch returned something else",
    symptom: "api.route",
  },
  {
    // The filter facets. These are computed over the whole catalogue, which is the
    // expensive path and the one that silently returns empty counts when the index
    // is thin.
    path: "/api/batches?facets=1",
    json: true,
    ok: (d) => Array.isArray(d?.languages) && d.languages.length > 0 && Boolean(d?.prices),
    what: "the catalogue facets came back empty",
    symptom: "catalog.unreadable",
  },
  {
    // Search has its own path through the index and is the route most likely to
    // be quietly broken, because an empty result looks like "no such batch".
    path: "/api/batches?search=arjuna&pageSize=3",
    json: true,
    ok: (d) => Array.isArray(d?.batches) && d.batches.length > 0,
    what: "searching for a batch that exists returned nothing",
    symptom: "api.upstream",
  },
  {
    path: "/api/token",
    json: true,
    ok: (d) => Boolean(d?.token),
    what: "the token route could not report a credential",
    symptom: "token.exhausted",
  },
  {
    path: "/api/check",
    json: true,
    // This one is *expected* to answer 400: it is the argument check. A 200 here
    // would mean the route stopped validating its input.
    ok: (d) => d?.success === false,
    what: "the health route accepted a request with no arguments",
    symptom: "api.route",
    expectStatus: 400,
  },
];

export async function checkApi(base, { deadline = Date.now() + PASS_BUDGET_MS, sampleId = "" } = {}) {
  const found = [];
  let checks = 0;
  let answered = 0;

  // One extra check against a batch taken from the live catalogue rather than a
  // fixed id: the sample moves with the cursor, so the route is exercised against
  // whatever the catalogue holds today instead of one id that happens to work.
  const contract = sampleId
    ? [
        ...API_CONTRACT,
        {
          path: `/api/batch?id=${encodeURIComponent(sampleId)}&header=1`,
          json: true,
          ok: (d) => Boolean(d?.batch && (d.batch.id || d.batch._id)),
          what: "a live batch's header did not resolve",
          symptom: "api.upstream",
        },
      ]
    : API_CONTRACT;

  for (const spec of contract) {
    if (Date.now() > deadline) break;
    const res = await probe(base, spec.path, { expect: "json", timeout: 10000 });
    checks += 1;
    if (res.status !== 0) answered += 1;
    if (res.status === 0) {
      found.push(
        finding({
          severity: "high",
          area: "api",
          where: spec.path,
          what: "the route did not answer",
          // A route that cannot answer at all is the upstream's fault, never the
          // route's own contract: the difference decides which repair runs.
          symptom: spec.symptom === "api.route" ? "api.upstream" : spec.symptom,
          detail: res.error || "unreachable",
        })
      );
      continue;
    }
    const expected = spec.expectStatus || 200;
    if (res.status !== expected) {
      found.push(
        finding({
          severity: res.status >= 500 ? "high" : "medium",
          area: "api",
          where: spec.path,
          what: `the route answered ${res.status}, expected ${expected}`,
          symptom: spec.symptom,
          detail: res.body.slice(0, 160),
        })
      );
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      found.push(
        finding({
          severity: "high",
          area: "api",
          where: spec.path,
          what: "the route answered with something that is not JSON",
          symptom: spec.symptom,
          detail: res.body.slice(0, 120),
        })
      );
      continue;
    }
    if (spec.ok && !spec.ok(parsed)) {
      found.push(
        finding({
          severity: "high",
          area: "api",
          where: spec.path,
          what: spec.what,
          symptom: spec.symptom,
          detail: `answer: ${JSON.stringify(parsed).slice(0, 160)}`,
        })
      );
    }
  }

  if (checks && !answered) {
    // Same rule as the pages: nothing answered at all is the scanner's problem.
    return {
      findings: [
        finding({
          severity: "medium",
          area: "api",
          where: base,
          what: "the scanner could not reach any API route from inside the deployment",
          symptom: "",
          detail: "no route answered — this is the scanner's egress, not the site",
          blind: true,
        }),
      ],
      checks,
      blind: true,
    };
  }

  return { findings: found, checks };
}

/* ---------------------------------------------------------------- */
/* Content checks: a window of real batches                          */
/* ---------------------------------------------------------------- */

/**
 * The content walk. Each batch is checked the way a reader would open it:
 *
 *   1. its page answers and carries the tabs;
 *   2. its detail route returns a subject list — a batch with none is a dead end;
 *   3. the first subject returns chapters;
 *   4. the first chapter that claims DPPs returns papers, and each paper's PDF is
 *      reachable (a 404 here is a broken Practice button).
 *
 * Bounded at every step so one batch cannot eat the pass.
 */
export async function checkBatch(base, batchId, { deadline = Date.now() + PASS_BUDGET_MS } = {}) {
  const found = [];
  let checks = 0;

  if (Date.now() > deadline) return { findings: found, checks };

  // 1. The page a reader is sent to.
  const page = await probe(base, `/batch.html?id=${encodeURIComponent(batchId)}`);
  checks += 1;
  const fault = pageFault(page, page.body);
  if (fault) {
    found.push(
      finding({ severity: "high", area: "content", where: `/batch.html?id=${batchId}`, what: "a batch page is not being served", symptom: "site.page", detail: fault, key: "content:batch-page:site.page" })
    );
    return { findings: found, checks };
  }

  // Unreachable at the transport layer is not this batch's fault: the page pass
  // has already reported the blind spot, and one dead network would otherwise
  // produce a high-severity finding per batch.
  if (page.status === 0) return { findings: found, checks };

  // 2. The record behind it. Deliberately *without* `header=1`: the slim header
  //    answers `subjects: null` by design, so a scan that asked for it would
  //    report every batch on the site as having no subjects.
  const detail = await probe(base, `/api/batch?id=${encodeURIComponent(batchId)}`, { expect: "json", timeout: 12000 });
  checks += 1;
  if (!detail.ok) {
    found.push(
      finding({ severity: "medium", area: "content", where: `/api/batch?id=${batchId}`, what: "a batch's detail route failed", symptom: "api.upstream", detail: `answered ${detail.status || detail.error}`, key: "content:batch-detail:api.upstream" })
    );
    return { findings: found, checks };
  }
  let info = null;
  try {
    info = JSON.parse(detail.body);
  } catch {
    found.push(finding({ severity: "medium", area: "content", where: `/api/batch?id=${batchId}`, what: "a batch's detail route answered non-JSON", symptom: "api.upstream", detail: detail.body.slice(0, 120), key: "content:batch-json:api.upstream" }));
    return { findings: found, checks };
  }
  const subjects = info?.subjects || [];
  if (!subjects.length) {
    // Deliberately *not* a failure: a batch can genuinely have no subjects
    // published. It is reported as low severity because a reader landing on it
    // sees an empty page with no explanation.
    found.push(
      finding({ severity: "low", area: "content", where: `/batch.html?id=${batchId}`, what: "some batches list no subjects", symptom: "", detail: `${info?.batch?.name || batchId} opens to an empty subject list`, key: "content:no-subjects" })
    );
    return { findings: found, checks };
  }

  // 3. Its first subject's chapters.
  //
  // The route needs the subject *document id*; a catalogue-derived id list has no
  // subjects array to take one from. Both spellings are tried before this counts
  // as a fault, because a subject the route rejects (400) and a subject with no
  // chapters (200, empty) are different findings and only the second is the
  // site's problem.
  const subject = subjects[0];
  const candidates = [...new Set([String(subject.id || ""), String(subject.slug || "")].filter(Boolean))];
  let chapterRes = null;
  let chapters = [];
  for (const candidate of candidates) {
    chapterRes = await probe(
      base,
      `/api/contents?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(candidate)}`,
      { expect: "json", timeout: 12000 }
    );
    checks += 1;
    if (chapterRes.ok) {
      try {
        chapters = JSON.parse(chapterRes.body)?.chapters || [];
      } catch {
        chapters = [];
      }
      break;
    }
    if (chapterRes.status !== 400) break;
  }
  if (chapterRes && chapterRes.status === 400) {
    // The route refused both spellings: a contract mismatch, not an empty subject.
    found.push(
      finding({
        severity: "medium",
        area: "content",
        where: `/api/contents?batch=${batchId}`,
        what: "the contents route refused a subject it should recognise",
        symptom: "api.route",
        detail: chapterRes.body.slice(0, 140),
      })
    );
    return { findings: found, checks };
  }
  if (!chapters.length) {
    found.push(
      finding({
        severity: "medium",
        area: "content",
        where: `/subject.html?batch=${batchId}&subject=${encodeURIComponent(subject.slug || "")}`,
        what: "a subject's chapter list is empty",
        symptom: "api.upstream",
        key: "content:empty-chapters:api.upstream",
        detail: `${subject.name || subject.slug} on ${info?.batch?.name || batchId}`,
      })
    );
    return { findings: found, checks };
  }

  // 4. The first chapter that *claims* DPPs must have some, and its paper must
  //    be reachable. This is the step that catches a broken Practice button,
  //    which no status check on the site can see.
  const withDpp = chapters.find((c) => (Number(c.exercises) || 0) > 0);
  if (withDpp && Date.now() < deadline) {
    const papersRes = await probe(
      base,
      `/api/contents?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subject.slug || subject.id)}&topic=${encodeURIComponent(withDpp.id)}&type=DppNotes`,
      { expect: "json", timeout: 14000 }
    );
    checks += 1;
    let papers = [];
    if (papersRes.ok) {
      try {
        papers = JSON.parse(papersRes.body)?.items || [];
      } catch {
        papers = [];
      }
    }
    const docs = papers.flatMap((item) => item.docs || []).filter((d) => d.url);
    if (!docs.length) {
      found.push(
        finding({
          severity: "medium",
          area: "content",
          where: `/chapter.html?batch=${batchId}&chapter=${encodeURIComponent(withDpp.id)}`,
          what: "a chapter advertises DPPs but lists no paper",
          symptom: "api.upstream",
          detail: `${withDpp.name || withDpp.id} says ${withDpp.exercises} DPP(s); the list came back empty`,
        })
      );
    } else if (Date.now() < deadline) {
      // One paper's PDF, through the site's own relay: the exact URL a Practice
      // button hands the reader.
      const paper = docs[0];
      const pdf = await probe(base, `/api/media?url=${encodeURIComponent(paper.url)}`, { timeout: 14000, accept: "application/pdf,*/*" });
      checks += 1;
      const isPdf = /pdf/i.test(pdf.type) || /^%PDF/.test(pdf.body.slice(0, 5));
      if (!pdf.ok || !isPdf) {
        found.push(
          finding({
            severity: "high",
            area: "content",
            where: paper.name || paper.url,
            what: "a DPP paper is not downloadable",
            symptom: "relay.failing",
            detail: `answered ${pdf.status || pdf.error}${pdf.type ? ` as ${pdf.type}` : ""} — every Practice button for it is dead`,
          })
        );
      }
    }
  }

  return { findings: found, checks };
}

/* ---------------------------------------------------------------- */
/* The pass                                                          */
/* ---------------------------------------------------------------- */

/**
 * Run one scan pass.
 *
 * `base` is the site's own origin. `batches` is the catalogue id list (the caller
 * already has it — `lib/catalog.mjs` indexes all 14 201), and the pass takes a
 * window from `cursor`, wrapping around so coverage is continuous rather than a
 * prefix.
 */
export async function scanPass({
  base,
  batches = [],
  budget = PASS_BUDGET_MS,
  windowSize = BATCH_WINDOW,
  now = Date.now(),
  onFinding = null,
} = {}) {
  const deadline = now + budget;
  const started = Date.now();
  const cursorBefore = state.cursor;

  const pages = await checkPages(base, { deadline });
  const api = await checkApi(base, { deadline, sampleId: batches[state.cursor] || batches[0] || "" });

  // The content window: from the cursor, wrapping around the catalogue.
  const windowFindings = [];
  let checks = pages.checks + api.checks;
  let scanned = 0;

  if (batches.length) {
    const take = Math.min(windowSize, batches.length);
    let offset = 0;
    while (scanned < take && Date.now() <= deadline) {
      const index = (state.cursor + offset) % batches.length;
      const id = batches[index];
      offset += 1;
      if (!id) continue;
      const out = await checkBatch(base, id, { deadline });
      windowFindings.push(...out.findings);
      checks += out.checks;
      // Advance by one *checked* batch, never by the window: a pass that runs
      // out of budget halfway must not skip the rest of the window, or those
      // batches would never be looked at on this cycle.
      state.cursor = (state.cursor + 1) % batches.length;
      scanned += 1;
    }
  }

  const all = [...pages.findings, ...api.findings, ...windowFindings];
  const now2 = Date.now();
  remember(all, { now: now2 });
  state.pass += 1;
  state.lastPassAt = now2;
  state.totals.passes += 1;
  state.totals.checks += checks;
  state.totals.failures += all.length;

  // A full cycle is when the cursor has come all the way round.
  const perMille = batches.length ? Math.round((state.cursor / batches.length) * 1000) : 0;
  // A full cycle is the cursor coming all the way round: the point at which every
  // batch has been looked at once since the last one.
  if (cursorBefore > 0 && state.cursor < cursorBefore) state.lastFullCycleAt = now2;

  const needsOperator = all.filter((f) => !f.symptom);
  // One blind spot is one finding: if the scanner cannot reach the site at all,
  // the page pass and the API pass would otherwise report the same thing twice.
  const blind = Boolean(pages.blind || api.blind);
  state.totals.needsOperator += needsOperator.length;

  if (onFinding) for (const item of all) onFinding(item);

  state.last = {
    at: new Date(now2).toISOString(),
    ms: Date.now() - started,
    checks,
    scanned,
    pages: pages.checks,
    api: api.checks,
    findings: all.length,
    blind,
    perMille,
    budgetMs: budget,
    complete: Date.now() < deadline,
  };

  return {
    ...state.last,
    findings: all,
    progress: {
      cursor: state.cursor,
      of: batches.length,
      perMille,
      pass: state.pass,
      fullCycleAt: state.lastFullCycleAt ? new Date(state.lastFullCycleAt).toISOString() : "",
    },
  };
}

/** Reset for tests, and for a redeploy that should not inherit a stale walk. */
export function resetScanner() {
  sharedAt = 0;
  state.cursor = 0;
  state.pass = 0;
  state.lastPassAt = 0;
  state.lastFullCycleAt = 0;
  state.consecutiveEmptyPasses = 0;
  state.findings.length = 0;
  state.resolved = [];
  state.totals = { passes: 0, checks: 0, failures: 0, repaired: 0, needsOperator: 0 };
  state.last = null;
}

/** Everything the panel needs about the scanner, in one shape. */
export function noteSharedProgress(at = Date.now()) {
  sharedAt = Number(at) || Date.now();
}

export function scannerReport() {
  const found = findings();
  return {
    sharedAt: sharedAt ? new Date(sharedAt).toISOString() : "",
    last: state.last,
    progress: {
      cursor: state.cursor,
      pass: state.pass,
      lastPassAt: state.lastPassAt ? new Date(state.lastPassAt).toISOString() : "",
      lastFullCycleAt: state.lastFullCycleAt ? new Date(state.lastFullCycleAt).toISOString() : "",
    },
    totals: state.totals,
    open: found.open,
    resolved: found.resolved,
    counts: found.counts,
  };
}

/* ---------------------------------------------------------------- */
/* The asset manifest                                                */
/* ---------------------------------------------------------------- */

/**
 * `build.json` promises a set of pages; the disk either has them or it does not.
 * A page promised and missing is a hard 404 for anyone who follows a link.
 */
export async function checkAssets() {
  const found = [];
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(PUBLIC, "build.json"), "utf8"));
  } catch (err) {
    return {
      findings: [
        finding({ severity: "high", area: "assets", where: "/build.json", what: "the build manifest is unreadable", symptom: "assets.stale", detail: err?.message || "" }),
      ],
      checks: 1,
    };
  }

  let checks = 1;
  const promised = (manifest.pages || []).map((p) => (p.endsWith(".html") ? p : `${p}`));
  let onDisk = [];
  try {
    onDisk = (await readdir(PUBLIC)).filter((f) => f.endsWith(".html"));
  } catch {
    onDisk = [];
  }
  const missing = promised.filter((f) => !onDisk.includes(f));
  checks += promised.length;
  if (missing.length) {
    found.push(
      finding({
        severity: "high",
        area: "assets",
        where: "/build.json",
        what: `${missing.length} promised page(s) are not on disk`,
        symptom: "assets.stale",
        detail: missing.slice(0, 6).join(", "),
      })
    );
  }

  return { findings: found, checks };
}

/** Run the local (non-network) checks. Kept separate so they work with no base. */
export async function localChecks() {
  const assets = await checkAssets();
  return assets;
}

/* ---------------------------------------------------------------- */
/* Small helpers                                                     */
/* ---------------------------------------------------------------- */

/** A bounded parallel map that preserves order and never rejects. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length).fill(null);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}
