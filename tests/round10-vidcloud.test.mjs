/**
 * Round 10: vidcloud-style UI — indigo-night catalogue, panel cards,
 * gradient "Let's Study" call to action on every batch card.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the palette is the reference's indigo night", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /--paper: ?#faf6ef/);
  assert.match(css, /--card: ?#fffdf8/);
  assert.match(css, /--blue: ?#e4572e/);
  assert.match(css, /--aurora: ?linear-gradient\(120deg, ?#e4572e/);
});

test("every batch card draws the Let's Study call to action", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /\.batch-body::after\s*\{[^}]*content: "Let's Study →"/);
  assert.match(css, /\.batch-card,[^{]*\{[^}]*border: ?2px solid var\(--ink\)/);
  assert.match(css, /\.batch-thumb\s*\{[^}]*aspect-ratio: 16 \/ 8\.2/);
  // The sidebar active page is the reference's gradient pill.
  assert.match(css, /\.side-link\.active\s*\{[^}]*background: var\(--aurora\)/);
});

test("pages declare the dark theme colour", async () => {
  const watch = await read("public/watch.html");
  assert.match(watch, /theme-color" content="#faf6ef"/);
});
