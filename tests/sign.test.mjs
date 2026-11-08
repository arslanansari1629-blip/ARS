/**
 * Regression tests for the HLS signing relay (/api/sign).
 *
 * Two bugs are covered:
 *  1. the relay must send the anonymous guest token — the signer hosts reject
 *     unauthenticated requests with 401;
 *  2. a playlist returned as `application/vnd.apple.mpegurl` must still be read
 *     as text and rewritten, not streamed through raw (which broke every
 *     relative variant / segment / key reference in the browser).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const FOLDER = "e76c2cf2-413b-4f14-a7b5-8ebeb6c60523";

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    write(b) {
      this.chunks.push(Buffer.from(b));
    },
    end(b) {
      if (b) this.chunks.push(Buffer.from(b));
      this.body = Buffer.concat(this.chunks).toString("utf8");
    },
  };
  return res;
}

/** Install a fetch stub for the duration of one call. */
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const PLAYER_PLAYLIST = [
  "#EXTM3U",
  '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
  "#EXTINF:6.0,",
  "720/000.ts",
  "#EXTINF:6.0,",
  "https://sec1.pw.live/hls/" + FOLDER + "/720/001.ts?Signature=s&Key-Pair-Id=k",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

test("/api/sign sends the guest token to the signer", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const seen = [];

  const res = fakeRes();
  await withFetch(
    async (url, opts = {}) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        seen.push(opts.headers || {});
        return new Response(PLAYER_PLAYLIST, {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?videoKey=${FOLDER}&key=720/main.m3u8`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.ok(seen.length >= 1, "signer was never called");
  const auth = String(seen[0].Authorization || seen[0].authorization || "");
  assert.match(auth, /^Bearer \S+$/, "signer must receive a bearer token");
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /mpegurl/);
});

test("/api/sign rewrites every playlist child reference through itself", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();

  await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        return new Response(PLAYER_PLAYLIST, {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?videoKey=${FOLDER}&key=720/main.m3u8`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.equal(res.statusCode, 200);
  const body = res.body;

  // no bare relative references may survive
  for (const line of body.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#EXT")) continue;
    if (raw.startsWith("#")) continue;
    assert.match(raw, /^https:\/\/example\.test\/api\/sign\?/, `unrewritten line: ${raw}`);
  }

  // the AES key and both segments are relayed with the right key paths
  assert.match(body, /URI="https:\/\/example\.test\/api\/sign\?videoKey=[^"]*&key=720%2Fenc\.key"/);
  assert.match(body, /key=720%2F000\.ts/);
  assert.match(body, /key=720%2F001\.ts/, "absolute upstream URLs must be reduced to rendition/file");

  // and the signature must never be re-sent to the signer
  assert.ok(!body.includes("Signature=s"), "signed query params should be stripped");
});

test("/api/sign reports a clear error when every signer rejects", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();

  await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      return new Response(JSON.stringify({ success: false, error: "Access Denied" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?videoKey=${FOLDER}&key=720/main.m3u8`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.equal(res.statusCode, 502);
  const payload = JSON.parse(res.body);
  assert.equal(payload.success, false);
  assert.match(payload.error, /signing service/i);
});

test("/api/sign requires a videoKey", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();
  await handler(
    { method: "GET", url: "/api/sign", headers: { host: "example.test" } },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).success, false);
});
