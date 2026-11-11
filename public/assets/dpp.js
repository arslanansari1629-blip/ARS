/* DPP practice — attempt a paper, submit, read the analysis.
 *
 * The questions arrive without the answer key (`GET /api/pdf?dpp=…`), the key
 * arrives only with the marked attempt (`POST /api/pdf?dpp=…`). So this page
 * cannot cheat on the student's behalf, and "view source" cannot spoil the test.
 *
 * The attempt is kept in `localStorage` per paper, so a refresh — or a phone
 * locking itself mid-paper — does not cost the answers. It is dropped the moment
 * the paper is submitted, because a finished attempt should not be restored over
 * the analysis.
 */

import { mountChrome, esc, qs, toast, setPageMeta } from "./app.js";

mountChrome("batches");

// `dpp` is the paper's address and `paper` its name — but a chapter's Practice link
// carries the address as `paper`, and a link is the only way in. Accept either, so a
// hand-written or older link opens the paper it names instead of the empty state.
const paperUrl = qs("dpp") || qs("paper");
const paperName = qs("name");
const batchId = qs("batch");
const subjectSlug = qs("subject");
const chapterId = qs("chapter");
const chapterName = qs("name");

const intro = document.getElementById("intro");
const introTitle = document.getElementById("dppIntroTitle");
const introNote = document.getElementById("dppIntroNote");
const loading = document.getElementById("dppLoading");
const testEl = document.getElementById("dppTest");
const sheet = document.getElementById("dppSheet");
const palette = document.getElementById("dppPalette");
const analysis = document.getElementById("dppAnalysis");

/** Key letters on the keyboard, in option order. */
const KEY_LETTERS = "ABCDEFGH".split("");

/**
 * Timers, taken from the document rather than the global scope.
 *
 * A practice clock belongs to the page it is counting down for: when the page
 * goes away the interval must go with it. Registered on `window`, that is true
 * by construction — which matters in the test harness, where a jsdom window is
 * closed between tests and a stray global interval would keep the process alive
 * for the rest of the run.
 */
const every = (fn, ms) => window.setInterval(fn, ms);
const stopEvery = (id) => window.clearInterval(id);

const state = {
  /** { title, duration, questions: [{ number, text, options, scorable }] } */
  paper: null,
  /** index → letter */
  answers: new Map(),
  /** indexes the student wants to come back to */
  marked: new Set(),
  startedAt: 0,
  elapsedBefore: 0,
  submitted: false,
  timer: null,
  lastTick: 0,
  review: [],
  reviewFilter: "all",
};

const STORE = `arsvibe.dpp.${paperUrl || "none"}`;

/* ------------------------------------------------------------------ boot */

if (!paperUrl) {
  introTitle.textContent = "Pick a DPP paper first";
  introNote.innerHTML =
    "Open a chapter, choose the <strong>DPPs</strong> tab and press <strong>Practice</strong> " +
    "on a paper. Every paper is a real Physics Wallah DPP, marked against its own key.";
  loading.hidden = true;
  intro.classList.add("is-empty");
} else {
  if (paperName) introTitle.textContent = paperName;
  document.title = `${paperName || "DPP practice"} — ArsVibe PW`;
  setPageMeta({
    title: `${paperName || "DPP practice"} — ArsVibe PW`,
    description: "Attempt this Physics Wallah DPP paper online and see the marks and analysis immediately.",
  });
  loadPaper();
}

async function loadPaper() {
  try {
    const res = await fetch(`/api/pdf?dpp=${encodeURIComponent(paperUrl)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      fail(data.error || `The paper could not be read (${res.status}).`);
      return;
    }
    if (!data.questions || !data.questions.length) {
      fail("No questions could be read from this paper. It may be a scanned image.");
      return;
    }
    startTest(data);
  } catch (err) {
    fail(err?.message || "The paper could not be read.");
  }
}

/**
 * The relay URL for the paper itself.
 *
 * A declaration, not a `const` arrow: `fail()` uses it, and `fail()` can run
 * before this line is reached — a module that throws while booting shows a
 * blank page, which is the worst possible answer to "the paper would not read".
 */
function pdfHref() {
  return `/api/media?url=${encodeURIComponent(paperUrl)}`;
}

function fail(message) {
  loading.hidden = true;
  introTitle.textContent = "This paper could not be read";
  introNote.innerHTML = `${esc(message)} <br /><br />
    <a class="btn btn-ghost btn-sm" href="${esc(backHref())}">Back to the chapter</a>
    <a class="btn btn-ghost btn-sm" href="${esc(pdfHref())}" target="_blank" rel="noopener">Open the PDF instead</a>`;
  testEl.hidden = true;
}

function backHref() {
  if (!batchId || !subjectSlug || !chapterId) return "/batches.html";
  return (
    `/chapter.html?batch=${encodeURIComponent(batchId)}` +
    `&subject=${encodeURIComponent(subjectSlug)}` +
    `&chapter=${encodeURIComponent(chapterId)}` +
    `&name=${encodeURIComponent(chapterName || "")}#dpp`
  );
}

/* ------------------------------------------------------------------ start */

function startTest(paper) {
  state.paper = paper;
  state.submitted = false;
  state.review = [];
  state.reviewFilter = "all";

  intro.hidden = true;
  testEl.hidden = false;
  analysis.hidden = true;

  const scorable = paper.questions.filter((q) => q.scorable).length;
  const unreadable = paper.questions.length - scorable;

  document.getElementById("dppTitle").textContent = paper.title || paperName || "DPP paper";
  document.getElementById("dppChapter").textContent = chapterName || paperName || "Daily practice problem";
  document.getElementById("dppMeta").textContent = [
    `${paper.questions.length} question${paper.questions.length === 1 ? "" : "s"}`,
    scorable ? `${scorable} scorable` : "",
    unreadable ? `${unreadable} not scorable (the PDF did not give us their options)` : "",
    paper.pages ? `${paper.pages} page${paper.pages === 1 ? "" : "s"}` : "",
    "marked against the paper's own key",
  ]
    .filter(Boolean)
    .join(" · ");
  // The sheet is drawn before the saved attempt is restored: painting a restored
  // choice needs the element it belongs to, and it did not exist yet.
  renderSheet();
  renderPalette();

  const saved = restore();
  document.getElementById("dppScorable").textContent = saved ? restoredNote(saved) : "";
  updateProgress();

  const minutes = Number(paper.duration) || 0;
  const clock = document.getElementById("dppClock");
  clock.classList.toggle("is-open", minutes <= 0);
  document.getElementById("dppClockLabel").textContent = minutes > 0 ? "time left" : "practice";

  state.startedAt = saved?.startedAt || Date.now();
  state.elapsedBefore = saved?.elapsedMs || 0;
  state.lastTick = Date.now();
  tick();
  state.timer = every(tick, 1000);

  if (paper.duration > 0) {
    const endsAt = state.startedAt + paper.duration * 60_000;
    const left = endsAt - Date.now();
    if (left <= 0) {
      // A restored attempt that already spent its clock: mark it now rather than
      // showing a countdown that has passed.
      submit();
      return;
    }
  }

  document.getElementById("dppOpenPdf").href = pdfHref();
  document.getElementById("dppBackChapter").href = backHref();
  document.getElementById("dppOpenPdf").textContent = "Open the paper PDF";
}

function restoredNote(saved) {
  const answered = Object.keys(saved.answers || {}).length;
  if (!answered) return "";
  return `${answered} answer${answered === 1 ? "" : "s"} restored from your last visit`;
}

/* --------------------------------------------------------------- the sheet */

function renderSheet() {
  sheet.innerHTML = state.paper.questions
    .map((question, index) => questionBlock(question, index))
    .join("");
}

function questionBlock(question, index) {
  const options = (question.options || [])
    .map(
      (option) => `
      <label class="dpp-choice" data-letter="${esc(option.letter)}">
        <input type="radio" name="q${index}" value="${esc(option.letter)}"
          data-index="${index}" data-letter="${esc(option.letter)}" />
        <span class="dpp-choice-key">${esc(option.letter)}</span>
        <span class="dpp-choice-text">${esc(option.text)}</span>
      </label>`
    )
    .join("");

  const body = question.scorable
    ? `<div class="dpp-options" role="radiogroup" aria-label="Options for question ${esc(
        question.number
      )}">${options}</div>`
    : `<p class="dpp-unscorable">
        The paper prints this question as an image, so its options could not be read.
        The answer from the key is shown when you submit — it is not counted either way.
      </p>`;

  return `
    <article class="dpp-q" id="q-${index}" data-index="${index}" tabindex="-1">
      <header class="dpp-q-head">
        <span class="dpp-q-num">Q${esc(question.number)}</span>
        <button class="dpp-mark" type="button" data-mark="${index}"
          aria-pressed="false" title="Mark this question to revisit">Mark</button>
      </header>
      <p class="dpp-q-text">${esc(question.text || "—")}</p>
      ${body}
      <p class="dpp-q-note tiny" role="status"></p>
    </article>`;
}

function renderPalette() {
  palette.innerHTML = state.paper.questions
    .map(
      (question, index) => `
      <button class="dpp-pal" type="button" data-jump="${index}"
        title="Question ${esc(question.number)}"
        ${state.answers.has(index) ? 'data-state="done"' : ""}
        ${state.marked.has(index) ? 'data-marked="true"' : ""}
        ${question.scorable ? "" : 'aria-disabled="true"'}>${esc(question.number)}</button>`
    )
    .join("");
}

/* ------------------------------------------------------------- interaction */

sheet.addEventListener("change", (event) => {
  const input = event.target.closest("input[type=radio]");
  if (!input || state.submitted) return;
  answerAt(Number(input.dataset.index), input.value);
});

sheet.addEventListener("click", (event) => {
  const mark = event.target.closest("[data-mark]");
  if (!mark || state.submitted) return;
  toggleMark(Number(mark.dataset.mark));
});

palette.addEventListener("click", (event) => {
  const jump = event.target.closest("[data-jump]");
  if (!jump) return;
  focusQuestion(Number(jump.dataset.jump));
});

function answerAt(index, letter) {
  if (!KEY_LETTERS.includes(String(letter || "").toUpperCase())) return;
  state.answers.set(index, String(letter).toUpperCase());
  paintChoice(index);
  updateProgress();
  save();
}

/**
 * Paint one question's choice state.
 *
 * The radio's own `checked` flag is set here rather than left to the browser,
 * because an answer can also be given from the keyboard palette (or restored
 * from storage), where no click ever reached the input.
 */
function paintChoice(index) {
  const question = document.getElementById(`q-${index}`);
  if (!question) return;
  const chosen = state.answers.get(index) || "";
  question.querySelectorAll(".dpp-choice").forEach((label) => {
    const on = label.dataset.letter === chosen;
    label.classList.toggle("is-chosen", on);
    const input = label.querySelector("input");
    if (input) input.checked = on;
  });
  const pal = palette.querySelector(`[data-jump="${index}"]`);
  if (pal) {
    if (chosen) pal.dataset.state = "done";
    else delete pal.dataset.state;
  }
}

function toggleMark(index) {
  if (state.marked.has(index)) state.marked.delete(index);
  else state.marked.add(index);
  const question = document.getElementById(`q-${index}`);
  const button = question?.querySelector("[data-mark]");
  const on = state.marked.has(index);
  button?.setAttribute("aria-pressed", String(on));
  question?.classList.toggle("is-marked", on);
  const pal = palette.querySelector(`[data-jump="${index}"]`);
  if (pal) {
    if (on) pal.dataset.marked = "true";
    else delete pal.dataset.marked;
  }
  save();
}

function focusQuestion(index) {
  const question = document.getElementById(`q-${index}`);
  if (!question) return;
  question.scrollIntoView?.({ behavior: "smooth", block: "center" });
  question.classList.remove("is-touched");
  // Restart the highlight: removing and re-adding in the same frame would not
  // re-run the animation.
  requestAnimationFrame(() => question.classList.add("is-touched"));
  question.focus?.({ preventScroll: true });
  state.focusIndex = index;
}

function updateProgress() {
  const total = state.paper ? state.paper.questions.length : 0;
  const scorable = state.paper ? state.paper.questions.filter((q) => q.scorable).length : 0;
  const answered = [...state.answers.keys()].filter(
    (i) => state.paper && state.paper.questions[i]?.scorable
  ).length;
  document.getElementById("dppAnswered").textContent = `${answered} of ${scorable} answered`;
  const percent = scorable ? Math.round((answered / scorable) * 100) : 0;
  const fill = document.getElementById("dppProgressFill");
  if (fill) fill.style.width = `${percent}%`;
  state.progress = percent;
}

/* ------------------------------------------------------------------ clocks */

function tick() {
  const now = Date.now();
  const spent = state.elapsedBefore + (state.submitted ? 0 : now - state.lastTick);
  const elapsed = document.getElementById("dppElapsed");
  if (elapsed) elapsed.textContent = clockOf(spent);

  const minutes = Number(state.paper?.duration) || 0;
  const value = document.getElementById("dppClockValue");
  if (!value) return;

  if (!minutes) {
    value.textContent = clockOf(spent);
    document.getElementById("dppClock").classList.remove("is-low");
    return;
  }

  const left = Math.max(0, state.startedAt + minutes * 60_000 - now);
  value.textContent = clockOf(left);
  const clock = document.getElementById("dppClock");
  clock.classList.toggle("is-low", left <= 60_000 && left > 0);
  // Running out of time submits, which is what a real paper does.
  if (!left && !state.submitted) {
    toast("Time is up — submitting your paper", "info");
    submit();
  }
}

function clockOf(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function elapsedMs() {
  if (state.submitted) return state.elapsedBefore;
  return state.elapsedBefore + (Date.now() - state.lastTick);
}

/* -------------------------------------------------------------- the attempt */

function save() {
  if (!paperUrl || state.submitted) return;
  try {
    localStorage.setItem(
      STORE,
      JSON.stringify({
        answers: Object.fromEntries(state.answers),
        marked: [...state.marked],
        startedAt: state.startedAt,
        elapsedMs: elapsedMs(),
      })
    );
  } catch {
    /* private mode, or the quota is full: the paper still works, it just will
       not survive a refresh. Not worth interrupting anyone over. */
  }
}

function restore() {
  if (!paperUrl) return null;
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) {
      state.answers = new Map();
      state.marked = new Set();
      return null;
    }
    const saved = JSON.parse(raw);
    const questions = state.paper.questions;
    state.answers = new Map(
      Object.entries(saved.answers || {})
        .map(([index, letter]) => [Number(index), String(letter).toUpperCase()])
        // A different paper at the same key (or a shorter one) must not inherit
        // answers it never had.
        .filter(([index]) => questions[index]?.scorable)
    );
    state.marked = new Set(
      (saved.marked || []).map(Number).filter((index) => Boolean(questions[index]))
    );
    state.answers.forEach((_, index) => paintChoice(index));
    state.marked.forEach((index) => {
      const question = document.getElementById(`q-${index}`);
      question?.querySelector("[data-mark]")?.setAttribute("aria-pressed", "true");
      question?.classList.add("is-marked");
      const pal = palette.querySelector(`[data-jump="${index}"]`);
      if (pal) pal.dataset.marked = "true";
    });
    return saved;
  } catch {
    state.answers = new Map();
    state.marked = new Set();
    return null;
  }
}

function forget() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* nothing to forget */
  }
}

/* ------------------------------------------------------------------ submit */

document.getElementById("dppSubmit").addEventListener("click", () => submit());
document.getElementById("dppTest").addEventListener("submit", (event) => {
  event.preventDefault();
  submit();
});

async function submit() {
  if (state.submitted || !state.paper) return;
  const answered = [...state.answers.keys()].filter((i) => state.paper.questions[i]?.scorable).length;
  const scorable = state.paper.questions.filter((q) => q.scorable).length;
  const button = document.getElementById("dppSubmit");

  if (scorable && answered < scorable) {
    const left = scorable - answered;
    const ok = window.confirm(
      `You have ${left} unanswered question${left === 1 ? "" : "s"}. Submit the paper anyway?`
    );
    if (!ok) return;
  }

  state.elapsedBefore = elapsedMs();
  state.lastTick = Date.now();
  state.submitted = true;
  stopEvery(state.timer);
  state.timer = null;
  button.disabled = true;
  button.textContent = "Marking…";

  try {
    const res = await fetch(`/api/pdf?dpp=${encodeURIComponent(paperUrl)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: Object.fromEntries(state.answers),
        elapsedMs: state.elapsedBefore,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error || "The paper could not be marked.");
    }
    state.review = data.review || data.result?.rows || [];
    renderAnalysis(data);
    forget();
  } catch (err) {
    // Marking is a server round trip; a paper that was answered should not be
    // lost because that round trip failed. Put the attempt back, unlocked.
    state.submitted = false;
    state.lastTick = Date.now();
    state.timer = every(tick, 1000);
    button.disabled = false;
    button.textContent = "Submit paper";
    toast(err?.message || "The paper could not be marked. Your answers are safe.", "error");
  }
}

/* ---------------------------------------------------------------- analysis */

function renderAnalysis(data) {
  const result = data.result || {};
  testEl.hidden = true;
  analysis.hidden = false;
  analysis.scrollIntoView?.({ behavior: "smooth", block: "start" });
  document.title = `${data.title || "DPP"} — analysis — ArsVibe PW`;

  const spent = durationOf(result.elapsedMs);
  const perQuestion = result.scored
    ? `~${Math.max(1, Math.round(result.elapsedMs / 1000 / result.scored))}s per question`
    : "";

  document.getElementById("dppAnalysisTitle").textContent = `${result.correct} of ${result.scored} correct`;
  // The chapter is worth naming, but not when it is the paper's own name: two
  // identical strings separated by a dot is how a header loses its reader.
  const title = data.title || paperName || "DPP paper";
  document.getElementById("dppAnalysisMeta").textContent = [
    title,
    chapterName && chapterName !== title ? chapterName : "",
    spent,
    perQuestion,
    data.parser === "layout" ? "read from the paper's own layout" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  document.getElementById("dppScorecard").innerHTML = `
    <div class="dpp-score-hero">
      <div class="dpp-score-ring" style="--pct:${Number(result.percent) || 0}">
        <strong>${Number(result.percent) || 0}%</strong>
        <span>score</span>
      </div>
      <div class="dpp-score-words">
        <h2>${esc(result.verdict || "Marked")}</h2>
        <p class="tiny dim">${esc(statLine(result))}</p>
      </div>
    </div>
    <div class="dpp-score-grid">
      ${scoreCell("correct", result.correct, "counted right")}
      ${scoreCell("wrong", result.wrong, "counted wrong")}
      ${scoreCell("skipped", result.skipped, "left blank")}
      ${scoreCell("dim", result.unscored, "not scorable from the PDF")}
    </div>`;

  renderReview();
}

function scoreCell(tone, value, label) {
  return `
    <div class="dpp-score-cell is-${tone}">
      <strong>${Number(value) || 0}</strong>
      <span>${esc(label)}</span>
    </div>`;
}

/**
 * How long the attempt took, in a unit that does not lie.
 *
 * "1 min spent" for a three-second skim reads as a rounding bug and hides the
 * fact that the student did not really sit the paper.
 */
function durationOf(ms) {
  const total = Math.max(0, Number(ms) || 0);
  if (!total) return "";
  if (total < 60_000) return `${Math.max(1, Math.round(total / 1000))}s spent`;
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.round((total % 60_000) / 1000);
  if (!seconds) return `${minutes} min spent`;
  return `${minutes} min ${String(seconds).padStart(2, "0")}s spent`;
}

function statLine(result) {
  const bits = [
    `${result.total} questions`,
    `${result.scored} marked`,
    result.unscored ? `${result.unscored} not scorable` : "",
    result.focus?.length ? `revisit Q${result.focus.join(", Q")}` : "",
  ];
  return bits.filter(Boolean).join(" · ");
}

function renderReview() {
  const rows = state.review || [];
  const filter = state.reviewFilter;
  const shown = rows.filter((row) =>
    filter === "all" ? true : filter === "wrong" ? row.outcome === "wrong" : row.outcome === "skipped"
  );

  document.getElementById("dppReviewTabs").querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.review === filter;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });

  const host = document.getElementById("dppReview");
  if (!shown.length) {
    host.innerHTML = `<p class="dpp-review-empty tiny dim">${
      filter === "wrong"
        ? "No wrong answers — nothing to revisit."
        : filter === "skipped"
          ? "Nothing was left blank."
          : "No questions to review."
    }</p>`;
    return;
  }

  host.innerHTML = shown.map((row) => reviewCard(row)).join("");
}

const OUTCOME_LABEL = {
  correct: ["Correct", "is-ok"],
  wrong: ["Wrong", "is-bad"],
  skipped: ["Not answered", "is-miss"],
  unscored: ["Not scorable", "is-dim"],
};

function reviewCard(row) {
  const [label, tone] = OUTCOME_LABEL[row.outcome] || ["—", "is-dim"];
  const options = (row.options || [])
    .map((option) => {
      const isAnswer = option.letter === row.answer;
      const isChosen = option.letter === row.chosen;
      const mark =
        row.outcome === "unscored"
          ? ""
          : isAnswer
            ? `<span class="dpp-rev-tag is-ok">key</span>`
            : isChosen
              ? `<span class="dpp-rev-tag is-bad">your answer</span>`
              : "";
      const cls = [
        "dpp-rev-option",
        isAnswer && row.outcome !== "unscored" ? "is-answer" : "",
        isChosen && !isAnswer ? "is-chosen-wrong" : "",
        isChosen && isAnswer ? "is-chosen-right" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `
        <li class="${cls}">
          <span class="dpp-choice-key">${esc(option.letter)}</span>
          <span class="dpp-rev-text">${esc(option.text)}</span>
          ${mark}
        </li>`;
    })
    .join("");

  const note =
    row.outcome === "correct"
      ? `You answered ${esc(row.chosen)}.`
      : row.outcome === "wrong"
        ? `You answered ${esc(row.chosen)}; the key says ${esc(row.answer)}.`
        : row.outcome === "skipped"
          ? `Left blank; the key says ${esc(row.answer)}.`
          : row.answer
            ? `The key says ${esc(row.answer)}, but the paper printed the options as an image, so it is not counted.`
            : "This question has no answer in the paper's key.";

  return `
    <article class="dpp-rev is-${row.outcome}">
      <header class="dpp-rev-head">
        <span class="dpp-q-num">Q${esc(row.number)}</span>
        <span class="dpp-rev-badge ${tone}">${esc(label)}</span>
      </header>
      <p class="dpp-rev-question">${esc(row.text || "—")}</p>
      ${
        options
          ? `<ul class="dpp-rev-options">${options}</ul>`
          : ""
      }
      <p class="tiny dim dpp-rev-note">${note}</p>
    </article>`;
}

document.getElementById("dppReviewTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-review]");
  if (!tab) return;
  state.reviewFilter = tab.dataset.review;
  renderReview();
});

document.getElementById("dppRetry").addEventListener("click", () => {
  forget();
  state.answers = new Map();
  state.marked = new Set();
  state.submitted = false;
  state.elapsedBefore = 0;
  stopEvery(state.timer);
  // Re-reading the paper costs one request; it also picks up a repaired PDF, so
  // it is worth the round trip rather than reusing the in-memory copy.
  analysis.hidden = true;
  testEl.hidden = true;
  intro.hidden = false;
  loading.hidden = false;
  introTitle.textContent = paperName || "DPP paper";
  document.getElementById("dppSubmit").disabled = false;
  document.getElementById("dppSubmit").textContent = "Submit paper";
  loadPaper();
});

document.getElementById("dppClear").addEventListener("click", () => {
  if (!state.paper) return;
  if (!state.answers.size) return;
  const ok = window.confirm("Clear every answer on this paper?");
  if (!ok) return;
  state.answers = new Map();
  state.marked = new Set();
  sheet.querySelectorAll(".dpp-choice").forEach((label) => {
    label.classList.remove("is-chosen");
    const input = label.querySelector("input");
    if (input) input.checked = false;
  });
  palette.querySelectorAll(".dpp-pal").forEach((pal) => {
    delete pal.dataset.state;
    delete pal.dataset.marked;
  });
  sheet.querySelectorAll(".dpp-q").forEach((q) => {
    q.classList.remove("is-marked");
    q.querySelector("[data-mark]")?.setAttribute("aria-pressed", "false");
  });
  updateProgress();
  save();
});

/* ---------------------------------------------------------------- keyboard */

/**
 * Practising on a laptop should not need the mouse: `A`–`D` answers the question
 * in focus, arrows and `J`/`K` move between questions, `M` marks one, `Enter`
 * submits. Space and Tab are left alone — those belong to the browser.
 */
document.addEventListener("keydown", (event) => {
  if (!state.paper || state.submitted) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || "") && target.type !== "radio";
  if (typing) return;

  const key = event.key;
  const at = focusIndex();
  const letter = key.length === 1 ? key.toUpperCase() : "";
  if (KEY_LETTERS.includes(letter)) {
    const question = state.paper.questions[at];
    if (!question || !question.scorable) return;
    if (!(question.options || []).some((o) => o.letter === letter)) return;
    event.preventDefault();
    answerAt(at, letter);
    return;
  }

  const step = { ArrowDown: 1, j: 1, J: 1, ArrowUp: -1, k: -1, K: -1 }[key];
  if (step) {
    event.preventDefault();
    focusQuestion(Math.max(0, Math.min(state.paper.questions.length - 1, at + step)));
    return;
  }
  if (key === "m" || key === "M") {
    event.preventDefault();
    toggleMark(at);
    return;
  }
  if (key === "Enter" && !/^(BUTTON|A)$/.test(target?.tagName || "")) {
    event.preventDefault();
    submit();
  }
});

/**
 * Which question the keyboard acts on.
 *
 * The focused question wins; failing that the last one jumped to; failing that
 * the first. Reading it from the DOM (rather than a counter that only the
 * arrow keys update) means clicking into a question and typing `B` answers the
 * question being looked at.
 */
function focusIndex() {
  const focused = document.activeElement?.closest?.(".dpp-q");
  if (focused) return Number(focused.dataset.index) || 0;
  if (typeof state.focusIndex === "number") return state.focusIndex;
  return 0;
}

/* ------------------------------------------------------------------- leave */

// Saves the attempt when the tab goes away; `pagehide` fires where `unload` is
// unreliable (mobile Safari, and a tab being frozen).
window.addEventListener("pagehide", () => {
  if (!state.submitted) save();
});
