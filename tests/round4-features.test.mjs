/**
 * Round 4 — pinned:
 *   1. DPP walks never stop at a "short page", papers retry, chapters read concurrently
 *   2. Player Plus: theatre + scrubber note markers
 *   3. AI Doubt: offline brain + BYO-key model path, key only in the browser
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPaperBytes, collectDppPapers } from "../lib/dpp-paper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(ROOT, p), "utf8");

test("chapters: an empty page ends the walk, not a short one", async () => {
  const src = await read("lib/api-data.mjs");
  assert.ok(!/arr\.length < 20\) break/.test(src), "the short-page early exit is back — big subjects will lose chapters");
});

test("paper bytes: a shed 5xx is retried, and the retry can succeed", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 fake");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => pdf.buffer };
  };
  const out = await fetchPaperBytes("https://static.pw.live/x.pdf", { fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(calls, 2);
});

test("paper bytes: a 4xx is final — retrying a refusal is noise", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const out = await fetchPaperBytes("https://static.pw.live/x.pdf", { fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(calls, 1);
});

test("collect papers: chapters read concurrently and failures stay partial", async () => {
  let inFlight = 0, peak = 0;
  const fetchChapters = async () => ({
    ok: true,
    chapters: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: `Ch ${i}`, videos: 1, notes: 0 })),
  });
  const fetchChapterContents = async (batch, subject, chapterId) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 25));
    inFlight -= 1;
    if (chapterId === "c2") return { ok: false, error: "nope" };
    return { ok: true, items: [{ id: `i-${chapterId}`, title: "DPP", date: "2026-01-01", docs: [{ url: "https://x/d.pdf", pdfId: `p-${chapterId}` }] }] };
  };
  const out = await collectDppPapers({ batch: "b", subject: "s", fetchChapters, fetchChapterContents });
  assert.equal(out.ok, true);
  assert.equal(out.papers.length, 5, "one failed chapter must not sink the subject");
  assert.ok(peak > 1, `chapters still serial (peak ${peak})`);
});

test("player plus + AI doubt ship on the watch page", async () => {
  const html = await read("public/watch.html");
  assert.match(html, /player-plus\.js/);
  assert.match(html, /ai-doubt\.js/);
  assert.match(html, /id="aiLog"/);
  const plus = await read("public/assets/player-plus.js");
  assert.match(plus, /note-marker/);
  assert.match(plus, /theatre/);
  const ai = await read("public/assets/ai-doubt.js");
  assert.match(ai, /instantAnswer/, "offline brain missing");
  assert.match(ai, /chat\/completions/, "BYO-key model path missing");
  assert.match(ai, /arsvibe\.ai/, "AI config must persist locally");
});
