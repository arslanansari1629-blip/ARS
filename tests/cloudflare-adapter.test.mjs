/**
 * The Cloudflare Pages adapter runs the Vercel handlers unchanged:
 * route table (incl. the mounted aliases), JSON bodies in both
 * directions, and an honest 404 for unknown routes.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const { dispatch } = await import("../functions/api/[[route]].js");
const call = (path, init) => dispatch(new Request(`https://arsvibe.pages.dev${path}`, init), {});

test("unknown routes answer 404, not a crash", async () => {
  const res = await call("/api/definitely-not-a-route");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Unknown API route/);
});

test("the local catalogue answers through the adapter", async () => {
  const res = await call("/api/batches?facets=1");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.languages) && data.languages.length > 0);
});

test("JSON bodies round-trip (comments post then read)", async () => {
  const lecture = `adapter-${Date.now()}`;
  const post = await call("/api/token?route=comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lecture, name: "Ada", text: "adapter works" }),
  });
  assert.equal(post.status, 200);
  const read = await call(`/api/token?route=comments&lecture=${lecture}`);
  const data = await read.json();
  assert.equal(data.total, 1);
  assert.equal(data.comments[0].text, "adapter works");
});

test("mounted aliases reach their handlers", async () => {
  // Each alias must answer with its own handler's validation, not a 404.
  const sign = await call("/api/sign?videoKey=abc&key=master.m3u8");
  assert.match(await sign.text(), /renditions is required/);
  const download = await call("/api/download");
  assert.match(await download.text(), /Provide folder=/);
});
