/**
 * Round 3 features — pinned:
 *   1. timestamped player notes (own module, player's own clock, local keys)
 *   2. focus timer + hover prefetch in ui.js
 *   3. home study hub + recommendations + voice search
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(ROOT, p), "utf8");

test("player notes: card on the watch page, module seeks the real <video>", async () => {
  const html = await read("public/watch.html");
  for (const id of ["notesCard", "noteInput", "noteAdd", "noteMark", "notesList", "noteStamp"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} missing from watch page`);
  }
  assert.match(html, /watch-notes\.js/, "notes module is not loaded");
  const js = await read("public/assets/watch-notes.js");
  assert.match(js, /notes:\$\{lectureId\}/, "notes must be stored per lecture");
  assert.match(js, /video\.currentTime = n\.t/, "clicking a note must seek");
});

test("focus timer and hover prefetch ship site-wide", async () => {
  const ui = await read("public/assets/ui.js");
  assert.match(ui, /focus-chip/);
  assert.match(ui, /arsvibe\.focus/, "focus sessions must persist per day");
  assert.match(ui, /rel = "prefetch"|rel="prefetch"|"prefetch"/, "hover prefetch missing");
});

test("home: study hub, recommendations, voice search", async () => {
  const html = await read("public/index.html");
  assert.match(html, /id="hubSection"/);
  assert.match(html, /id="recoSection"/);
  assert.match(html, /id="voiceSearchBtn"/);
  const home = await read("public/assets/home.js");
  assert.match(home, /progress\(\)/, "hub must read the real progress store");
  assert.match(home, /searchBatches\(goal\)/, "recommendations must search the catalogue");
  assert.match(home, /SpeechRecognition/, "voice search must use the speech API");
});
