/**
 * Round 8: Iris UI — Live card in the rail (retained); the rail colours
 * themselves were superseded by the Round 9 professional design.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the sidebar is the ink-violet Iris rail", async () => {
  const css = await read("public/assets/arsvibe.css");
  const r8 = css; // whole sheet: build minification strips section comments
  assert.match(css, /\.side\s*\{[^}]*background: ?#fff/);
  assert.match(r8, /\.side-link\.active\s*\{[^}]*background: ?#1e3a8a/);
  assert.match(r8, /\.side-live\s*\{/);
  assert.match(css, /--blue: ?#1d4ed8/);
  assert.match(css, /--r: ?12px/);
});

test("the shell builds the Live card into the sidebar", async () => {
  const shell = await read("public/assets/shell.mjs");
  assert.match(shell, /class="side-live" href="\/live\.html"/);
  assert.match(shell, /side-live-dot/);
  // Existing structure the pages rely on is unchanged.
  assert.match(shell, /details class="side-group"/);
  assert.match(shell, /side-link/);
});
