import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("Pro Ultra layer refines the whole site from one sheet", async () => {
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /Pro Ultra \(2026 refresh\)/, "the professional finish layer is missing");
  // The pinned brand tokens survive the refresh untouched.
  assert.match(css, /--paper: ?#faf6ef/);
  assert.match(css, /--blue: ?#e4572e/);
  // Signature pieces of the new language.
  assert.match(css, /\.nav\s*\{[^}]*backdrop-filter/, "glass top bar missing");
  assert.match(css, /\.btn-primary\s*\{[^}]*background: var\(--aurora\)/, "gradient CTA missing");
  assert.match(css, /:focus-visible/, "focus ring missing");
  assert.match(css, /prefers-reduced-motion/, "reduced-motion calm missing");
});

test("landing finish: per-platform accents, nothing starts hidden", async () => {
  const css = await read("public/assets/home-landing.css");
  assert.match(css, /Pro Ultra landing finish/);
  assert.match(css, /data-platform="vidyakul"\]::before/);
  assert.doesNotMatch(css, /\.platform-card[^}]*opacity:\s*0/s, "cards must never start hidden");
});

test("Vidyakul speaks the site language now, not hardcoded dark panels", async () => {
  const css = await read("public/assets/vidyakul-native.css");
  assert.match(css, /Pro Ultra finish/);
  assert.match(css, /var\(--card\)/, "Vidyakul surfaces must use site tokens");
  assert.doesNotMatch(css, /#0e2120/, "the old dark-green panels must be gone");
});
