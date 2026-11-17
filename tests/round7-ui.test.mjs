/**
 * Round 7: Daylight UI — light tokens, zero webfonts, player stays dark.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the design tokens are the light Daylight set", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /--paper: ?#f8fafc/);
  assert.match(css, /--card: #ffffff/);
  assert.match(css, /--ink: ?#0f172a/);
  assert.match(css, /\.footer\s*\{[^}]*background: ?#fff/);
  // No webfont families remain in the type stack.
  assert.doesNotMatch(css, /--font: "Inter"/);
  assert.doesNotMatch(css, /--display: "Sora"/);
});

test("no page loads Google Fonts and every page declares the light theme", async () => {
  const pages = (await readdir(new URL("public/", root))).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 19);
  for (const page of pages) {
    const html = await read(`public/${page}`);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, `${page} still loads webfonts`);
  }
  const watch = await read("public/watch.html");
  assert.match(watch, /theme-color" content="#f4f5fb"/);
});

test("the player stage stays a dark cinema screen", async () => {
  const css = await read("public/assets/arsvibe.css");
  const round7 = css; // whole sheet: build minification strips section comments
  assert.match(round7, /\.player-stage\s*\{[^}]*background: ?radial-gradient\(circle at 50% 42%, ?#131b26/);
  assert.match(round7, /\.nav\s*\{[^}]*background: ?rgba\(255, ?255, ?255, ?0\.8\)/);
});
