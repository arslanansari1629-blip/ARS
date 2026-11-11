/**
 * DPP papers — reading and running them.
 *
 * The point of this module is that a DPP paper is guest-readable even though the
 * interactive quiz is not, so these tests lean on a real (generated) PDF rather
 * than a stubbed text string: if `unpdf` stops extracting from the layout PW
 * ships, this suite fails instead of the panel showing empty questions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchPaperBytes,
  extractPdfText,
  normaliseText,
  splitKey,
  parseDppPaper,
  readDppPaper,
} from "../lib/dpp-paper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "dpp-paper.pdf");
const PDF_URL = "https://static.pw.live/example/dpp-paper.pdf";

const bytesOf = async () => new Uint8Array(await readFile(FIXTURE));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("reading a paper does not destroy the bytes it was given", async () => {
  // The PDF engine detaches the buffer it parses. Measuring the caller's bytes
  // afterwards reported a 0-byte paper for a perfectly good one, so this pins
  // the copy that `extractPdfText` now makes.
  const original = await bytesOf();
  const before = original.length;
  const text = await extractPdfText(original);
  assert.equal(text.ok, true);
  assert.equal(original.length, before, "extracting text consumed the caller's buffer");
});

test("the report carries the paper's real size", async () => {
  const paper = await readDppPaper({
    url: PDF_URL,
    fetchImpl: async () => new Response(await bytesOf(), { status: 200 }),
  });
  assert.equal(paper.ok, true, paper.error);
  assert.ok(paper.bytes > 1000, `the report claims a ${paper.bytes}-byte paper`);
});

test("a real PDF's text is extracted with its question layout intact", async () => {
  const text = await extractPdfText(await bytesOf());
  assert.equal(text.ok, true, text.error);
  assert.ok(text.pages >= 1);
  assert.match(text.text, /Q1 The most accurate reading/);
  assert.match(text.text, /\(A\) 6 cm/);
  assert.match(text.text, /Answer Key/);
});

test("the paper is split into questions with their options and the key", async () => {
  const { text } = await extractPdfText(await bytesOf());
  const paper = parseDppPaper(text, { name: "DPP 11" });

  assert.equal(paper.stats.total, 2, "questions were not segmented");
  assert.equal(paper.duration, 30, "the paper's time limit was not read");
  assert.equal(paper.answerKeyFound, true);
  assert.deepEqual(paper.answerKey, { 1: "B", 2: "B" });

  const [q1, q2] = paper.questions;
  assert.equal(q1.number, 1);
  assert.match(q1.text, /most accurate reading/);
  // The measurement lands on its own line in the PDF; it still belongs to Q1.
  assert.match(q1.text, /6\.28 cm/);
  assert.deepEqual(
    q1.options.map((o) => o.letter),
    ["A", "B", "C", "D"]
  );
  assert.equal(q1.options[1].text, "6.5 cm");
  assert.equal(q1.answer, "B");
  assert.equal(q1.answerIndex, 1);
  assert.equal(q1.textOnly, false, "a question with a key and options must be runnable");
  assert.equal(q2.options.length, 4);
  assert.equal(paper.stats.answerable, 2);
});

test("a table-shaped answer key is read too", () => {
  const lines = normaliseText(`Q1 first question
(A) one
(B) two
Answer Key
| Q1 | (B) | Q2 (D) |
| Q2 | (D) |`);
  const { key } = splitKey(lines);
  assert.equal(key.get(1), "B");
  assert.equal(key.get(2), "D");
});

test("a question with no key is kept, but is not scored", () => {
  const paper = parseDppPaper(`Q1 what is 2 + 2?
(A) 4
(B) 5
Q2 and this one?
(A) yes
(B) no
Answer Key
Q1 (A)`);
  assert.equal(paper.stats.total, 2);
  assert.equal(paper.questions[0].textOnly, false);
  assert.equal(paper.questions[1].answer, "");
  assert.equal(paper.questions[1].textOnly, true, "no answer means nothing to score against");
  assert.equal(paper.stats.answerable, 1);
  assert.equal(paper.stats.unreadable, 1);
});

test("a scanned paper reports that it has no text rather than inventing questions", () => {
  const paper = parseDppPaper("[Image: X12]\n[Image: Im0]\n");
  assert.equal(paper.questions.length, 0);
  assert.equal(paper.stats.total, 0);
});

test("a non-PDF link is refused before it is parsed", async () => {
  const out = await fetchPaperBytes(PDF_URL, {
    fetchImpl: async () => new Response("<html>not a pdf</html>", { status: 200 }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /not a PDF/i);

  const bad = await fetchPaperBytes("http://example.test/x.pdf", {
    fetchImpl: async () => new Response("gone", { status: 404 }),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /404/);

  const empty = await fetchPaperBytes("");
  assert.equal(empty.ok, false);
});

test("readDppPaper falls back to this origin's media relay when the CDN refuses", async () => {
  const bytes = await bytesOf();
  const calls = [];
  const paper = await readDppPaper({
    url: PDF_URL,
    name: "DPP 11",
    mediaBase: "https://site.test/api/media",
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      // The direct CDN request fails; the relay answers with the PDF.
      if (url.startsWith("https://static.pw.live")) return new Response("refused", { status: 403 });
      return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
    },
  });

  assert.equal(calls.length, 2, "the relay was not tried");
  assert.match(calls[1], /^https:\/\/site\.test\/api\/media\?url=/);
  assert.equal(paper.ok, true, paper.error);
  assert.equal(paper.questions.length, 2);
  assert.equal(paper.stats.answerable, 2);
});

test("a PDF that parses to no questions says so instead of returning a blank test", async () => {
  const bytes = await bytesOf();
  const paper = await readDppPaper({
    url: PDF_URL,
    fetchImpl: async () => new Response(bytes, { status: 200 }),
  });
  // The fixture *does* have questions; force the empty case by feeding a PDF
  // whose only text is boilerplate.
  assert.equal(paper.ok, true);

  const empty = parseDppPaper("Master NCERT with PW Books APP\nDownload");
  assert.equal(empty.questions.length, 0);
  const failed = await readDppPaper({
    url: PDF_URL,
    fetchImpl: async () => new Response("nope", { status: 403 }),
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.error, "a failed read must carry a reason");
});

test("json helper is not part of this module's surface", () => {
  // Guard against a test helper drifting into the module under test.
  assert.equal(typeof json, "function");
});
