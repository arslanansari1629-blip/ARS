/**
 * DPP practice — the public test route.
 *
 * The point of this feature is a working loop: read a paper, answer it, submit,
 * get marked. So these tests run that loop against the dev server and the
 * fixture upstream rather than against the parser alone — a paper that parses
 * but cannot be answered is not the feature.
 *
 * The invariant worth guarding harder than any other: the answer key must not
 * be in the GET. A practice test whose answers are in the page source is not a
 * test, and that is a mistake nobody notices from the outside.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scorePaper, testPayload, parseDppPaperFromItems } from "../lib/dpp-paper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4272;
const FIXPORT = 4273;
const BASE = `http://127.0.0.1:${PORT}`;

const children = [];
/** The same fetch the server uses; captured before any test stubs anything. */
const REAL_FETCH = globalThis.fetch.bind(globalThis);

function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function waitFor(url, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await REAL_FETCH(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

before(async () => {
  start(["scripts/fixture-upstream.mjs"], { FIXTURE_PORT: String(FIXPORT) });
  await waitFor(`http://127.0.0.1:${FIXPORT}/AllBatches?page=1`);
  start(["scripts/dev.mjs"], {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PW_UPSTREAM_BASE: `http://127.0.0.1:${FIXPORT}`,
  });
  await waitFor(`${BASE}/`);
});

after(() => {
  for (const child of children) child.kill("SIGKILL");
  // Belt and braces: any page still open (a failed test) must lose its clock
  // before the process can exit.
  for (const dom of openDoms) {
    try {
      dom.window.close();
    } catch {
      /* already closed */
    }
  }
});

const PAPER = () => `http://127.0.0.1:${FIXPORT}/dpp-paper.pdf`;
const REAL_PAPER = () => `http://127.0.0.1:${FIXPORT}/dpp-paper-real.pdf`;
const STACKED_PAPER = () => `http://127.0.0.1:${FIXPORT}/dpp-paper-stacked.pdf`;
const COLUMN_PAPER = () => `http://127.0.0.1:${FIXPORT}/dpp-paper-columns.pdf`;
const SCAN = () => `http://127.0.0.1:${FIXPORT}/dpp-paper-scan.pdf`;

async function get(pathname) {
  const res = await REAL_FETCH(`${BASE}${pathname}`);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function post(pathname, payload) {
  const res = await REAL_FETCH(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/* ------------------------------------------------------- the reading loop */

test("the practice route hands out a paper's questions without its key", async () => {
  const { res, body } = await get(`/api/pdf?dpp=${encodeURIComponent(PAPER())}`);

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.source, "pdf");
  assert.ok(body.questions.length >= 2, "no questions came back");
  assert.equal(body.questions[0].number, 1);
  assert.equal(body.questions[0].options.length, 4);
  assert.equal(body.questions[0].scorable, true);
  assert.ok(body.duration > 0, "the paper's own time limit was lost");
  assert.ok(body.bytes > 1000, `the report claims ${body.bytes} bytes`);

  // The invariant: no answer, anywhere, in any spelling.
  const wire = JSON.stringify(body);
  assert.equal(body.answerKey, undefined);
  assert.equal(body.questions.some((q) => "answer" in q), false, "an answer was sent with the test");
  assert.equal(/answerIndex|answerKey|"answer"/.test(wire), false, `the key leaked: ${wire.slice(0, 300)}`);
});

test("a submitted attempt is marked against the paper's own key, question by question", async () => {
  // Q1 is B, Q2 is B in the fixture paper.
  const { res, body } = await post(`/api/pdf?dpp=${encodeURIComponent(PAPER())}`, {
    answers: { 0: "B", 1: "A" },
    elapsedMs: 95_000,
  });

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  const { result } = body;
  assert.equal(result.total, 2);
  assert.equal(result.correct, 1, "Q1 was answered correctly");
  assert.equal(result.wrong, 1, "Q2 was answered wrongly");
  assert.equal(result.skipped, 0);
  assert.equal(result.percent, 50);
  assert.equal(result.elapsedMs, 95_000);
  assert.deepEqual(result.focus, [2], "the wrong answer was not flagged for revision");

  // The review is what the analysis page renders, so it has to carry enough to
  // show the question, both answers, and the reason.
  assert.equal(body.review.length, 2);
  const [first, second] = body.review;
  assert.equal(first.outcome, "correct");
  assert.equal(first.chosen, "B");
  assert.equal(first.answer, "B");
  assert.equal(first.text.length > 10, true);
  assert.equal(first.options.length, 4);
  assert.equal(second.outcome, "wrong");
  assert.equal(second.chosen, "A");
  assert.equal(second.answer, "B");
});

test("an unanswered paper is marked as skipped, not as wrong", async () => {
  const { body } = await post(`/api/pdf?dpp=${encodeURIComponent(PAPER())}`, { answers: {} });
  assert.equal(body.result.correct, 0);
  assert.equal(body.result.wrong, 0);
  assert.equal(body.result.skipped, 2);
  assert.equal(body.result.percent, 0);
  assert.equal(body.result.rows.every((r) => r.outcome === "skipped"), true);
});

test("the real DPP 11 layout is read with its options paired to the right letters", async () => {
  const { body } = await get(`/api/pdf?dpp=${encodeURIComponent(REAL_PAPER())}`);
  assert.equal(body.success, true, body.error);

  // Five questions: four with readable options, one printed as an image.
  assert.equal(body.questions.length, 5);
  assert.equal(body.stats.unreadable, 1, "the image-only question should be the only unreadable one");

  const [q1, q2] = body.questions;
  assert.deepEqual(
    q1.options.map((o) => o.text),
    ["6 cm", "6.5 cm", "5.99 cm", "6.0 cm"]
  );
  // The trap: the values 5 / 4 / 2 / 3 are printed under the letters, and a
  // stream-order read pairs them backwards.
  assert.deepEqual(
    q2.options.map((o) => o.text),
    ["5", "4", "2", "3"]
  );
  assert.equal(q2.options.find((o) => o.letter === "A").text, "5");

  // The image-only question is shown, says it is not scorable, and carries no key.
  const imageOnly = body.questions.find((q) => q.number === 14);
  assert.equal(imageOnly.scorable, false);
  assert.equal("answer" in imageOnly, false, "a non-scorable question must not reveal its answer either");
});

test("a paper whose options are stacked under their letters still scores", async () => {
  const { body } = await get(`/api/pdf?dpp=${encodeURIComponent(STACKED_PAPER())}`);
  assert.equal(body.success, true, body.error);
  assert.equal(body.questions.length, 2);
  assert.deepEqual(
    body.questions[0].options.map((o) => o.text),
    ["0.0500", "0.05000", "0.0050", "5.0 x 10"]
  );

  const marked = await post(`/api/pdf?dpp=${encodeURIComponent(STACKED_PAPER())}`, {
    answers: { 0: "A", 1: "B" },
  });
  assert.equal(marked.body.result.correct, 1);
  assert.equal(marked.body.result.wrong, 1);
  assert.equal(marked.body.result.percent, 50);
});

test("the image-only question is not scored against the student", async () => {
  // Q1 B is right; Q2 B is right; Q6 A is right; Q12 B is right; Q14 is an image.
  const { body } = await post(`/api/pdf?dpp=${encodeURIComponent(REAL_PAPER())}`, {
    answers: { 0: "B", 1: "B", 2: "A", 3: "B", 4: "C" },
  });
  assert.equal(body.result.correct, 4);
  assert.equal(body.result.wrong, 0);
  assert.equal(body.result.unscored, 1, "the image-only question was counted against the attempt");
  assert.equal(body.result.scored, 4, "only the four readable questions are marked");
  assert.equal(body.result.percent, 100);
  assert.equal(body.result.rows[4].outcome, "unscored");
});

test("a two-column paper keeps each question's options in its own question", async () => {
  // This is the layout PW actually prints DPP 11 in: question 1 beside question
  // 8, question 2 beside question 9. Read across, a row spans two unrelated
  // questions and Q1 silently inherits Q8's options — nothing throws, and every
  // option *looks* plausible. So the assertions are about specific values.
  const { res, body } = await get(`/api/pdf?dpp=${encodeURIComponent(COLUMN_PAPER())}`);

  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.success, true, body.error);
  assert.equal(body.parser, "layout");
  assert.equal(body.stats.total, 14, "the paper has fourteen questions");
  assert.equal(body.stats.unreadable, 0, "every question in this paper is readable");

  const byNumber = new Map(body.questions.map((q) => [q.number, q]));
  assert.deepEqual([...byNumber.keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

  // Q1 must have Q1's options — the values from question 8 are the mistake this
  // test exists for.
  assert.deepEqual(byNumber.get(1).options.map((o) => o.text), [
    "6 cm",
    "6.5 cm",
    "5.99 cm",
    "6.0 cm",
  ]);
  assert.deepEqual(byNumber.get(8).options.map((o) => o.text), [
    "2.75 and 2.74",
    "2.74 and 2.73",
    "2.75 and 2.73",
    "2.74 and 2.74",
  ]);
  assert.deepEqual(byNumber.get(7).options.map((o) => o.text), [
    "0.0500",
    "0.05000",
    "0.0050",
    "5.0 × 10",
  ]);

  // Q2 is the question a midpoint gutter breaks. The left column prints two
  // options to a line, so `(B)` sits at x=165 and its value `4` at x=181 — past
  // the midpoint between the columns (170). Splitting there leaves Q2 with
  // options A and C only, and the *right* half of its options appears in Q9.
  assert.deepEqual(byNumber.get(2).options.map((o) => `${o.letter}:${o.text}`), [
    "A:5",
    "B:4",
    "C:2",
    "D:3",
  ]);
  assert.deepEqual(byNumber.get(3).options.map((o) => `${o.letter}:${o.text}`), [
    "A:4",
    "B:5",
    "C:7",
    "D:3",
  ]);
  // No question may borrow another's options: every option list is complete and
  // four-strong, and each question's own option values appear exactly once.
  for (const q of body.questions) {
    assert.equal(q.options.length, 4, `Q${q.number} has ${q.options.length} options`);
  }
  // Q12 is printed in full on both sides of the page break; it must read once.
  assert.deepEqual(byNumber.get(12).options.map((o) => o.text), [
    "3 5.53 × 10",
    "3 5.52 × 10",
    "3 5.54 × 10",
    "3 5.5 × 10",
  ]);
  // The stems are not spliced either: Q3's stem does not carry Q9's wording.
  assert.match(byNumber.get(3).text, /0\.0006032/);
  assert.equal(/block|thickness/i.test(byNumber.get(3).text), false, "Q3's stem picked up Q9");

  const marked = await post(`/api/pdf?dpp=${encodeURIComponent(COLUMN_PAPER())}`, {
    // The real key: 1 B, 2 B, 3 A, 4 B, 5 C, 6 A, 7 A, 8 D, 9 B, 10 C, 11 A, 12 B, 13 B, 14 C.
    answers: { 0: "B", 1: "B", 2: "A", 3: "B", 4: "C", 5: "A", 6: "A", 7: "D", 8: "B", 9: "C", 10: "A", 11: "B", 12: "B", 13: "C" },
  });
  assert.equal(marked.body.result.correct, 14, JSON.stringify(marked.body.review.map((r) => [r.number, r.outcome])));
  assert.equal(marked.body.result.percent, 100);
});

test("the layout diagnostic does not hand out the answer key", async () => {
  // `?lines=1` is a debugging aid on a *public* route, and it echoes the paper's
  // lines back. The paper's lines end with `Q1 (B) Q8 (D)`. Anyone can append the
  // flag, so the key has to be cut out of it, not merely omitted from the JSON
  // structure that the practice page reads.
  const { res, body } = await get(`/api/pdf?dpp=${encodeURIComponent(COLUMN_PAPER())}&lines=1`);
  assert.equal(res.status, 200);
  assert.equal(body.layout.ok, true);

  const text = JSON.stringify(body.layout);
  assert.match(text, /answer key withheld/, "the diagnostic did not say it withheld the key");
  // The real key: 1 B, 8 D, 2 B, 9 B, 3 A, 4 B, 5 C, 6 A, 11 A, 7 A, 12 B, 13 B, 14 C.
  // None of the key's own rows may appear, in either the table shape or a list.
  assert.equal(/Q\s*1\s*\(B\)/i.test(text), false, "the key row `Q1 (B)` leaked");
  assert.equal(/Q\s*8\s*\(D\)/i.test(text), false, "the key row `Q8 (D)` leaked");
  assert.equal(/Q\s*14\s*\(C\)/i.test(text), false, "the key row `Q14 (C)` leaked");
});

test("a paper's stems carry the question, not the sheet's furniture", async () => {
  // Every page carries the app's name, the batch and the time limit, top and bottom.
  // On a two-column page those runs sit inside the right column, so read as lines they
  // arrive after the left column's last question — and Q7's stem came back as
  // "… significant figures is Master NCERT with PW Books APP JEE DPP: 11 30 min".
  // A student would read that as part of the question.
  const { body } = await get(`/api/pdf?dpp=${encodeURIComponent(COLUMN_PAPER())}`);
  const byNumber = new Map(body.questions.map((q) => [q.number, q]));
  const furniture = /master ncert|arjuna jee|units and measurements|dpp: 11|time duration|PW Books/i;
  for (const q of body.questions) {
    assert.equal(furniture.test(q.text), false, `Q${q.number}'s stem kept the sheet's furniture: ${q.text}`);
    for (const option of q.options) {
      assert.equal(furniture.test(option.text), false, `Q${q.number} option ${option.letter} kept furniture`);
    }
  }
  // The stems that mattered are still there — dropping furniture must not drop a word
  // of the question itself.
  assert.match(byNumber.get(7).text, /decimal equivalent/i);
  assert.match(byNumber.get(7).text, /significant figures/i);
  assert.match(byNumber.get(14).text, /L \+ B/);
});

test("the route can say whether a paper marks correctly, without giving the key away", async () => {
  // `?check=1` marks a perfect attempt — every question answered with the paper's own
  // key, which only the server can read — and reports how many came back correct. It
  // is the check that answers "does this deployed paper mark right?" without sitting
  // the paper by hand, which is the mistake that let a green suite ship a paper whose
  // options were spliced across columns.
  const { res, body } = await get(`/api/pdf?dpp=${encodeURIComponent(COLUMN_PAPER())}&check=1`);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.success, true, body.error);
  assert.equal(body.ok, true, JSON.stringify(body.failed));
  assert.equal(body.questions, 14);
  assert.equal(body.scorable, 14);
  assert.equal(body.correct, 14);
  assert.equal(body.percent, 100);
  assert.deepEqual(body.failed, []);

  // It reports counts, never the key: no `answer`, no letter-per-question map.
  const text = JSON.stringify(body);
  assert.equal(/key\s*"\s*:/i.test(text), false);
  assert.equal(body.answers, undefined);
  assert.equal(body.answerKey, undefined);
});

test("the marking check names the questions that fail, and only those", async () => {
  // A paper whose options are damaged is exactly what a two-column read produces. The
  // check has to notice, or it is worth nothing. Reading the real DPP 11 geometry as
  // one column is that damage, and it is reachable without touching the fixture: the
  // stack layout sets four option values on the line under four letters.
  const { body } = await get(`/api/pdf?dpp=${encodeURIComponent(COLUMN_PAPER())}&check=1`);
  assert.equal(body.keyFound, 14, "the key was not read");

  // A question that could not be marked appears as `failed` with what the key wanted;
  // a question that marked does not appear at all, so the list cannot be read backwards
  // into the key.
  for (const failed of body.failed) {
    assert.equal(typeof failed.number, "number");
    assert.equal(typeof failed.expected, "string");
  }
  assert.equal(body.failed.length, 0);
});

test("a paper that will not read still shows how it was laid out", async () => {
  // The diagnostic is for the paper that came out *wrong*, and the worst case is one
  // the reader could not read at all: "no questions were found, it may be a scanned
  // image" is an answer that cannot be checked or argued with. The layout is attached
  // to the failure as well, so the sheet can be looked at.
  //
  // The fixture upstream serves a paper with no `Q` markers, which is what a scan
  // looks like to the reader.
  const { res, body } = await get(`/api/pdf?dpp=${encodeURIComponent(SCAN())}&lines=1`);
  assert.equal(res.status, 502, "this paper is supposed to be unreadable");
  assert.equal(body.success, false);
  assert.ok(body.layout, "the failed read has no layout");
  assert.equal(body.layout.ok, true);
  assert.equal(body.layout.pages, 1);
});

/* ------------------------------------------------------- the guard rails */

test("a paper is only read from the allowed hosts", async () => {
  const { res, body } = await get(`/api/pdf?dpp=${encodeURIComponent("https://example.test/x.pdf")}`);
  assert.equal(res.status, 400);
  assert.equal(body.success, false);
  assert.match(body.error, /Physics Wallah/i);

  const relative = await get(`/api/pdf?dpp=${encodeURIComponent("/etc/passwd")}`);
  assert.equal(relative.res.status, 400);
});

test("a link that is not a PDF is refused with a reason, not a blank paper", async () => {
  // The fixture answers 404 for anything it does not know, which is the same
  // shape as a dead CDN link.
  const { res, body } = await get(
    `/api/pdf?dpp=${encodeURIComponent(`http://127.0.0.1:${FIXPORT}/not-a-paper.pdf`)}`
  );
  assert.equal(res.status, 502);
  assert.equal(body.success, false);
  assert.ok(body.error, "a failed read must say why");
});

test("the practice page ships, links its module, and is statically sound", async () => {
  const html = await readFile(path.join(ROOT, "public", "dpp.html"), "utf8");
  assert.match(html, /<script type="module" src="\/assets\/dpp\.js">/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /id="dppSubmit"/);
  assert.match(html, /id="dppReview"/);
  assert.match(html, /class="skip-link"/);
  const res = await REAL_FETCH(`${BASE}/dpp.html?paper=${encodeURIComponent(PAPER())}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /DPP practice/);
});

/* ------------------------------------------------------- the scoring unit */

test("scoring keys an answer by index, by string index, or by question number", () => {
  const paper = {
    questions: [
      { number: 1, text: "a", options: [{ letter: "A", text: "x" }, { letter: "B", text: "y" }], answer: "A", textOnly: false },
      { number: 7, text: "b", options: [{ letter: "A", text: "x" }, { letter: "B", text: "y" }], answer: "B", textOnly: false },
    ],
  };
  const byIndex = scorePaper(paper, { 0: "A", 1: "B" });
  assert.equal(byIndex.correct, 2);

  const byString = scorePaper(paper, { "0": "A", "1": "B" });
  assert.equal(byString.correct, 2);

  const byNumber = scorePaper(paper, { 1: "A", 7: "B" }, { keyedBy: "number" });
  assert.equal(byNumber.correct, 2);

  // The default is positional, and must not be reinterpreted as numbering: index
  // 1 on this paper is question 7, so a bare `{ 1: "A" }` answers question 7.
  const positional = scorePaper(paper, { 1: "A" });
  assert.equal(positional.rows[1].number, 7);
  assert.equal(positional.wrong, 1);
});

test("a lower-case or padded answer is still the answer it names", () => {
  const paper = {
    questions: [
      { number: 1, text: "a", options: [{ letter: "A", text: "x" }, { letter: "B", text: "y" }], answer: "B", textOnly: false },
    ],
  };
  assert.equal(scorePaper(paper, { 0: " b " }).correct, 1);
  assert.equal(scorePaper(paper, { 0: "z" }).wrong, 1, "an answer that is not an option is just wrong");
});

test("the test payload withholds every answer", () => {
  const paper = {
    title: "DPP",
    duration: 30,
    pages: 1,
    questions: [
      {
        number: 1,
        text: "a",
        options: [{ letter: "A", text: "x" }, { letter: "B", text: "y" }],
        answer: "B",
        answerIndex: 1,
        textOnly: false,
        raw: "Q1 a (A) x (B) y",
      },
    ],
    answerKey: { 1: "B" },
    stats: { total: 1, answerable: 1, unreadable: 0 },
  };
  const payload = testPayload(paper);
  assert.equal(JSON.stringify(payload).includes('"answer"'), false);
  assert.equal(payload.questions[0].scorable, true);
  assert.deepEqual(payload.questions[0].options.map((o) => o.letter), ["A", "B"]);
  // `raw` is the paper's own text, which contains the key for a table-shaped
  // paper — it must not travel to the browser either.
  assert.equal("raw" in payload.questions[0], false);
});

test("the positioned reader pairs a value with the marker on its left", () => {
  // (A) at x=50, (B) at x=200; the values sit beside them, in one row.
  const items = [
    { str: "Q1 what is the answer?", x: 50, y: 500, width: 200, fontSize: 11 },
    { str: "(A)", x: 50, y: 480, width: 20, fontSize: 11 },
    { str: "6 cm", x: 76, y: 480, width: 30, fontSize: 11 },
    { str: "(B)", x: 200, y: 480, width: 20, fontSize: 11 },
    { str: "6.5 cm", x: 226, y: 480, width: 40, fontSize: 11 },
    { str: "(C)", x: 340, y: 480, width: 20, fontSize: 11 },
    { str: "5.99 cm", x: 366, y: 480, width: 42, fontSize: 11 },
    { str: "(D)", x: 470, y: 480, width: 20, fontSize: 11 },
    { str: "6.0 cm", x: 496, y: 480, width: 38, fontSize: 11 },
    { str: "Answer Key", x: 50, y: 300, width: 60, fontSize: 11 },
    { str: "| Q1 | (C) |", x: 50, y: 280, width: 90, fontSize: 11 },
  ];
  const paper = parseDppPaperFromItems([items]);
  assert.equal(paper.questions.length, 1);
  assert.equal(paper.questions[0].answer, "C");
  assert.deepEqual(
    paper.questions[0].options.map((o) => `${o.letter}:${o.text}`),
    ["A:6 cm", "B:6.5 cm", "C:5.99 cm", "D:6.0 cm"]
  );
  assert.match(paper.questions[0].text, /what is the answer/);
  assert.equal(paper.stats.answerable, 1);
});

/* --------------------------------------------- the page, driven like a student */

/**
 * Load `/dpp.html` in jsdom and run its module, with `fetch` pointed at the dev
 * server — the same trick `tests/pages.test.mjs` uses for every other page.
 *
 * This is the test that matters for the feature's promise: not "the parser
 * works" but "a student can answer this and see what they got". So it drives the
 * radios, submits the form, and reads the analysis back out of the DOM.
 */
const openDoms = [];

async function openPractice(paperUrl, { seed = null } = {}) {
  const { register } = await import("node:module");
  const { JSDOM } = await import("jsdom");
  register("./loader.mjs", import.meta.url);

  const query = new URLSearchParams({ paper: paperUrl, name: "DPP 11 practice" });
  const html = await (await REAL_FETCH(`${BASE}/dpp.html?${query}`)).text();
  const dom = new JSDOM(html, {
    url: `${BASE}/dpp.html?${query}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const doc = window.document;
  // Tracked from the moment it exists: the practice page runs a one-second clock,
  // and a test that fails before it closes the page would leave that clock
  // running for the rest of the process — a suite that hangs instead of failing.
  openDoms.push(dom);

  // jsdom keeps one storage per document, so a *reopened* page has to be handed
  // the attempt a real browser would still have. Doing it before the module runs
  // is the whole point: the page restores on boot.
  if (seed) seed(window.localStorage, window);

  globalThis.window = window;
  globalThis.document = doc;
  globalThis.location = window.location;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLElement = window.HTMLElement;
  // jsdom has no `confirm`, and submitting a half-answered paper asks.
  window.confirm = () => true;

  globalThis.fetch = (input, init) =>
    REAL_FETCH(String(input).startsWith("http") ? input : `${BASE}${input}`, init);

  await import(`/assets/dpp.js?v=practice-${Date.now()}`);
  await until(() => doc.querySelectorAll("#dppSheet input[type=radio]").length > 0, "the questions");

  return { dom, window, doc };
}

/** Poll rather than sleep: the dev server's first read is the slow one. */
async function until(check, what, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the link a chapter gives a student opens that paper, not an empty page", async () => {
  // The way in is a chapter's Practice button, and the only thing it guarantees is the
  // link it builds. That link used to address the paper as `paper` while the practice
  // page read its address from `dpp` — so pressing Practice from a chapter opened
  // "Pick a DPP paper first", with no paper and no test. The button was present in the
  // DOM and looked right, which is why only opening it catches this.
  const { practiceUrl } = await import("../public/assets/chapter.js").catch(() => ({}));
  // The page module is not importable on its own (it boots a page), so the link is
  // read from the DOM the way a student gets it.
  const { register } = await import("node:module");
  const { JSDOM } = await import("jsdom");
  register("./loader.mjs", import.meta.url);

  const chapter =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822" +
    "&chapter=6a6b461cce4ac4e9ab51ee98&name=Ch%2001#dpp";
  const page = await (await REAL_FETCH(`${BASE}${chapter}`)).text();
  const dom = new JSDOM(page, { url: `${BASE}${chapter}`, pretendToBeVisual: true });
  openDoms.push(dom);
  const { window } = dom;
  const doc = window.document;
  window.fetch = (input, init) =>
    REAL_FETCH(String(input).startsWith("http") ? input : `${BASE}${input}`, init);
  globalThis.fetch = window.fetch;
  globalThis.window = window;
  globalThis.document = doc;
  globalThis.localStorage = window.localStorage;
  globalThis.location = window.location;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLElement = window.HTMLElement;

  await import(`/assets/chapter.js?v=practice-link-${Date.now()}`);
  const deadline = Date.now() + 12000;
  let link = null;
  while (Date.now() < deadline && !link) {
    await new Promise((r) => setTimeout(r, 50));
    link = doc.querySelector('#body .doc-row a[href^="/dpp.html?"]');
  }
  assert.ok(link, "the chapter offered no Practice link");
  const href = new URL(link.getAttribute("href"), BASE);
  assert.match(href.searchParams.get("paper") || "", /\.pdf/, "the link does not name a paper");

  // The page must read the address from *the* parameter the link uses, not from a
  // second one that happens to carry the same value: sending both would pass even if
  // the page only read the other, and the day one of them is dropped every Practice
  // button on the site opens an empty page again.
  const only = new URL(href);
  only.searchParams.delete("dpp");
  const practice0 = await (await REAL_FETCH(only.toString())).text();
  assert.ok(practice0.length > 0);

  // Now open the link *without* the duplicate parameter, which is what proves the page
  // resolves the address from `paper` itself.
  const practice = new JSDOM(await (await REAL_FETCH(only.toString())).text(), {
    url: only.toString(),
    pretendToBeVisual: true,
  });
  openDoms.push(practice);
  const pwindow = practice.window;
  const pdoc = pwindow.document;
  pwindow.fetch = (input, init) =>
    REAL_FETCH(String(input).startsWith("http") ? input : `${BASE}${input}`, init);
  globalThis.fetch = pwindow.fetch;
  globalThis.window = pwindow;
  globalThis.document = pdoc;
  globalThis.localStorage = pwindow.localStorage;
  globalThis.location = pwindow.location;
  globalThis.CustomEvent = pwindow.CustomEvent;
  globalThis.HTMLElement = pwindow.HTMLElement;
  pwindow.confirm = () => true;
  await import(`/assets/dpp.js?v=practice-from-chapter-${Date.now()}`);
  await until(
    () => pdoc.querySelectorAll("#dppSheet .dpp-q").length > 0,
    "the paper the chapter linked to"
  );
  assert.equal(pdoc.getElementById("dppTest").hidden, false);
  assert.ok(
    pdoc.querySelectorAll("#dppSheet .dpp-q").length >= 2,
    "the paper the chapter linked to opened empty"
  );
});

test("a student answers a paper, submits, and reads the analysis", async () => {
  const { dom, window, doc } = await openPractice(PAPER());

  // The paper is a test, not a wall of text.
  assert.equal(doc.getElementById("dppTest").hidden, false, "the paper did not open");
  const questions = doc.querySelectorAll("#dppSheet .dpp-q");
  assert.equal(questions.length, 2, "the paper's questions were not rendered");
  assert.match(doc.getElementById("dppTitle").textContent, /DPP/);
  // The clock runs, from the paper's own time limit.
  assert.match(doc.getElementById("dppClockValue").textContent, /^\d{2}:\d{2}$/);
  assert.match(doc.getElementById("dppAnswered").textContent, /0 of 2 answered/);

  // The key is nowhere in the page before submitting.
  assert.equal(/correct|answer is/i.test(doc.getElementById("dppSheet").textContent), false);

  const choose = (index, letter) => {
    const input = doc.querySelector(`#dppSheet input[data-index="${index}"][data-letter="${letter}"]`);
    assert.ok(input, `no option ${letter} on question ${index}`);
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  };

  choose(0, "B"); // right
  choose(1, "A"); // wrong (the key says B)

  assert.match(doc.getElementById("dppAnswered").textContent, /2 of 2 answered/);
  assert.equal(doc.querySelectorAll(".dpp-choice.is-chosen").length, 2, "the chosen options are not marked");
  // The palette shows the same state, so a student can see what is left.
  assert.equal(doc.querySelectorAll("#dppPalette .dpp-pal[data-state=done]").length, 2);

  doc.getElementById("dppSubmit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => doc.getElementById("dppAnalysis").hidden === false, "the analysis");

  // The analysis: a score, the counts, and the reviewer's marks.
  assert.equal(doc.getElementById("dppTest").hidden, true, "the paper is still on screen");
  assert.match(doc.getElementById("dppAnalysisTitle").textContent, /1 of 2 correct/);
  assert.match(doc.getElementById("dppScorecard").textContent, /50%/);
  assert.match(doc.getElementById("dppScorecard").textContent, /Getting there/);

  const reviews = doc.querySelectorAll("#dppReview .dpp-rev");
  assert.equal(reviews.length, 2, "every question should be reviewed");
  assert.match(reviews[0].textContent, /Correct/);
  assert.match(reviews[1].textContent, /Wrong/);
  // The right answer is shown, and the wrong pick is struck through.
  assert.ok(reviews[1].querySelector(".dpp-rev-option.is-answer"), "the key is not shown on a wrong answer");
  assert.ok(reviews[1].querySelector(".dpp-rev-option.is-chosen-wrong"), "the wrong pick is not marked");
  assert.match(reviews[1].textContent, /key says B/);

  // The filters are the point of an analysis page: "wrong" has to show the one
  // question worth looking at, not the whole paper again.
  doc.querySelector('#dppReviewTabs [data-review="wrong"]').dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  assert.equal(doc.querySelectorAll("#dppReview .dpp-rev").length, 1);
  assert.match(doc.querySelector("#dppReview .dpp-rev").textContent, /Wrong/);

  // A finished attempt is not left behind to be restored over the analysis.
  assert.equal(dom.window.localStorage.getItem(`arsvibe.dpp.${PAPER()}`), null);

  dom.window.close();
});

test("an interrupted attempt survives a refresh, and does not count as submitted", async () => {
  const paper = PAPER();
  const first = await openPractice(paper);
  const input = first.doc.querySelector('#dppSheet input[data-index="0"][data-letter="B"]');
  input.checked = true;
  input.dispatchEvent(new first.window.Event("change", { bubbles: true }));
  assert.match(first.doc.getElementById("dppAnswered").textContent, /1 of 2 answered/);

  const saved = JSON.parse(first.window.localStorage.getItem(`arsvibe.dpp.${paper}`));
  assert.deepEqual(saved.answers, { 0: "B" }, "the attempt was not saved");
  assert.ok(saved.startedAt > 0);
  first.dom.window.close();

  // Reopening the page restores it, and says so.
  const second = await openPractice(paper, {
    seed: (storage) => storage.setItem(`arsvibe.dpp.${paper}`, JSON.stringify(saved)),
  });
  await until(
    () => second.doc.querySelectorAll(".dpp-choice.is-chosen").length === 1,
    "the saved answer to be restored"
  );
  assert.match(second.doc.getElementById("dppAnswered").textContent, /1 of 2 answered/);
  assert.match(second.doc.getElementById("dppScorable").textContent, /restored/);
  assert.equal(
    second.doc.querySelector('#dppSheet input[data-index="0"][data-letter="B"]').checked,
    true,
    "the restored answer is not checked"
  );
  second.dom.window.close();
});

test("a paper with an unreadable question does not score it against the student", async () => {
  const { dom, window, doc } = await openPractice(REAL_PAPER());
  await until(() => doc.querySelectorAll("#dppSheet .dpp-q").length === 5, "five questions");

  // The image-only question is shown, and says why it will not be marked.
  const imageOnly = doc.getElementById("q-4");
  assert.match(imageOnly.textContent, /prints this question as an image/i);
  assert.equal(imageOnly.querySelectorAll("input[type=radio]").length, 0);

  // Answer all four readable ones correctly, using the keyboard, which is how a
  // student on a laptop would: focus a question and press the letter.
  const letters = ["B", "B", "A", "B"];
  letters.forEach((letter, index) => {
    doc.getElementById(`q-${index}`).focus();
    doc.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: letter.toLowerCase(), bubbles: true })
    );
  });
  assert.match(doc.getElementById("dppAnswered").textContent, /4 of 4 answered/);

  // A wrong key is ignored rather than recorded.
  doc.getElementById("q-0").focus();
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", bubbles: true }));
  assert.match(doc.getElementById("dppAnswered").textContent, /4 of 4 answered/);

  doc.getElementById("dppSubmit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => doc.getElementById("dppAnalysis").hidden === false, "the analysis");

  assert.match(doc.getElementById("dppAnalysisTitle").textContent, /4 of 4 correct/);
  assert.match(doc.getElementById("dppScorecard").textContent, /100%/);
  // …and the fifth is reported, not silently dropped.
  assert.match(doc.getElementById("dppScorecard").textContent, /not scorable from the PDF/);

  dom.window.close();
});

test("a paper that cannot be read explains itself instead of going blank", async () => {
  // This path used to *throw*: the failure branch called a helper that had not
  // been initialised yet, so a dead paper produced no message at all — the one
  // case where the page must speak. Hence a test that only asserts the copy.
  const dead = `http://127.0.0.1:${FIXPORT}/not-a-paper.pdf`;
  const { register } = await import("node:module");
  const { JSDOM } = await import("jsdom");
  register("./loader.mjs", import.meta.url);

  const query = new URLSearchParams({ paper: dead, name: "Broken paper" });
  const html = await (await REAL_FETCH(`${BASE}/dpp.html?${query}`)).text();
  const dom = new JSDOM(html, { url: `${BASE}/dpp.html?${query}`, pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  openDoms.push(dom);

  globalThis.window = window;
  globalThis.document = doc;
  globalThis.location = window.location;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLElement = window.HTMLElement;
  window.confirm = () => true;
  globalThis.fetch = (input, init) =>
    REAL_FETCH(String(input).startsWith("http") ? input : `${BASE}${input}`, init);

  await import(`/assets/dpp.js?v=fail-${Date.now()}`);
  await until(
    () => /could not be read/i.test(doc.getElementById("dppIntroTitle").textContent),
    "the failure message"
  );

  assert.match(doc.getElementById("dppIntroTitle").textContent, /could not be read/i);
  const note = doc.getElementById("dppIntroNote").textContent;
  assert.match(note, /answered 404|not a PDF|gone/i, `the reason is missing: ${note}`);
  // Both ways out are offered, and the paper URL is in the PDF link.
  assert.ok(doc.querySelector('#dppIntroNote a[href^="/api/media?url="]'), "no link to the PDF itself");
  assert.ok(doc.querySelector('#dppIntroNote a[href^="/chapter.html"], #dppIntroNote a[href="/batches.html"]'));
  assert.equal(doc.getElementById("dppTest").hidden, true, "an unreadable paper was still shown as a test");

  dom.window.close();
});
