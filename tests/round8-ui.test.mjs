/**
 * Round 8: Iris UI — ink-violet sidebar rail, gradient active pill,
 * Live card in the rail, porcelain content in the new palette.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the sidebar is the ink-violet Iris rail", async () => {
  const css = await read("public/assets/arsvibe.css");
  const r8 = css.slice(css.indexOf("ROUND 8"));
  assert.match(r8, /\.side \{\s+background: linear-gradient\(180deg, #1a1438/);
  assert.match(r8, /\.side-link\.active \{\s+background: var\(--aurora\)/);
  assert.match(r8, /\.side-live \{/);
  assert.match(css, /--blue: #6c3ce9/);
  assert.match(css, /--r: 20px/);
});

test("the shell builds the Live card into the sidebar", async () => {
  const shell = await read("public/assets/shell.mjs");
  assert.match(shell, /class="side-live" href="\/live\.html"/);
  assert.match(shell, /side-live-dot/);
  // Existing structure the pages rely on is unchanged.
  assert.match(shell, /details class="side-group"/);
  assert.match(shell, /side-link/);
});
