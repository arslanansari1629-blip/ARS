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
  // An absolute URL that already carries a CloudFront signature is proxied
  // as-is (`direct=`): the signature is the credential, no signer can mint
  // the segment, and re-asking one per segment is what burned the relays'
  // quotas. It must never be reduced to a bare key and re-sent for signing.
  assert.match(body, /api\/sign\?direct=https%3A%2F%2Fsec1\.pw\.live/, "signed absolute URLs must be proxied directly");
  assert.ok(!body.includes("get-hls-key"), "the signer endpoint must not leak into a rewritten playlist");
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

test("/api/sign recovers the real AES key path from a relay-rewritten key URI", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();

  // A signing relay may already rewrite URI="..." to its own endpoint; the real
  // key path then lives in the `key` query parameter, not in the URL path.
  const playlist = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="/api/v1/videos/get-hls-key?videoKey=x&key=720/enc.key",IV=0x0000',
    "#EXTINF:10.0,",
    "720/000.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");

  await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        return new Response(playlist, {
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
  assert.match(res.body, /key=720%2Fenc\.key/, "AES key must stay 720/enc.key");
  assert.ok(!res.body.includes("get-hls-key"), "relay endpoint must not leak into the key path");
});

test("/api/sign streams a media segment through as opaque bytes", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();

  // 0x47 is the MPEG-TS sync byte — a segment must never be decoded as text.
  const segment = Buffer.from([0x47, 0x40, 0x11, 0x10, 0x00, 0x42, 0xf0, 0x25, 0x00, 0xff]);

  await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        return new Response(segment, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?videoKey=${FOLDER}&key=720%2F000.ts`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.equal(res.statusCode, 200);
  const out = Buffer.concat(res.chunks);
  assert.equal(out[0], 0x47, "the MPEG-TS sync byte must survive the relay");
  assert.equal(out.length, segment.length, "segment bytes must not be altered");
  // Segments are immutable per videoKey+key and identical for every viewer:
  // a day of edge cache is what makes the next student's segment a CDN hit.
  assert.match(res.headers["cache-control"], /max-age=86400/);
  assert.match(res.headers["cache-control"], /immutable/);
});

test("/api/sign fetches a fresh token when a segment fails with 401", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();
  const tokens = [];
  let calls = 0;

  await withFetch(
    async (url, opts = {}) => {
      if (String(url).includes("generate_token")) {
        return new Response(`guest-token-value-${Math.random().toString(16).slice(2, 8)}`, {
          status: 200,
        });
      }
      if (String(url).includes("get-hls-key")) {
        calls += 1;
        tokens.push((opts.headers || {}).token);
        // first attempt: expired token — the relay must retry with a new one
        if (calls === 1) return new Response("expired", { status: 401 });
        return new Response(Buffer.from([0x47, 0x40, 0x11]), {
          status: 200,
          headers: { "content-type": "video/mp2t" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?videoKey=${FOLDER}&key=enc.key`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.equal(res.statusCode, 200, "an expired token must not fail the segment");
  assert.ok(calls >= 2, "the relay should retry after a 401");
});

test("/api/sign fetches a fresh token when a segment fails with 403", async () => {
  // A stale guest token can draw 403 from every signer host at once; carrying
  // that same credential down the whole ladder turned a working playlist
  // into a 502. One re-mint, one retry — the same medicine as 401.
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();
  let calls = 0;

  await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response(`guest-token-value-${Math.random().toString(16).slice(2, 8)}`, {
          status: 200,
        });
      }
      if (String(url).includes("get-hls-key")) {
        calls += 1;
        if (calls === 1) return new Response("stale token", { status: 403 });
        return new Response(Buffer.from([0x47, 0x40, 0x11]), {
          status: 200,
          headers: { "content-type": "video/mp2t" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?videoKey=${FOLDER}&key=720/000.ts`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.equal(res.statusCode, 200, "a stale-token 403 must not fail the segment");
  assert.ok(calls >= 2, "the relay should retry after a 403 with a fresh token");
});

test("/api/sign falls back to PW's official API with the anonymous credential when the relays refuse", async () => {
  // The partner relays are third-party workers with their own quotas:
  // vidcloud has answered Cloudflare 1027 (owner plan limit) while
  // streamvideo 500'd and studyspark whitelisted itself — every relay 403
  // at once, and a single-token relay reported a dead lecture. PW's own
  // API honours the long-lived anonymous credential (as the `authorization`
  // query parameter), so the ladder must reach it.
  const { default: handler } = await import("../api/sign.mjs");
  const { FALLBACK_TOKEN } = await import("../lib/pw-auth.mjs");
  const res = fakeRes();

  await withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.href.includes("generate_token")) {
        return new Response("relay-mint-token-123456", { status: 200 });
      }
      if (u.href.includes("get-hls-key")) {
        if (u.hostname.includes("penpencil")) {
          return u.searchParams.get("authorization") === FALLBACK_TOKEN
            ? new Response(PLAYER_PLAYLIST, {
                status: 200,
                headers: { "content-type": "application/vnd.apple.mpegurl" },
              })
            : new Response("Unauthorised", { status: 401 });
        }
        return new Response("Access Denied", { status: 403 });
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

  assert.equal(res.statusCode, 200, "the official API + anonymous credential must rescue playback");
  assert.match(res.body, /#EXTM3U/);
});

test("/api/sign proxies an already-signed media URL without the signer", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();
  const segment = Buffer.from([0x47, 0x40, 0x11, 0x10, 0x00, 0x42]);
  const signedUrl =
    "https://sec1.pw.live/hls/" + FOLDER + "/720/001.ts?Signature=abc&Key-Pair-Id=K1&Expires=999";

  await withFetch(
    async (url) => {
      if (String(url) === signedUrl) {
        return new Response(segment, {
          status: 200,
          headers: { "content-type": "video/mp2t", "content-length": String(segment.length) },
        });
      }
      throw new Error(`direct mode must not call the signer, got ${url}`);
    },
    () =>
      handler(
        {
          method: "GET",
          url: `/api/sign?direct=${encodeURIComponent(signedUrl)}`,
          headers: { host: "example.test", "x-forwarded-proto": "https" },
        },
        res
      )
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Buffer.concat(res.chunks), segment);
  assert.match(res.headers["cache-control"], /immutable/);
});

test("/api/sign refuses a direct URL that is not PW media infrastructure", async () => {
  const { default: handler } = await import("../api/sign.mjs");
  const res = fakeRes();
  await handler(
    {
      method: "GET",
      url: `/api/sign?direct=${encodeURIComponent("https://evil.example.com/steal.ts")}`,
      headers: { host: "example.test", "x-forwarded-proto": "https" },
    },
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).success, false);
});
