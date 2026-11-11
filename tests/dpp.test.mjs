/**
 * DPP reader — behaviour tests.
 *
 * The interesting part of this module is not "does it map fields" but "does it
 * tell the truth about a paper it cannot read". Physics Wallah serves the DPP
 * index to a guest and the questions to a paid session, so both outcomes are
 * normal and the panel has to distinguish them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDppList, fetchDppPaper, dppHeadline, stripHtml, DPP_PAGE_SIZE } from "../lib/dpp.mjs";

const BATCH = "698ad3519549b300a5e1cc6a";
const SUBJECT_ID = "69b5698ee506a608ee297ed1";

/**
 * `upstreamJson` caches by URL for a couple of minutes, so two tests that ask
 * for the same subject would see each other's answer. Each test that stubs an
 * upstream picks its own ids.
 */
let seq = 0;
const freshIds = () => ({
  batch: `batch-${process.pid}-${(seq += 1)}`,
  batchSubjectId: `subject-${seq}`,
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Run `fn` with `fetch` replaced, and restore it whatever happens. */
async function withFetch(stub, fn) {
  const native = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = native;
  }
}

/** The shape PW's own /generate_token endpoints answer with. */
const token = () => new Response("a-token-string-long-enough", { status: 200 });

function listRow(i, overrides = {}) {
  const n = 10 - i;
  return {
    _id: String(100 - i),
    type: "DPP_QUIZ",
    dppQuizDetails: {
      test: {
        _id: `test-${i}`,
        displayOrder: n,
        name: `Lec ${n} DPP`,
        totalMarks: 40,
        totalQuestions: 10,
        maxDuration: 30,
        createdAt: "2026-11-05T13:00:00.000Z",
        ...overrides,
      },
      scheduleId: "sched-1",
      contentId: `content-${i}`,
    },
  };
}

test("the list is read from the nested row shape PW actually returns", async () => {
  const calls = [];
  const list = await withFetch(
    async (input) => {
      const url = String(input);
      if (/generate_token/.test(url)) return token();
      calls.push(url);
      return json({ success: true, data: [listRow(0), listRow(1)], paginate: { totalCount: 102, limit: 10 } });
    },
    () => fetchDppList({ batch: BATCH, batchSubjectId: SUBJECT_ID })
  );

  assert.equal(list.ok, true);
  assert.equal(list.items.length, 2);
  // Title lives at dppQuizDetails.test.name; a reader that stops one level up
  // produces blank rows.
  assert.equal(list.items[0].name, "Lec 10 DPP");
  assert.equal(list.items[0].id, "test-0");
  assert.equal(list.items[0].questions, 10);
  assert.equal(list.items[0].marks, 40);
  assert.equal(list.items[0].minutes, 30);
  assert.equal(list.total, 102, "the total count was not passed through");
  assert.equal(list.pageSize, 10);
  assert.equal(list.pages, 11);
  assert.equal(DPP_PAGE_SIZE, 10);

  // The key it is queried by is the batch-subject document id, not a slug.
  const asked = calls.find((u) => /new-dpp-list/.test(u));
  assert.ok(asked.includes(`batchSubjectId=${SUBJECT_ID}`), `wrong key: ${asked}`);
  assert.ok(asked.includes(`batchId=${BATCH}`));
});

test("a slug where the id belongs is refused with an explanation, not an empty list", async () => {
  // Passing `physics-by-rajwant-singh-sir-964222` here returns `data: []` from PW
  // rather than an error, so a silent empty list is the trap this guards.
  const out = await fetchDppList({ batch: BATCH, batchSubjectId: "" });
  assert.equal(out.ok, false);
  assert.match(out.error, /batch subject id/i);
  assert.deepEqual(out.items, []);
});

test("a rejected list explains who can read it", async () => {
  const ids = freshIds();
  const list = await withFetch(
    async (input) => {
      const url = String(input);
      if (/generate_token/.test(url)) return token();
      return json({ message: "Unauthorised Access" }, 401);
    },
    () => fetchDppList({ batch: ids.batch, batchSubjectId: ids.batchSubjectId })
  );
  assert.equal(list.ok, false);
  assert.equal(list.auth, true, "the caller cannot tell a lockout from an outage");
  assert.match(list.error, /paid student session/i);
});

test("a paper a guest may not read is reported as locked, not as a server fault", async () => {
  const paper = await withFetch(
    async (input) => {
      const url = String(input);
      if (/generate_token/.test(url)) return token();
      return json({ message: "Unauthorised Access" }, 401);
    },
    () => fetchDppPaper({ testId: "test-1" })
  );
  assert.equal(paper.ok, false);
  assert.equal(paper.locked, true, "a 401 must not read as a broken panel");
  assert.match(paper.error, /paid student session/i);
  assert.deepEqual(paper.questions, []);
});

test("a readable paper is mapped with its options and answer", async () => {
  const paper = await withFetch(
    async (input) => {
      const url = String(input);
      if (/generate_token/.test(url)) return token();
      return json({
        data: {
          name: "Units 01 DPP",
          totalMarks: 8,
          maxDuration: 20,
          questions: [
            {
              _id: "q1",
              questionNumber: 1,
              question: "<p>2 + 2 = ?</p>",
              options: [
                { _id: "o1", text: "3" },
                { _id: "o2", text: "4", isCorrect: true },
              ],
              answer: "<p>Because 2 + 2 is 4.</p>",
            },
            { _id: "q2", question: "&alpha; particle has charge", options: [{ text: "+2e" }] },
          ],
        },
      });
    },
    () => fetchDppPaper({ testId: "test-1" })
  );

  assert.equal(paper.ok, true);
  assert.equal(paper.locked, false);
  assert.equal(paper.questions.length, 2);
  assert.equal(paper.questions[0].text, "2 + 2 = ?", "HTML was not stripped");
  assert.equal(paper.questions[0].options.length, 2);
  assert.equal(paper.questions[0].options[1].correct, true);
  assert.equal(paper.questions[0].answer, "Because 2 + 2 is 4.");
  // Entities that appear in real physics questions must survive as characters.
  assert.match(paper.questions[1].text, /α particle/);
});

test("stripHtml keeps line breaks and decodes the maths entities", () => {
  assert.equal(stripHtml("<p>line one</p><p>line two</p>"), "line one\nline two");
  assert.equal(stripHtml("a&nbsp;&times;&nbsp;b &lt; c"), "a × b < c");
  assert.equal(stripHtml("30&deg; and &radic;2"), "30° and √2");
  assert.equal(stripHtml("&omega;t + &theta;"), "ωt + θ");
  assert.equal(stripHtml("<script>alert(1)</script>safe"), "alert(1)safe", "tags must not survive");
});

test("the headline counts papers, questions and marks", () => {
  const list = {
    ok: true,
    total: 102,
    items: [
      { questions: 10, marks: 40 },
      { questions: 10, marks: 40 },
    ],
  };
  const line = dppHeadline(list);
  assert.match(line, /2 of 102 papers/, `headline lost the paging: ${line}`);
  assert.match(line, /20 questions/);
  assert.match(line, /80 marks/);

  assert.match(dppHeadline({ ok: true, items: [], total: 0 }), /no DPPs/i);
  assert.match(dppHeadline({ ok: false, error: "Physics Wallah said no" }), /said no/);
});
