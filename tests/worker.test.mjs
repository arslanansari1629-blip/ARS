/**
 * Our own signer Worker (worker/signer-worker.js), exercised in-process.
 *
 * The Worker is the answer to "the free relays went down together": it
 * must mint a guest token, present it to PW's official API (header *and*
 * `authorization` query), pass the bytes through, and survive a refusal
 * by re-minting once — all without any third-party relay being alive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const { handle } = await import("../worker/signer-worker.js");

const FOLDER = "4c80f597-a1f3-45a1-9793-010f36f5af07";
const PLAYLIST = "#EXTM3U\n#EXTINF:4.0,\n360/000.ts\n";

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function req(path) {
  return new Request(`https://ars-signer.example.workers.dev${path}`);
}

test("worker signs a playlist via PW's official API with the minted token", async () => {
  const seen = [];
  const res = await withFetch(
    async (url, opts = {}) => {
      const u = new URL(String(url));
      if (u.href.includes("generate_token")) {
        return Response.json({ access_token: "minted-guest-token-123456" });
      }
      if (u.hostname.includes("penpencil")) {
        seen.push({ host: u.hostname, query: u.searchParams, headers: opts.headers || {} });
        return new Response(PLAYLIST, {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      throw new Error(`unexpected fetch ${u.href}`);
    },
    () => handle(req(`/api/v1/videos/get-hls-key?videoKey=${FOLDER}&key=360/main.m3u8`), {})
  );

  assert.equal(res.status, 200);
  assert.equal(await res.text(), PLAYLIST);
  assert.equal(res.headers.get("x-ars-signer"), "own-worker");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].query.get("authorization"), "minted-guest-token-123456");
  assert.match(String(seen[0].headers.authorization || ""), /^Bearer minted-guest-token-123456$/);
});

test("worker re-mints once when the official API refuses the first token", async () => {
  let mints = 0;
  let asks = 0;
  const res = await withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.href.includes("generate_token")) {
        mints += 1;
        return Response.json({ access_token: `minted-token-${mints}-abcdefghij` });
      }
      if (u.hostname.includes("penpencil")) {
        asks += 1;
        if (asks === 1) return new Response("Unauthorised", { status: 401 });
        return new Response(PLAYLIST, { status: 200 });
      }
      throw new Error(`unexpected fetch ${u.href}`);
    },
    () => handle(req(`/?videoKey=${FOLDER}&key=360/main.m3u8`), {})
  );

  assert.equal(res.status, 200);
  assert.ok(mints >= 1, "a 401 must trigger a fresh mint");
  assert.ok(asks >= 2, "the same upstream is retried with the fresh token");
});

test("worker health reports the token source without leaking the token", async () => {
  const res = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return Response.json({ access_token: "minted-guest-token-123456" });
      }
      throw new Error("health must not sign anything");
    },
    () => handle(req("/health"), {})
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.tokenSource, /vidcloud/);
  assert.ok(!JSON.stringify(body).includes("minted-guest-token"), "health must not expose the token");
});

test("worker requires videoKey and key", async () => {
  const res = await handle(req("/api/v1/videos/get-hls-key"), {});
  assert.equal(res.status, 400);
});
