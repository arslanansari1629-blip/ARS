/**
 * Ultra-fast player: the settings that decide whether a stall is a blink
 * or a twenty-second freeze, and the plan cache that makes a popular
 * lecture's second opening an edge hit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("a hung fragment fails fast and retries fast", async () => {
  const player = await read("public/assets/player.js");
  assert.match(player, /fragLoadingTimeOut: 8000/);
  assert.doesNotMatch(player, /fragLoadingTimeOut: 20000/);
  assert.match(player, /fragLoadingRetryDelay: 250/);
  assert.match(player, /fragLoadingMaxRetryTimeout: 3000/);
  assert.match(player, /manifestLoadingTimeOut: 8000/);
});

test("the first fragment is the smallest rendition", async () => {
  const player = await read("public/assets/player.js");
  assert.match(player, /startLevel: 0/);
  // ABR still climbs quickly once real bandwidth is measured.
  assert.match(player, /abrEwmaSlowVoD: 8/);
  // The deep read-ahead that makes stalls invisible is untouched.
  assert.match(player, /maxBufferLength: zb \? 300 : 90/);
  assert.match(player, /startFragPrefetch: true/);
});

test("the stall watchdog reacts in three seconds", async () => {
  const player = await read("public/assets/player.js");
  assert.match(player, /\}, 3000\);/);
});

test("relay plans are edge-cached for four minutes, retries bypass", async () => {
  const stream = await read("api/stream.mjs");
  assert.match(stream, /startsWith\("\/api\/sign\?"\)\) return 240/);
  assert.match(stream, /Number\(attempt \|\| 0\) > 0\) return 0/);
});
