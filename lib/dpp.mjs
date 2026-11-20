/**
 * DPP (Daily Practice Problems) reader.
 *
 * A DPP is a quiz attached to a lecture: 10 questions, 40 marks, 30 minutes.
 * Physics Wallah serves the *list* of them to a guest — that is the whole reason
 * this module exists — but the questions themselves sit behind a bearer token
 * that a guest account cannot mint. So there are two honest outcomes here:
 *
 *   `questions: [...]`  the paper could be read, and it is complete
 *   `locked: true`      the list is real but the paper needs a paid session
 *
 * Pretending the second case is the first is how a panel ends up offering a
 * "practice test" that 401s on the first question, so the shape is explicit and
 * the UI has to say which one it got.
 */

import { upstreamJson } from "./upstream.mjs";

const LIST_CACHE_SECONDS = 120;
const PAPER_CACHE_SECONDS = 300;

/** One page of PW's DPP list is 10 entries. */
export const DPP_PAGE_SIZE = 10;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalise one row of `/tests/new-dpp-list`.
 *
 * The payload nests everything twice — the row is `{ _id, type, dppQuizDetails }`
 * and the test itself is `dppQuizDetails.test` — so a reader that stops at
 * `dppQuizDetails.name` silently produces blank titles.
 */
function mapDppRow(row) {
  const quiz = row?.dppQuizDetails || {};
  const test = quiz.test || {};
  const id = clean(test._id) || clean(quiz.contentId) || clean(row?._id);
  if (!id) return null;
  return {
    id,
    serial: Number(row?._id) || Number(test.displayOrder) || 0,
    kind: clean(row?.type) || "DPP_QUIZ",
    name: clean(test.name) || "DPP",
    questions: Number(test.totalQuestions) || 0,
    marks: Number(test.totalMarks) || 0,
    minutes: Number(test.maxDuration) || 0,
    createdAt: clean(test.createdAt),
    displayOrder: Number(test.displayOrder) || 0,
    subjective: Boolean(test.isSubjective),
    smart: Boolean(test.smartDPP),
    free: Boolean(quiz.isFree),
    purchased: Boolean(quiz.isPurchased),
    scheduleId: clean(quiz.scheduleId),
    contentId: clean(quiz.contentId),
  };
}

/**
 * The DPP list for one batch subject.
 *
 * `batchSubjectId` is the *batch subject document* id (`subjects[].id` from
 * /api/batch), not the subject slug and not the PW subject id — passing either
 * of those gets an empty list rather than an error, which is how this silently
 * "worked" in the first draft.
 */
export async function fetchDppList({ batch, batchSubjectId, page = 1 }) {
  if (!batch) return { ok: false, error: "A batch id is required.", items: [], total: 0 };
  if (!batchSubjectId) {
    return {
      ok: false,
      error: "A batch subject id is required (subjects[].id from the batch, not the slug).",
      items: [],
      total: 0,
    };
  }
  const safePage = Math.max(1, Math.min(50, Number(page) || 1));
  const res = await upstreamJson(
    `/v3/test-service/tests/new-dpp-list?page=${safePage}&batchId=${encodeURIComponent(
      batch
    )}&batchSubjectId=${encodeURIComponent(batchSubjectId)}`,
    { cacheSeconds: LIST_CACHE_SECONDS, timeout: 20000 }
  );

  if (!res.ok) {
    return {
      ok: false,
      error: discussDppFailure(res),
      auth: /401|403/.test(String(res.error || "")),
      items: [],
      total: 0,
    };
  }

  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  const items = rows.map(mapDppRow).filter(Boolean);
  const total = Number(res.data?.paginate?.totalCount) || items.length;
  const limit = Number(res.data?.paginate?.limit) || DPP_PAGE_SIZE;

  return {
    ok: true,
    items,
    total,
    page: safePage,
    pageSize: limit,
    pages: Math.max(1, Math.ceil(total / Math.max(1, limit))),
    error: "",
  };
}

/** Turn an upstream rejection into a sentence the panel can print. */
function discussDppFailure(res) {
  const raw = String(res?.error || "");
  if (/401|403/.test(raw)) {
    return "Physics Wallah requires a paid student session to list these DPPs. The guest session this site holds can read the papers, not the index.";
  }
  if (/timed out/i.test(raw)) return "Physics Wallah did not answer in time. Try again — this list is cached for two minutes.";
  if (/502|503|504/.test(raw)) return "Physics Wallah's test service is down or restarting. Nothing to fix here; try again shortly.";
  return raw || "The DPP list could not be read.";
}

/**
 * The paper itself: questions, options, marks.
 *
 * Returns `locked: true` rather than an error when PW refuses, because "you are
 * not signed in as a student" is not a failure of this site.
 */
export async function fetchDppPaper({ testId }) {
  if (!testId) return { ok: false, locked: false, error: "A test id is required.", questions: [] };

  const res = await upstreamJson(`/v3/test-service/tests/${encodeURIComponent(testId)}/questions`, {
    cacheSeconds: PAPER_CACHE_SECONDS,
    timeout: 20000,
  });

  if (!res.ok) {
    const locked = /401|403/.test(String(res.error || ""));
    return {
      ok: false,
      locked,
      error: locked
        ? "The paper needs a paid student session. The DPP exists — this site's guest session may not read its questions."
        : discussDppFailure(res),
      questions: [],
      testId,
    };
  }

  const body = res.data?.data || res.data || {};
  const raw = Array.isArray(body.questions) ? body.questions : Array.isArray(body) ? body : [];

  return {
    ok: true,
    locked: false,
    error: "",
    testId,
    name: clean(body.name),
    totalMarks: Number(body.totalMarks) || 0,
    minutes: Number(body.maxDuration) || 0,
    questions: raw.map(mapQuestion).filter(Boolean),
  };
}

function mapQuestion(q, index) {
  const id = clean(q?._id) || clean(q?.id);
  if (!id) return null;
  const options = (
    Array.isArray(q.options) ? q.options : Array.isArray(q?.questionOptions) ? q.questionOptions : []
  )
    .map((opt, i) => ({
      id: clean(opt?._id) || String(i + 1),
      text: stripHtml(opt?.text ?? opt?.name ?? opt?.value ?? ""),
      correct: Boolean(opt?.isCorrect ?? opt?.correct ?? q?.correctOption === opt?._id),
    }))
    .filter((opt) => opt.text);

  return {
    id,
    number: Number(q?.questionNumber) || index + 1,
    text: stripHtml(q?.question ?? q?.text ?? q?.name ?? ""),
    options,
    answer: stripHtml(q?.answer ?? q?.solution ?? ""),
    topic: clean(q?.topic),
    subject: clean(q?.subject),
  };
}

/**
 * Physics Wallah stores question bodies as HTML. The panel renders text, so
 * strip tags and decode the handful of entities that actually appear, rather
 * than shipping an HTML sanitiser into an admin page.
 */
export function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&deg;/gi, "°")
    .replace(/&times;/gi, "×")
    .replace(/&divide;/gi, "÷")
    .replace(/&radic;/gi, "√")
    .replace(/&pi;/gi, "π")
    .replace(/&theta;/gi, "θ")
    .replace(/&lambda;/gi, "λ")
    .replace(/&mu;/gi, "μ")
    .replace(/&omega;/gi, "ω")
    .replace(/&alpha;/gi, "α")
    .replace(/&beta;/gi, "β")
    .replace(/&gamma;/gi, "γ")
    .replace(/&Delta;/g, "Δ")
    .replace(/&rarr;/gi, "→")
    .replace(/&hellip;/gi, "…")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * One line for the panel header: how much practice material a subject has and
 * whether it is readable. Wording matters — "0 papers" and "papers we may not
 * show" are different facts.
 */
export function dppHeadline(list) {
  if (!list) return "No DPP list loaded.";
  if (!list.ok) return list.error || "The DPP list could not be read.";
  if (!list.items?.length) return "This subject has no DPPs.";
  const papers = list.items.length;
  const total = Math.max(list.total || 0, papers);
  const questions = list.items.reduce((sum, it) => sum + (it.questions || 0), 0);
  const marks = list.items.reduce((sum, it) => sum + (it.marks || 0), 0);
  const shown = total > papers ? `${papers} of ${total} papers` : `${papers} papers`;
  return `${shown} · ${questions.toLocaleString()} questions · ${marks.toLocaleString()} marks`;
}

/* ------------------------------------------------- the runnable quiz */

/** Option letters, in the order PW lists the options. */
const LETTERS = "ABCDEFGH";

/** The correct option's letter for one mapped question, or "" if unknown. */
function correctLetter(question) {
  const at = (question.options || []).findIndex((o) => o.correct);
  return at >= 0 ? LETTERS[at] : "";
}

/**
 * The student-facing shape of a quiz paper: questions and options, WITHOUT
 * the key. Same contract as the PDF paper's `testPayload` — the browser
 * must not be able to view-source its way to the answers, so correctness
 * flags are stripped here and only reappear in `scoreQuiz`'s review.
 */
export function quizPayload(paper) {
  const questions = (paper.questions || []).map((q, index) => ({
    number: q.number || index + 1,
    text: q.text,
    topic: q.topic || "",
    options: (q.options || []).map((o, i) => ({ letter: LETTERS[i], text: o.text })),
    scorable: Boolean(correctLetter(q)) && (q.options || []).length >= 2,
  }));
  return {
    title: paper.name || "",
    duration: Number(paper.minutes) || 0,
    totalMarks: Number(paper.totalMarks) || 0,
    stats: {
      total: questions.length,
      answerable: questions.filter((q) => q.scorable).length,
      unreadable: questions.filter((q) => !q.scorable).length,
    },
    questions,
  };
}

/**
 * Mark an attempt against the paper's own key. Answers arrive keyed by
 * question index with a letter value — exactly what the practice page
 * sends for a PDF paper — and the review rows carry everything the
 * analysis renders, including the solution text PW attached.
 */
export function scoreQuiz(paper, answers = {}, { elapsedMs = 0 } = {}) {
  const rows = [];
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let unscored = 0;

  (paper.questions || []).forEach((q, index) => {
    const answer = correctLetter(q);
    const chosen = String(answers?.[index] ?? answers?.[String(index)] ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 1);
    const basis = {
      number: q.number || index + 1,
      index,
      text: q.text,
      topic: q.topic || "",
      options: (q.options || []).map((o, i) => ({ letter: LETTERS[i], text: o.text })),
      answer,
      chosen,
      solution: q.answer || "",
    };
    if (!answer) {
      unscored += 1;
      rows.push({ ...basis, outcome: "unscored" });
    } else if (!chosen) {
      skipped += 1;
      rows.push({ ...basis, outcome: "skipped" });
    } else if (chosen === answer) {
      correct += 1;
      rows.push({ ...basis, outcome: "correct" });
    } else {
      wrong += 1;
      rows.push({ ...basis, outcome: "wrong" });
    }
  });

  const scored = correct + wrong + skipped;
  const percent = scored ? Math.round((correct / scored) * 100) : 0;
  return {
    total: rows.length,
    scored,
    correct,
    wrong,
    skipped,
    unscored,
    percent,
    marks: 4 * correct - wrong,
    elapsedMs: Math.max(0, Number(elapsedMs) || 0),
    verdict:
      !scored
        ? "Nothing to mark"
        : percent >= 90
          ? "Excellent — nearly every answer landed"
          : percent >= 75
            ? "Strong — a few to tighten"
            : percent >= 50
              ? "Getting there — half the paper is solid"
              : percent > 0
                ? "Needs work — go back over this chapter"
                : "Start again from the chapter notes",
    focus: rows.filter((r) => r.outcome === "wrong").map((r) => r.number),
    rows,
  };
}
