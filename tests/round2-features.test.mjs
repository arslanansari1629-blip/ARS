/**
 * Round 2 features — pinned so a future cleanup cannot quietly drop them:
 *   1. accent themes exist as CSS token overrides + a nav picker that persists
 *   2. the home page has exam-goal signposts and a continue-watching rail
 *   3. batches carries goal chips that ride the existing ?q= search
 *   4. the scroll-progress hairline, back-to-top and shortcut map ship in ui.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(ROOT, p), "utf8");

test("accent themes: token overrides in CSS, picker + persistence in ui.js", async () => {
  const css = await read("public/assets/arsvibe.css");
  for (const accent of ["ocean", "emerald", "sunset"]) {
    assert.match(css, new RegExp(`html\\[data-accent="${accent}"\\]`), `${accent} theme missing`);
    assert.match(css, new RegExp(`\\.accent-dot\\[data-accent="${accent}"\\]`), `${accent} dot missing`);
  }
  const ui = await read("public/assets/ui.js");
  assert.match(ui, /applyAccent\(getPrefs\(\)\.accent/, "the saved accent is not applied on load");
  assert.match(ui, /setPref\("accent"/, "picking an accent does not persist it");
});

test("home: the landing is a platform picker (goal/continue moved off the front door)", async () => {
  const html = await read("public/index.html");
  // The NextHope-style landing replaced the catalogue-home: goal tiles
  // and the continue rail live where they belong now (batches carries
  // the goal chips; the dashboard carries progress), and the front
  // door's only job is sending a student to a platform.
  assert.doesNotMatch(html, /id="goalGrid"/, "goal grid must stay off the landing");
  assert.doesNotMatch(html, /id="continueRail"/, "continue rail must stay off the landing");
  assert.match(html, /id="platforms"/, "the platform picker is the home page now");
  assert.match(html, /href="\/batches\.html"/, "PW platform must be one click from home");
  assert.match(html, /href="\/allen\.html"/, "Allen platform must be one click from home");
});

test("batches: goal chips ride ?q=, instruments ride ui.js", async () => {
  const batches = await read("public/batches.html");
  assert.match(batches, /class="goal-chips"/);
  assert.match(batches, /batches\.html\?q=NEET/);
  const ui = await read("public/assets/ui.js");
  assert.match(ui, /scroll-progress/, "reading progress hairline missing");
  assert.match(ui, /to-top/, "back-to-top missing");
  assert.match(ui, /openShortcuts/, "the ? shortcut map missing");
  for (const key of ["h", "b", "f", "l", "d", "w"]) {
    assert.match(ui, new RegExp(`${key}: "/`), `g+${key} navigation missing`);
  }
});
