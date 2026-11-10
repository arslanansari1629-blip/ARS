/**
 * How long a lecture takes to start, and what it starts on.
 *
 * Two separate costs sat between a tap and the first frame:
 *
 *  1. The guest token was minted, *then* used. Two network round trips in a row
 *     for one question. The mint is now started first and used if it has landed;
 *     a signer that refuses the empty token costs one retry, and a signer that
 *     accepts it costs nothing.
 *  2. Playback opened on the highest rendition. On a line that cannot sustain it
 *     hls.js discovers that mid-segment and steps down — a spinner at the start
 *     of every lecture. `qualityHints` remembers what this machine got for the
 *     folder; with no hint the middle of the ladder is chosen, so the first
 *     segment arrives quickly and the player steps *up*.
 *
 * These tests fail on the pre-fix code: the first never retries (it reports the
 * lecture unplayable), and the second opens on the top rendition.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveStream, pickStartPoint } from "../lib/api-data.mjs";
import { resetToken } from "../lib/pw-auth.mjs";

const FOLDER = "e76c2cf2-413b-4f14-a7b5-8ebeb6c60523";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=1188000,RESOLUTION=1920x1080",
  "1080/main.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=792000,RESOLUTION=1280x720",
  "720/main.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=854x480",
  "480/main.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=396000,RESOLUTION=640x360",
  "360/main.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=264000,RESOLUTION=426x240",
  "240/main.m3u8",
  "",
].join("\n");

/**
 * A signer that will only answer to a token that looks minted.
 *
 * `mintDelayMs` makes the mint slower than the fetch, which is the whole point:
 * the probe has to get going before the token exists.
 */
// Long enough to pass `usable()` in `lib/pw-auth.mjs`, and *not* a substring of
// the minted token, so a test can tell the two attempts apart.
const STALE = "stale-builtin-fallback-0000";
const MINTED = "minted-token-abcdefghijklmnop";
function stubSigner({ mintDelayMs = 40, requireToken = true, firstPassToken = "" } = {}) {
  // Module-level token state leaks between tests in one file: without this a
  // later test starts with an already-minted token and silently measures the
  // fast path while claiming to measure the slow one.
  resetToken();
  process.env.PW_TOKEN = firstPassToken;
  const seen = { master: 0, minted: false };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (/generate_token/.test(url)) {
      await new Promise((r) => setTimeout(r, mintDelayMs));
      seen.minted = true;
      return new Response(JSON.stringify({ token: MINTED, expiresIn: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    seen.master += 1;
    const auth = String((init && init.headers && (init.headers.authorization || init.headers.Authorization)) || "");
    // The signer refuses anything that is not a freshly minted token, which is
    // what a real 401 from a cold relay looks like.
    if (requireToken && !auth.includes(MINTED)) {
      return new Response("refused", { status: 401 });
    }
    return new Response(MASTER, { status: 200 });
  };
  return seen;
}

test("a signer that refuses the unfinished mint still starts the lecture", async () => {
  const seen = stubSigner({ mintDelayMs: 40, requireToken: true });
  const plan = await resolveStream({ rawUrl: "", folder: FOLDER, fresh: true });

  assert.equal(plan.playable, true, `expected a playable plan, got reason: ${plan.reason}`);
  assert.ok(seen.minted, "the token should have been minted");
  assert.ok(
    seen.master > 5,
    `expected the probe to run twice (once per pass), saw ${seen.master} manifest fetches`
  );
  assert.ok(plan.timing && plan.timing.totalMs >= 0, "a cold start should report its timing");
});

test("probing does not wait for the token before the first pass", async () => {
  // The mint is slower than a whole probe pass. If the probe waited for it, the
  // cold start could not finish in less than the mint delay plus a pass.
  //
  // The token is *refused* here on purpose: with a usable token a serialised
  // probe would also be fast, so the test would pass on the old code and prove
  // nothing. Refusing forces the old code down its serial path, where it must
  // wait out the 400 ms mint before the retry can even start.
  const seen = stubSigner({ mintDelayMs: 400, requireToken: true });
  const started = Date.now();
  const plan = await resolveStream({ rawUrl: "", folder: FOLDER, fresh: true });
  const elapsed = Date.now() - started;

  assert.equal(plan.playable, true);
  assert.equal(seen.master > 0, true);
  assert.ok(
    elapsed < 350,
    `cold start took ${elapsed} ms — the probe waited for the mint instead of overlapping it`
  );
});

test("a cold start opens in the middle of the ladder, not the top", async () => {
  stubSigner({ requireToken: false });
  const plan = await resolveStream({ rawUrl: "", folder: FOLDER, fresh: true });

  assert.equal(plan.playable, true);
  assert.deepEqual(plan.renditions, ["1080", "720", "480", "360", "240"].filter((q) => plan.renditions.includes(q)));
  assert.notEqual(plan.quality, "1080", "opening on the top rendition is what made starts stall");
  assert.equal(plan.quality, "480");
  // Every level must still be offered, or the choice is a demotion, not a start point.
  assert.equal(plan.renditions.length, 5);
});

test("a recovery resumes at the quality the student was watching", async () => {
  stubSigner({ requireToken: false });
  const plan = await resolveStream({ rawUrl: "", folder: FOLDER, startLevel: "720", fresh: true });

  assert.equal(plan.playable, true);
  assert.equal(plan.quality, "720", "a retry should come back on the level the student had");
  assert.equal(plan.renditions.length, 5, "resuming at a level must never shorten the ladder");
});

test("a start point off the ladder falls back to the middle, never to nothing", () => {
  const ladder = ["1080", "720", "480", "360", "240"].map((quality) => ({ quality }));
  assert.equal(pickStartPoint(ladder, "720").quality, "720");
  // A level that vanished between plans (a re-encode) must not dead-end.
  assert.equal(pickStartPoint(ladder, "9000").quality, "480");
  assert.equal(pickStartPoint([], "720"), null);
});

test("resolveTimings reports real numbers, not nulls", async () => {
  const { resolveTimings } = await import("../lib/api-data.mjs");
  stubSigner({ requireToken: false });
  await resolveStream({ rawUrl: "", folder: "aaaaaaaa-1111-2222-3333-444444444444", fresh: true });

  const t = resolveTimings();
  assert.equal(t.samples > 0, true);
  // The instrumentation is only useful if the keys line up; a mismatch shows up
  // here as a null median and silently reports nothing.
  for (const key of ["totalMs", "tokenMs", "probeMs"]) {
    assert.equal(typeof t[key], "number", `${key} should be a median number, got ${t[key]}`);
  }
});
