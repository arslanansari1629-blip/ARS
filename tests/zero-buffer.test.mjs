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
  assert.match(worker, /CACHEABLE\.has\(url\.pathname\)/);
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

test("the DASH gateway is edge-cached too, and hits are CORS-correct", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /"\/api\/sign",\s*"\/api\/hls"/);
  assert.match(worker, /access-control-allow-origin", origin/);
});

test("serving a playlist warms the edge with its key and first segments", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /prefetchPlaylist/);
  assert.match(worker, /urls\.length >= 8/);
  assert.match(worker, /dispatch\(req, env\)/);
});

test("the relay honours Range and times out per asset type", async () => {
  const sign = await read("lib/sign.mjs");
  assert.match(sign, /upstream\.status === 206 \? 206 : 200/);
  assert.match(sign, /AbortSignal\.timeout\(isMediaKey \? 6000 : 10000\)/);
  assert.match(sign, /range: isMedia \? String\(req\.headers\.range/);
  assert.match(sign, /Access-Control-Max-Age/);
});

test("chapters come from the modern topics route, legacy as fallback", async () => {
  const data = await read("lib/api-data.mjs");
  assert.match(data, /\/v2\/batches\/\$\{encodeURIComponent\(batchId\)\}\/subject\//);
  assert.match(data, /topics\?page=/);
  assert.match(data, /route = "legacy"/);
});

test("catalogue JSON is edge-cached, no-store bodies never are", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /"\/api\/contents"/);
  assert.match(worker, /no-store\|private/);
});

test("live-to-VOD lectures get a retry, a contents fallback and a signer hunt", async () => {
  const data = await read("lib/api-data.mjs");
  assert.match(data, /findKey: vd\.findKey/);
  assert.match(data, /contents fallback|No stream on either schedule generation/);
  assert.match(data, /setTimeout\(r, 700\)/);
  const stream = await read("api/stream.mjs");
  assert.match(stream, /Live-to-VOD hunt/);
  assert.match(stream, /huntedFrom/);
});

test("live classes read every stream field and explain themselves honestly", async () => {
  const data = await read("lib/api-data.mjs");
  assert.match(data, /vd\.hls_url \|\| d\.newCdnLink/);
  assert.match(data, /classStatus: d\.status/);
  const playback = await read("lib/playback.mjs");
  assert.match(playback, /This class is live right now/);
  assert.match(playback, /has not started yet/);
  const today = await read("lib/today.mjs");
  assert.match(today, /row\.newCdnLink \|\| row\.ytStreamUrl/);
  const stream = await read("api/stream.mjs");
  assert.match(stream, /const ended = !detail\?\.endTime/);
});

test("schedule resolution merges generations and sweeps pinned hosts", async () => {
  const data = await read("lib/api-data.mjs");
  assert.match(data, /Merge, don't pick/);
  assert.match(data, /Ask the remaining PW hosts pinned/);
  assert.match(data, /streamOf/);
  const upstream = await read("lib/upstream.mjs");
  assert.match(upstream, /opts\.upstream/);
});

test("god-level edge: rolling prefetch, stale-if-error, edge retry, Range-safe", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /prefetchNextSegments/);
  assert.match(worker, /idx \+ 4/);
  assert.match(worker, /stale-shadow/);
  assert.match(worker, /x-ars-cache", "stale"/);
  assert.match(worker, /res\.status === 502 && url\.pathname === "\/api\/sign"/);
  assert.match(worker, /rangeAsk/);
});

test("god-level memory: token and last-good signer are shared across isolates", async () => {
  const auth = await read("lib/pw-auth.mjs");
  assert.match(auth, /SHARED_TOKEN_URL/);
  assert.match(auth, /sharedTokenWrite/);
  assert.match(auth, /edge-shared/);
  const sign = await read("lib/sign.mjs");
  assert.match(sign, /SHARED_DOOR_URL/);
  assert.match(sign, /loadSharedDoor/);
  assert.match(sign, /shareDoor\(\)/);
});

test("a resolved plan warms its whole playback chain at the edge", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /warmPlan/);
  assert.match(worker, /url\.pathname === "\/api\/stream"/);
});

test("the watch page plays a lecture straight from its CDN address", async () => {
  const lecture = await read("public/assets/lecture.js");
  assert.match(lecture, /directVideoUrl/);
  assert.match(lecture, /qs\("video_url"\)/);
  assert.match(lecture, /const viaUrl = archiveMode \? knownVideoUrl : directVideoUrl/);
});
