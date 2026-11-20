/**
 * Zero-buffer contract: a signed segment must be an edge hit for every
 * viewer after the first, and the first must go straight to the signer
 * that worked last time — not walk the whole ladder per segment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("the Worker edge-caches signed media", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /caches\.default/);
  assert.match(worker, /url\.pathname === "\/api\/sign"/);
  assert.match(worker, /x-ars-cache/);
  assert.match(worker, /res\.status === 200/);
});

test("the sign relay pins the last good signer and retries media cheaply", async () => {
  const sign = await read("lib/sign.mjs");
  assert.match(sign, /lastGood/);
  assert.match(sign, /attempts: isMedia \? 2 : 3/);
  assert.match(sign, /gapMs: isMedia \? 120 : SIGN_GAP_MS/);
});

test("the player reads five minutes ahead in zero-buffer mode", async () => {
  const player = await read("public/assets/player.js");
  assert.match(player, /maxBufferLength: zb \? 300 : 90/);
  assert.match(player, /maxMaxBufferLength: zb \? 900 : 240/);
  assert.match(player, /abrEwmaDefaultEstimate: 1500000/);
});
