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

test("Vidyakul stays parked while the native build is prepared", async () => {
  const page = await read("public/vidyakul.html");
  assert.match(page, /Coming Soon/, "/vidyakul must remain Coming Soon until launch");
  const ui = await read("public/vidyakul-ui.html");
  assert.match(ui, /vidyakul-native\.js/, "prepared UI must use the native client");
  assert.doesNotMatch(ui, /<iframe/, "native UI must not embed the upstream");
});
