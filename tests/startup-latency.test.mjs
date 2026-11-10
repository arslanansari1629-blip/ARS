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

import { resolveStream, pickStartPoint, forgetSignerToken } from "../lib/api-data.mjs";
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
  forgetSignerToken();
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

test("the probe is in flight before the mint has landed", async () => {
  // The old order was mint -> probe: every request paid the mint before the
  // first signer was even asked. The new order starts both and uses the token if
  // it is ready, so the *ordering* is the property to pin, not a duration — a
  // duration can be beaten by a warm cache and then proves nothing.
  //
  // The signer refuses here on purpose: with a token that works, a serialised
  // probe is also fast, and the test would pass on the old code.
  const mintDelay = 400;
  resetToken();
  forgetSignerToken();
  process.env.PW_TOKEN = "";
  let mintedAt = 0;
  let firstProbeAt = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (/generate_token/.test(url)) {
      await new Promise((r) => setTimeout(r, mintDelay));
      mintedAt = Date.now();
      return new Response(JSON.stringify({ token: MINTED }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const auth = String((init && init.headers && (init.headers.authorization || "")) || "");
    if (!firstProbeAt) firstProbeAt = Date.now();
    if (!auth.includes(MINTED)) return new Response("refused", { status: 401 });
    return new Response(MASTER, { status: 200 });
  };

  const plan = await resolveStream({ rawUrl: "", folder: FOLDER, fresh: true });
  assert.equal(plan.playable, true, `the retry did not recover: ${plan.reason}`);

  assert.ok(firstProbeAt, "no probe was sent at all");
  assert.ok(mintedAt, "the token was never minted");
  assert.ok(
    firstProbeAt < mintedAt,
    `the first probe went out ${firstProbeAt - mintedAt} ms after the mint finished — ` +
      "the request is serialised again"
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

test("a signer that answers anonymously does not cost the mint", async () => {
  // This is the production shape, and it was the whole cold start: the signer
  // answers an anonymous probe, so the token is never needed — but the resolver
  // awaited the mint anyway. Production showed totalMs 2182 against tokenMs
  // 2181, i.e. the token was ~100 % of a request that never used it.
  stubSigner({ mintDelayMs: 600, requireToken: false });
  const started = Date.now();
  const plan = await resolveStream({ rawUrl: "", folder: FOLDER, fresh: true });
  const elapsed = Date.now() - started;

  assert.equal(plan.playable, true);
  assert.ok(
    elapsed < 400,
    `cold start took ${elapsed} ms with a 600 ms mint — the happy path waited for a token it did not use`
  );
});

test("latency medians are real numbers, not zeros", async () => {
  // The instrument must never report 0 for a request that plainly took time:
  // zeros look like a fast server and hide a regression. Same key-mismatch trap
  // as the null medians, one step later.
  const { resolveTimings } = await import("../lib/api-data.mjs");
  stubSigner({ mintDelayMs: 20, requireToken: false });
  await resolveStream({ rawUrl: "", folder: "bbbbbbbb-1111-2222-3333-444444444444", fresh: true });

  const t = resolveTimings();
  assert.equal(t.samples > 0, true);
  assert.ok(t.totalMs > 0, `totalMs median was ${t.totalMs} — the sample recorded zeros`);
  assert.ok(t.probeMs > 0, `probeMs median was ${t.probeMs}`);
  // The probe dominates now: it is the request that actually has to happen.
  assert.ok(t.probeMs <= t.totalMs, "the probe cannot take longer than the whole resolution");
});

test("the plan and the medians tell the same story", async () => {
  // In production the plan reported `timing: {totalMs: 2182}` while the medians
  // reported `{samples: 1, totalMs: 0}` — the sample was recorded through the
  // wrong key and nothing complained. A reader who trusts one number and not the
  // other should not be able to see them disagree.
  const { resolveTimings, forgetSignerToken } = await import("../lib/api-data.mjs");
  stubSigner({ mintDelayMs: 20, requireToken: false });
  forgetSignerToken();
  const plan = await resolveStream({ rawUrl: "", folder: "cccccccc-1111-2222-3333-444444444444", fresh: true });

  assert.equal(plan.playable, true);
  assert.ok(plan.timing && plan.timing.totalMs > 0, "the plan must carry its own cost");

  const t = resolveTimings();
  assert.equal(t.samples > 0, true, "the cold start was not recorded");
  assert.ok(t.totalMs > 0, "the medians reported zeros for a request that took time");
});

test("token time measures the mint, not the probe", async () => {
  // Production reported totalMs = tokenMs = probeMs = 2206: three labels on one
  // number, because the token timer was read after the probe finished. Real
  // values with meaningless labels are worse than no instrument — they pointed
  // at the mint when the probe was the cost.
  //
  // The contract, both halves:
  //   - a request the signer answered anonymously did NOT pay for the mint, so
  //     tokenMs is 0 and clearly not the same number as totalMs;
  //   - a request that had to wait for the mint reports it, and reports less
  //     than the total (the probe is the rest).
  stubSigner({ mintDelayMs: 250, requireToken: false });
  const free = await resolveStream({ rawUrl: "", folder: "dddddddd-1111-2222-3333-444444444444", fresh: true });
  assert.equal(free.playable, true);
  assert.equal(free.timing.tokenMs, 0, "a request that never waited for the mint must not claim its cost");
  assert.ok(free.timing.probeMs > 0, "the probe was not timed");
  assert.notEqual(free.timing.tokenMs, free.timing.totalMs, "two labels on one number again");

  stubSigner({ mintDelayMs: 250, requireToken: true });
  const paid = await resolveStream({ rawUrl: "", folder: "eeeeeeee-1111-2222-3333-444444444444", fresh: true });
  assert.equal(paid.playable, true, `the retry did not recover: ${paid.reason}`);
  assert.ok(paid.timing.tokenMs >= 240, `tokenMs was ${paid.timing.tokenMs}; the wait for the mint was not measured`);
  assert.ok(
    paid.timing.tokenMs < paid.timing.totalMs,
    `tokenMs (${paid.timing.tokenMs}) is the whole request; the clock starts too late`
  );
});

test("a sleepy mirror does not set the latency of the lecture", async () => {
  // The ladder is asked in parallel, and `Promise.all` used to wait for the
  // *last* answer — so a host that took four seconds made every lecture take
  // four seconds even though a healthy host had replied at once. Production sat
  // at 2.2 s for this reason. Once every rendition is spoken for, extra answers
  // cannot change the plan, so the request must not wait for them.
  resetToken();
  forgetSignerToken();
  process.env.PW_TOKEN = "";
  const healthy = "https://vidcloud.eu.org";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (/generate_token/.test(url)) {
      return new Response(JSON.stringify({ token: MINTED }), { status: 200 });
    }
    if (url.startsWith(healthy)) return new Response(MASTER, { status: 200 });
    // Everything else: a mirror that is up but wedged. It must not be waited on.
    await new Promise((r) => setTimeout(r, 3000));
    return new Response(MASTER, { status: 200 });
  };

  const started = Date.now();
  const plan = await resolveStream({ rawUrl: "", folder: "ffffffff-1111-2222-3333-444444444444", fresh: true });
  const elapsed = Date.now() - started;

  assert.equal(plan.playable, true);
  assert.equal(plan.renditions.length, 5, "the fast host offered all five renditions");
  assert.ok(
    elapsed < 1500,
    `cold start took ${elapsed} ms with one wedged mirror — the probe is still waiting for the slowest host`
  );
});

test("a slow rendition does not delay the start, and still joins the ladder", async () => {
  // The player needs one playable rendition to start; the rest is a quality
  // menu. Waiting for the whole menu set the latency of the lecture — production
  // measured 2371 ms of probe, all of it "some rendition has not replied yet".
  // Late answers must still reach the ladder, or the speed-up quietly costs
  // students their quality choice.
  resetToken();
  forgetSignerToken();
  process.env.PW_TOKEN = "";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (/generate_token/.test(url)) return new Response(JSON.stringify({ token: MINTED }), { status: 200 });
    if (/240\/main/.test(url)) {
      await new Promise((r) => setTimeout(r, 2500));
      return new Response(MASTER, { status: 200 });
    }
    return new Response(MASTER, { status: 200 });
  };

  const { probeRenditions } = await import("../lib/api-data.mjs");
  const started = Date.now();
  const probe = await probeRenditions({ folder: "99999999-1111-2222-3333-444444444444", fresh: true });
  const elapsed = Date.now() - started;

  assert.equal(probe.renditions.length, 4, "the fast renditions should be usable immediately");
  assert.ok(elapsed < 1200, `the start waited ${elapsed} ms for one slow rendition`);
  // Best first, and the slow one (240) is the one missing.
  assert.equal(probe.renditions.map((r) => r.quality).join(","), "1080,720,480,360");

  // The slow one lands later, and lands in the cache rather than being lost.
  const widened = await probe.renditions.settled;
  assert.equal(widened.length, 5, "the slow rendition never joined the ladder");
});
