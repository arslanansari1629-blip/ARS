import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { swNormBatch, swSlimClass, SW_SAMPLE_BATCH } from "../lib/selectionway.mjs";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("Selection Way batch + class normalisers keep the honest fields", () => {
  const b = swNormBatch({
    id: "abc", title: "Selection Batch  Vod 5.0", banner: "https://x/wide.jpg", bannerSquare: "https://x/sq.jpg",
    price: 4999, discountPrice: 999, mainCategory: "SSC", facultyName: "Gagan Pratap Sir",
    isRecorded: true, _count: { classes: 500, topics: 9 }, highlights: '["Recorded classes"]',
  });
  assert.equal(b.banner, "https://x/sq.jpg");
  assert.equal(b.bannerWide, "https://x/wide.jpg");
  assert.equal(b.classesCount, 500);
  assert.deepEqual(b.highlights, ["Recorded classes"]);
  const c = swSlimClass({
    id: "k1", title: "Class - 01", teacherName: "HARISH SIR", duration: 5660,
    classLink: "https://cdn/master.m3u8", pdfs: [{ url: "https://x/a.pdf" }], recordings: [],
  });
  assert.equal(c.hasVideo, true);
  assert.equal(c.pdfCount, 1);
  assert.equal("classLink" in c, false, "slim classes must not leak stream URLs; play resolves them");
});

test("Selection Way ships in TEST MODE only: page exists, landing stays Coming Soon", async () => {
  const page = await read("public/selectionway-test.html");
  assert.match(page, /TEST MODE/, "test page must wear its test banner");
  assert.match(page, /noindex/, "test page must stay out of indexes");
  assert.match(page, /id="swView"/, "test page renders the native catalogue");
  assert.match(page, /id="swVideo"/, "test page has its own player");
  assert.match(page, /selectionway-test\.js/, "test page loads the native client");

  const home = await read("public/index.html");
  assert.doesNotMatch(home, /selectionway-test|data-platform="selectionway"/, "landing must not link the test platform");
  assert.match(home, /data-soon="coming-next"/, "landing card must stay Coming Soon until the operator says live");

  const js = await read("public/assets/selectionway-test.js");
  assert.match(js, /\/api\/selectionway\?view=batches/, "client must read the batches view");
  assert.match(js, /\/api\/selectionway\?view=play/, "client must resolve playback through the play view");

  const lib = await read("lib/selectionway.mjs");
  assert.match(lib, /api\/batches\/\$\{encodeURIComponent\(batchId\)\}\/classes/, "classes must come from the mapped upstream");
  assert.ok(SW_SAMPLE_BATCH.length >= 20, "the operator's sample batch id is pinned");
  await access(new URL("../public/assets/platforms/coming-next.png", import.meta.url));
});
