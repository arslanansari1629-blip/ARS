/**
 * Offline-download tests.
 *
 * The downloader's promise is narrow and testable: hand back a file that still
 * plays when nothing is reachable. That rules out any answer which points at a
 * signed URL, and it makes three properties non-negotiable — the key travels
 * inside the file, a slice is complete on its own, and a failure says which
 * segment broke instead of shipping noise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  assembleSlice,
  parsePlaylist,
  decryptFragment,
  safeName,
  qualityLabel,
  renditionsOf,
  sliceName,
  keyOf,
  MAX_BYTES,
} from "../lib/download.mjs";

const KEY = Buffer.from("0123456789abcdef", "utf8");

function mediaPlaylist({ segments = 3, key = true, withMap = false } = {}) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4"];
  if (key) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="/api/sign?videoKey=f&key=enc.key"');
  if (withMap) lines.push('#EXT-X-MAP:URI="/api/sign?videoKey=f&key=240%2Finit.mp4"');
  for (let i = 0; i < segments; i += 1) {
    lines.push("#EXTINF:4.000,");
    lines.push(`/api/sign?videoKey=f&key=240%2F${String(i).padStart(3, "0")}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/** A fake network: paths are normalised back to their `key=` value. */
function fakeNet({
  segments = 3,
  key = true,
  map = false,
  failOn = "",
  flakyOn = "",
  fails = 0,
  encrypted = false,
  keyBytes = KEY,
} = {}) {
  const playlist = mediaPlaylist({ segments, key, withMap: map });
  const requested = [];
  const seen = new Map();

  const get = async (url) => {
    const full = new URL(url, "https://site.test");
    const at = full.pathname + full.search;
    requested.push(at);
    if (failOn && at.includes(failOn)) {
      return { ok: false, status: 403, arrayBuffer: async () => Buffer.alloc(0) };
    }
    // Answers 403 the first `fails` times, then serves — the burst pattern the
    // real signer shows, and what the retry in `assembleSlice` exists for.
    if (flakyOn && at.includes(flakyOn)) {
      const hits = seen.get(at) || 0;
      seen.set(at, hits + 1);
      if (hits < fails) {
        return { ok: false, status: 403, arrayBuffer: async () => Buffer.alloc(0) };
      }
    }
    if (full.pathname === "/playlist") {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(playlist) };
    }
    const keyParam = full.searchParams.get("key") || "";
    if (keyParam.endsWith("enc.key")) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(keyBytes) };
    }
    if (keyParam.endsWith("init.mp4")) {
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(40, 9) };
    }
    const index = Number((keyParam.match(/(\d{3})\.ts$/) || [])[1] || 0);
    const plain = Buffer.alloc(376, index + 1);
    if (encrypted) {
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(index, 12);
      const cipher = crypto.createCipheriv("aes-128-cbc", keyBytes, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return { ok: true, status: 200, arrayBuffer: async () => body };
    }
    return { ok: true, status: 200, arrayBuffer: async () => plain };
  };

  return { get, requested, playlist };
}

const PLAYLIST = "https://site.test/playlist";

/* ------------------------------ reading a list ---------------------------- */

test("a playlist is read into segments, the key and the init map", () => {
  const parsed = parsePlaylist(mediaPlaylist({ segments: 4, withMap: true }), PLAYLIST);
  assert.equal(parsed.segments.length, 4);
  assert.equal(parsed.keys.length, 1);
  assert.equal(parsed.maps.length, 1);
  assert.equal(parsed.duration, 16);
  assert.equal(parsed.segments[0].duration, 4);
  // Children are resolved against the playlist's own URL, never left relative.
  assert.match(parsed.segments[0].url, /^https:\/\/site\.test\/api\/sign\?/);
});

test("a playlist with an unknown key method is not treated as encrypted", () => {
  const text = mediaPlaylist({ segments: 2 }).replace("METHOD=AES-128", "METHOD=SAMPLE-AES");
  const parsed = parsePlaylist(text, PLAYLIST);
  assert.equal(parsed.keys.length, 0, "an unsupported method must not be replayed as AES-128");
  assert.equal(parsed.segments.length, 2);
});

test("an IV named by the playlist is carried through", () => {
  const text = mediaPlaylist({ segments: 1 }).replace("URI=\"/api/sign?videoKey=f&key=enc.key\"", 'URI="/api/sign?videoKey=f&key=enc.key",IV=0x00000000000000000000000000000007');
  const parsed = parsePlaylist(text, PLAYLIST);
  assert.equal(parsed.keys[0].iv.toLowerCase(), "00000000000000000000000000000007");
});

/* ------------------------------ assembling -------------------------------- */

test("a slice is self-contained: key and segments are inline, nothing points outward", async () => {
  const net = fakeNet({ segments: 3 });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get: net.get });

  assert.equal(built.ok, true);
  assert.equal(built.format, "playlist");
  assert.match(built.body, /URI="data:application\/octet-stream;base64,[A-Za-z0-9+/=]+"/);
  assert.equal((built.body.match(/data:video\/MP2T;base64,/g) || []).length, 3);
  assert.match(built.body, /#EXT-X-ENDLIST/);
  // The whole point: no line of the saved file needs this site to answer.
  assert.equal(/https?:\/\//.test(built.body), false, "the file still points at a URL");
});

test("a slice covers exactly the requested window, and says what comes next", async () => {
  const net = fakeNet({ segments: 10 });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, offset: 4, limit: 3, get: net.get });

  assert.equal(built.ok, true);
  assert.equal(built.start, 4);
  assert.equal(built.next, 7);
  assert.equal(built.total, 10);
  assert.equal(built.segments, 3);
  assert.equal(built.done, false);
  assert.equal(built.startSeconds, 16, "the slice knows where it sits in the lecture");
});

test("the last slice reports itself finished", async () => {
  const net = fakeNet({ segments: 5 });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, offset: 3, limit: 48, get: net.get });
  assert.equal(built.done, true);
  assert.equal(built.segments, 2);
  assert.equal(built.next, 5);
});

test("an offset past the end reads from the last segment instead of failing", async () => {
  const net = fakeNet({ segments: 3 });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, offset: 99, get: net.get });
  assert.equal(built.ok, true);
  assert.equal(built.start, 2);
  assert.equal(built.segments, 1);
  assert.equal(built.done, true);
});

test("an unreachable key fails the slice rather than shipping undecryptable media", async () => {
  const net = fakeNet({ failOn: "enc.key" });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get: net.get });
  assert.equal(built.ok, false);
  assert.match(built.error, /key answered 403/);
});

test("a key of the wrong length is refused", async () => {
  const net = fakeNet({ keyBytes: Buffer.from("too-short") });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get: net.get });
  assert.equal(built.ok, false);
  assert.match(built.error, /not 16/);
});

test("one unreachable segment does not sink the whole slice", async () => {
  // This used to fail the entire slice, which is why a two-hour download died
  // on a single 403 out of five hundred segments. The slice keeps what came
  // back, in order, and says how many were lost so the page can be honest.
  const net = fakeNet({ failOn: "000.ts" });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get: net.get });
  assert.equal(built.ok, true, "one bad segment should not discard the rest");
  assert.equal(built.skipped, 1);
  assert.ok(built.segments >= 1, "the segments that answered should be kept");
});

test("a slice whose media all fails still fails, naming the status", async () => {
  const net = fakeNet({ failOn: ".ts" });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get: net.get });
  assert.equal(built.ok, false);
  assert.match(built.error, /segment answered 403/);
});

test("a transient refusal is retried before an asset is called missing", async () => {
  // The signer answers 403 in bursts and clears on the next ask; a slice that
  // gives up on the first one is the production bug this guards.
  const net = fakeNet({ flakyOn: "000.ts", fails: 1 });
  const built = await assembleSlice({
    playlistUrl: PLAYLIST,
    get: net.get,
    retry: { attempts: 3 },
  });
  assert.equal(built.ok, true);
  assert.equal(built.skipped || 0, 0, "the retry should have recovered the segment");
});

test("a byte ceiling stops the slice early but keeps what fit", async () => {
  const net = fakeNet({ segments: 5 });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, maxBytes: 700, get: net.get });
  assert.equal(built.ok, true);
  assert.ok(built.segments < 5, "the ceiling was ignored");
  assert.ok(built.segments >= 1);
  assert.equal(built.done, false, "a truncated slice must not claim to be finished");
});

test("the default ceiling is well under a function's response limit", () => {
  assert.ok(MAX_BYTES > 16 * 1024 * 1024, "too small to be useful");
  assert.ok(MAX_BYTES <= 80 * 1024 * 1024, "too large for one serverless response");
});

test("a non-playlist body is rejected instead of saved", async () => {
  const get = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from("<html>nope</html>") });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get });
  assert.equal(built.ok, false);
  assert.match(built.error, /not a media playlist/);
});

test("an empty playlist is reported, not assembled into an empty file", async () => {
  const get = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\n#EXT-X-ENDLIST\n"),
  });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, get });
  assert.equal(built.ok, false);
  assert.match(built.error, /no segment/);
});

/* ------------------------------ plain format ------------------------------ */

test("a plain slice is decrypted MPEG-TS, continuous across the window", async () => {
  const net = fakeNet({ segments: 4, encrypted: true });
  const built = await assembleSlice({ playlistUrl: PLAYLIST, format: "plain", get: net.get });

  assert.equal(built.ok, true);
  assert.equal(built.format, "plain");
  assert.equal(Buffer.isBuffer(built.body), true);
  assert.equal(built.segments, 4);
  // Four 376-byte segments, each decrypted to a different filler byte.
  assert.equal(built.body.length, 4 * 376);
  const first = built.body.subarray(0, 376);
  assert.equal(first.equals(Buffer.alloc(376, 1)), true, "the first segment did not decrypt");
  const second = built.body.subarray(376, 752);
  assert.equal(second.equals(Buffer.alloc(376, 2)), true, "the IV did not advance with the sequence");
});

test("decryption uses the sequence number as the IV", () => {
  const ciphers = [0, 1, 7].map((seq) => {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(seq, 12);
    const c = crypto.createCipheriv("aes-128-cbc", KEY, iv);
    return Buffer.concat([c.update(Buffer.alloc(32, seq)), c.final()]);
  });
  for (const [i, seq] of [0, 1, 7].entries()) {
    const out = decryptFragment(ciphers[i], KEY, seq);
    assert.equal(out.equals(Buffer.alloc(32, seq)), true, `sequence ${seq} decrypted wrong`);
  }
});

/* --------------------------------- names ---------------------------------- */

test("filenames are safe on every filesystem", () => {
  assert.equal(safeName('Unit 3: "Vectors" / cross?product*'), "Unit 3 Vectors cross product");
  assert.equal(safeName(""), "lecture");
  assert.equal(safeName(null, "fallback"), "fallback");
  assert.ok(safeName("x".repeat(400)).length <= 90);
});

test("a slice name says its quality and whether it is a part", () => {
  assert.equal(sliceName("Rotational Motion", "720", 0, 48, true), "Rotational Motion 720p.m3u8");
  assert.equal(sliceName("Rotational Motion", "240", 96, 48, false), "Rotational Motion 240p part 3.m3u8");
  assert.equal(
    sliceName("Rotational Motion", "240", 0, 48, false, "plain"),
    "Rotational Motion 240p part 1.ts"
  );
});

test("quality labels and ladders read the way people say them", () => {
  assert.equal(qualityLabel("720"), "720p");
  assert.equal(qualityLabel(240), "240p");
  assert.deepEqual(renditionsOf({ renditions: ["360", "720", "480"] }), ["720", "480", "360"]);
  assert.deepEqual(renditionsOf({}), []);
  assert.deepEqual(renditionsOf({ renditions: ["auto", ""] }), []);
});

test("the key of a relay URL is what the signer is asked for", () => {
  assert.equal(keyOf("https://x/api/sign?videoKey=f&key=240%2F000.ts"), "240/000.ts");
  assert.equal(keyOf(""), "");
});

test("a bare key is passed through, not rewritten", () => {
  // The signer names the AES key `enc.key` with no rendition in front of it.
  // Prefixing the quality — which this did — asks for `240/enc.key` and earns a
  // 403, which is exactly how the first live download failed after the playlist
  // itself was reading fine.
  assert.equal(keyOf("enc.key"), "enc.key");
  assert.equal(keyOf("https://x/api/sign?videoKey=f&key=enc.key"), "enc.key");
  // Anything that is not a key still has no key of its own.
  assert.equal(keyOf("not a url"), "");
});
