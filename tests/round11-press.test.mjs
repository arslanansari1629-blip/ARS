/**
 * Round 11 — Study Press: warm paper, espresso ink, vermilion accent,
 * hard offset shadows and mono micro-labels; the player stage is a
 * warm-black room with a vermilion rail and paper menus.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the palette is warm paper, espresso ink, vermilion", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /--paper: ?#faf6ef/);
  assert.match(css, /--card: ?#fffdf8/);
  assert.match(css, /--ink: ?#1c1917/);
  assert.match(css, /--blue: ?#e4572e/);
  assert.match(css, /--aurora: ?linear-gradient\(120deg, ?#e4572e/);
});

test("press components: ink rules, hard shadows, mono labels", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /\.btn\s*\{[^}]*box-shadow: ?3px 3px 0 var\(--ink\)/);
  assert.match(css, /\.btn:active\s*\{[^}]*transform: ?translate\(2px, ?2px\)/);
  assert.match(css, /\.batch-card,[^{]*\{[^}]*box-shadow: ?5px 5px 0/);
  assert.match(css, /\.pill,[^{]*\{[^}]*font-family: ?var\(--mono\)[^}]*text-transform: ?uppercase/);
  assert.match(css, /\.side\s*\{[^}]*#241c14/);
  assert.match(css, /\.side-link\.active\s*\{[^}]*background: ?var\(--blue\)/);
});

test("the player wears the press skin and the dock is framed", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /\.player-stage\s*\{[^}]*#2a1e12/);
  assert.match(css, /\.scrubber-played\s*\{[^}]*background: ?var\(--aurora\)/);
  assert.match(css, /\.player-menu\s*\{[^}]*background: ?var\(--paper\)/);
  assert.match(css, /\.icon-btn\.icon-primary\s*\{[^}]*background: ?var\(--blue\)/);
  assert.match(css, /\.player-wrap\.is-mini\s*\{[^}]*box-shadow: ?6px 6px 0/);
});

test("pages declare the paper theme colour", async () => {
  const watch = await read("public/watch.html");
  assert.match(watch, /theme-color" content="#faf6ef"/);
});
