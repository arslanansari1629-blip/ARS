/**
 * Player-engine tests.
 *
 * These cover the two failure modes that were reported from the live site:
 *
 *   1. stop the video, press play, and it never plays again
 *   2. skip ±10 s and playback starts lagging
 *
 * Both are behaviour, not markup, so they are tested against the engine with a
 * stub media element rather than through a rendered page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ProPlayer, fmtTime } from "../public/assets/player.js";

/** A minimal stand-in for an HTMLVideoElement with real event dispatch. */
function stubVideo({ duration = 600, currentTime = 0, src = "" } = {}) {
  const listeners = new Map();
  const video = {
    duration,
    currentTime,
    paused: true,
    muted: false,
    volume: 1,
    playbackRate: 1,
    readyState: 1,
    buffered: { length: 0 },
    error: null,
    canPlayType: () => "",
    _src: src,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    play() {
      this.paused = false;
      this.dispatch("playing");
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.dispatch("pause");
    },
    load() {},
    getAttribute(name) {
      return name === "src" ? this._src || null : null;
    },
    removeAttribute(name) {
      if (name === "src") this._src = "";
    },
  };
  Object.defineProperty(video, "src", {
    get() {
      return this._src;
    },
    set(value) {
      this._src = value;
    },
  });
  Object.defineProperty(video, "currentSrc", {
    get() {
      return this._src;
    },
  });
  return video;
}

function makeEngine(video, resolve) {
  const states = [];
  const prefs = { get: () => ({}), set: () => {} };
  const player = new ProPlayer({
    video,
    resolve,
    prefs,
    onState: (s) => states.push(s),
    onError: () => {},
    onEnded: () => {},
  });
  return { player, states };
}

test("a stopped video starts again", async () => {
  const video = stubVideo({ src: "/api/media?url=abc" });
  const { player, states } = makeEngine(video, async () => {
    throw new Error("a stopped player must not need a new plan");
  });

  await player.play();
  assert.equal(video.paused, false);

  player.stop();
  assert.equal(video.paused, true);
  assert.equal(states.at(-1).stopped, true, "stop must be reported as a state");

  // This is the reported bug: play after stop did nothing.
  await player.play();
  assert.equal(video.paused, false, "play after stop must resume playback");
  assert.equal(states.at(-1).stopped === true, false);
});

test("skipping does not re-resolve the stream", async () => {
  const video = stubVideo({ duration: 600, currentTime: 100, src: "/api/media?url=abc" });
  let resolves = 0;
  const { player } = makeEngine(video, async () => {
    resolves += 1;
    return { playable: true, kind: "mp4", url: "/api/media?url=next" };
  });

  player.seekBy(10);
  assert.equal(video.currentTime, 110);
  player.seek(300);
  assert.equal(video.currentTime, 300);
  assert.equal(resolves, 0, "a seek must never fetch a new plan");

  // clamped inside the clip
  player.seek(10_000);
  assert.equal(video.currentTime, 599.7);
  player.seek(-50);
  assert.equal(video.currentTime, 0);
});

test("repeated taps on skip land once, so playback does not lag", async () => {
  const video = stubVideo({ duration: 600, currentTime: 100, src: "/api/media?url=abc" });
  const { player } = makeEngine(video, async () => ({ playable: true }));

  // Six taps in one burst: the first moves the playhead, the rest are coalesced
  // instead of queueing a fragment fetch each.
  const moved = [0, 1, 2, 3, 4, 5].map(() => player.seekBy(10));
  assert.equal(moved.filter(Boolean).length, 1);
  assert.equal(video.currentTime, 110);
});

test("a seek before metadata is remembered, not dropped", () => {
  const video = stubVideo({ duration: NaN, currentTime: 0, src: "/api/media?url=abc" });
  const { player } = makeEngine(video, async () => ({ playable: true }));

  player.seek(240);
  assert.equal(video.currentTime, 0, "no duration yet, so no seek");

  video.duration = 600;
  video.dispatch("loadedmetadata");
  assert.equal(video.currentTime, 240, "the pending seek is applied on metadata");
});

test("restart after a torn-down source resolves a fresh plan and resumes", async () => {
  const video = stubVideo({ duration: 600, currentTime: 0, src: "" });
  const attempts = [];
  const { player } = makeEngine(video, async (n) => {
    attempts.push(n);
    return { playable: true, kind: "mp4", url: "/api/media?url=fresh", playableAt: Date.now() };
  });

  video.currentTime = 321;
  await player.restart();

  assert.deepEqual(attempts, [1], "the retry bumps the attempt counter");
  assert.equal(video.src, "/api/media?url=fresh", "a fresh plan is attached");
  assert.equal(video.currentTime, 321, "the position survives the restart");
});

test("fmtTime renders hours, minutes and pads seconds", () => {
  assert.equal(fmtTime(0), "0:00");
  assert.equal(fmtTime(9.9), "0:09");
  assert.equal(fmtTime(75), "1:15");
  assert.equal(fmtTime(3661), "1:01:01");
  assert.equal(fmtTime(NaN), "0:00");
  assert.equal(fmtTime(-4), "0:00");
});
