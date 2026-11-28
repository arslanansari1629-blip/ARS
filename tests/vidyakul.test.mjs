import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { vkXor6, vkTable, vkEncryptData, vkDecryptData } from "../lib/vidyakul.mjs";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("Vidyakul XOR-6 string layer decodes known cribs", () => {
  assert.equal(vkXor6("ejguu"), "class");
  assert.equal(vkXor6("dgrencu"), "batches");
  assert.equal(vkXor6("nrrvu<))"), "https://");
  assert.equal(vkXor6("usdlceruYjour"), "subjects_list");
});

test("Vidyakul table parser decodes entries with indices", () => {
  const plain = `let ᚲᚠᛏᚩ=["rokcurgkvu","hiq","dgrencu"];`;
  const table = vkTable(plain);
  assert.equal(table[2], "batches");
});

test("Vidyakul AES round-trips (course slugs & response data)", async () => {
  const enc = await vkEncryptData("10-reloaded-b-2026");
  assert.equal(await vkDecryptData(enc), "10-reloaded-b-2026");
});

test("Vidyakul native views are dispatched before probes", async () => {
  const src = await read("lib/vidyakul.mjs");
  for (const v of ["batches", "search", "classes", "play"]) {
    assert.match(src, new RegExp(`view === "${v}"`), `view=${v} missing`);
  }
  assert.match(src, /get_courses\.php/, "catalogue endpoint missing");
  assert.match(src, /fetch_classes\.php/, "classes endpoint missing");
  assert.match(src, /play\.php/, "player endpoint missing");
  assert.match(src, /videoUrl/, "videoUrl extraction missing");
});

test("Vidyakul v2 engineering: cache, resume player, saved & filters", async () => {
  const js = await read("public/assets/vidyakul-native.js");
  assert.match(js, /sessionStorage/, "API responses must be cached");
  assert.match(js, /ars:vk:pos:/, "per-lecture resume positions must persist");
  assert.match(js, /ars:vk:saved/, "saved batches must persist");
  assert.match(js, /ars:vk:recent/, "continue-watching must persist");
  assert.match(js, /fillQualityLevels/, "HLS quality ladder must be surfaced");
  const page = await read("public/vidyakul.html");
  assert.match(page, /id="vkQuality"/, "player quality control missing");
  assert.match(page, /id="vkSpeed"/, "player speed control missing");
  assert.match(page, /id="vkStatBatches"/, "hero stats missing");
  const css = await read("public/assets/vidyakul-native.css");
  assert.match(css, /\.vk-toolbar\s*\{[^}]*position: sticky/, "glass toolbar must stick");
  assert.match(css, /\.vk-skel/, "skeleton grid missing");
});

test("Vidyakul page is the live native client, not an embed", async () => {
  const page = await read("public/vidyakul.html");
  assert.match(page, /vidyakul-native\.js/, "live page must use the native client");
  assert.match(page, /id="vkView"/, "live page must have the catalogue view");
  assert.match(page, /id="vkVideo"/, "live page must have its own player");
  assert.doesNotMatch(page, /<iframe|vidyakul-app/, "native UI must not embed the upstream");
});
