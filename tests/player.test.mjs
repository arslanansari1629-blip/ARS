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
import { ProPlayer, fmtTime, folderOf } from "../public/assets/player.js";

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

test("a seek clears the stall watchdog so the two cannot fight", () => {
  const video = stubVideo({ duration: 600, currentTime: 40, src: "/api/media?url=abc" });
  const { player } = makeEngine(video, async () => ({ playable: true }));

  // A stall has raised the recovery counter; seeking is itself the fix, so it
  // must not count against the budget or leave a watchdog about to fire.
  player.recovery = 3;
  player.seek(300);
  assert.equal(video.currentTime, 300);
  assert.equal(player.recovery, 2, "a seek should refund one recovery attempt");
});

test("prewarm never calls load() on a paused element", () => {
  // load() would discard the buffer the pause exists to keep; only the preload
  // hint may change.
  let loaded = 0;
  const video = stubVideo({ duration: 600, currentTime: 10, src: "/api/media?url=abc" });
  video.load = () => {
    loaded += 1;
  };
  const { player } = makeEngine(video, async () => ({ playable: true }));
  player._prewarm();
  assert.equal(loaded, 0, "prewarm must not reload the media element");
  assert.equal(video.preload, "auto");
});

/* ------------------------- never-fail-the-link --------------------------- */

/**
 * The reported complaint is "the link falls": a signed URL expires mid-lecture
 * and the student is left with a dead player. These tests pin the promise that a
 * failure turns into *another attempt* first, and that the site is told which
 * folder died so the retry is handed a different plan instead of the same one.
 */

/** Capture the repair beacons the player fires, and settle immediately. */
function setNavigator(value) {
  // `navigator` is a getter on newer Node globals, so it is redefined rather
  // than assigned; the descriptor is restored afterwards.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  };
}

function withBeacons(fn) {
  const sent = [];
  const restore = setNavigator({
    sendBeacon: (url) => {
      sent.push(url);
      return true;
    },
  });
  return Promise.resolve(fn(sent)).finally(restore);
}

test("a dead manifest is reported before the retry, with the folder", async () => {
  await withBeacons(async (sent) => {
    const video = stubVideo({ duration: 600, src: "" });
    const { player } = makeEngine(video, async () => ({
      playable: true,
      kind: "mp4",
      url: "/api/sign?videoKey=folder-xyz&key=master.m3u8",
    }));

    player.plan = { playable: true, kind: "hls", url: "/api/sign?videoKey=folder-xyz&key=master.m3u8" };
    await player.retry({ reason: "The signed stream link expired." });

    assert.equal(sent.length, 1, "exactly one beacon per retry");
    assert.match(sent[0], /^\/api\/repair\?/);
    assert.match(sent[0], /folder=folder-xyz/);
    assert.match(sent[0], /kind=manifest/);
  });
});

test("the beacon never throws, even with no folder and no fetch", () => {
  const restore = setNavigator({});
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("offline");
  };
  try {
    const video = stubVideo({ duration: 600, src: "" });
    const { player } = makeEngine(video, async () => ({ playable: true }));
    player.plan = { url: "" };
    assert.doesNotThrow(() => player._report("stall", 12));
  } finally {
    restore();
    globalThis.fetch = previousFetch;
  }
});

test("a resolver outage falls back to the last known good plan", async () => {
  const video = stubVideo({ duration: 600, currentTime: 42, src: "" });
  const good = "/api/media?url=last-good";
  const { player } = makeEngine(video, async () => {
    throw new Error("the resolver is down");
  });
  // The plan that was already playing is still the best thing available: dead-
  // ending the page would be strictly worse than re-attaching it.
  player.plan = { playable: true, kind: "mp4", url: good };
  player.video.currentTime = 42;

  await player.retry({ reason: "network" });
  assert.equal(video.src, good, "the last known plan is re-attached");
  assert.equal(player.error, undefined, "no dead end was reported");
});

test("after the fourth failed resolve the player stops looping", async () => {
  const video = stubVideo({ duration: 600, src: "" });
  let resolves = 0;
  const { player, states } = makeEngine(video, async () => {
    resolves += 1;
    return { playable: false, reason: "nothing published" };
  });
  player._backoff = () => 0;
  player.plan = { playable: true, kind: "mp4", url: "/api/media?url=old" };
  player.attempt = 4;

  await player.retry({ reason: "exhausted" });
  assert.equal(resolves, 1);
  assert.ok(
    states.some((s) => s.error),
    "the student is finally told, instead of a spinner forever"
  );
});

test("the first retry does not make the student wait", () => {
  const { player } = makeEngine(stubVideo({ duration: 600, src: "" }), async () => ({ playable: true }));
  assert.equal(player._backoff(1), 0, "an expired signature fixes itself instantly");
  assert.ok(player._backoff(2) > 0, "later attempts back off");
  assert.equal(player._backoff(30), 9000, "the wait is capped");
});

test("folderOf reads the folder out of a relay URL", () => {
  assert.equal(folderOf("/api/sign?videoKey=abc-123&key=master.m3u8"), "abc-123");
  assert.equal(folderOf("/api/hls?folder=f-9&asset=master.mpd"), "f-9");
  assert.equal(folderOf("/api/media?url=https%3A%2F%2Fx%2Fy.mp4"), "");
  assert.equal(folderOf(""), "");
  assert.equal(folderOf(null), "");
});
