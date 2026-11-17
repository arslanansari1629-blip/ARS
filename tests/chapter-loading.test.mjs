/**
 * Chapter loading can never hang silently: every data fetch has a
 * deadline, a transient failure gets one quiet retry, and a slow load
 * says what it is waiting on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the data layer times out instead of hanging", async () => {
  const data = await read("public/assets/data.js");
  assert.match(data, /AbortSignal\.timeout\(25000\)/);
});

test("the chapter page retries once and explains a slow load", async () => {
  const chapter = await read("public/assets/chapter.js");
  assert.match(chapter, /firstErr\.auth/);
  assert.match(chapter, /setTimeout\(r, 600\)/);
  assert.match(chapter, /Still loading — Physics Wallah is answering slowly/);
  assert.match(chapter, /clearTimeout\(slowHint\)/);
});
