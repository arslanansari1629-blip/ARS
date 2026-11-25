/**
 * With ARS_SIGNER_URL set, our own Worker leads the signer ladder.
 *
 * The env var is read when lib/sign.mjs loads, so it is set here, at the
 * top of a fresh test process, before the dynamic import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ARS_SIGNER_URL = "https://ars-signer.example.workers.dev";
process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

test("proxy signer templates expand inside the proxy's own parameter", async () => {
  const { signerFetchUrl, isProxySigner } = await import("../lib/sign.mjs");
  const tpl =
    "https://api.allorigins.win/raw?url=https%3A%2F%2Fvidcloud.eu.org%2Fapi%2Fv1%2Fvideos%2Fget-hls-key%3FvideoKey%3D{videoKey}%26key%3D{key}%26authorization%3D{auth}";
  assert.equal(isProxySigner(tpl), true);
  const url = signerFetchUrl(tpl, "folder 1", "720/main.m3u8", "tok en");
  assert.ok(url.startsWith("https://api.allorigins.win/raw?url="), url);
  assert.ok(url.includes("videoKey%3Dfolder%25201") || url.includes("videoKey%3Dfolder%201"), url);
  assert.ok(!url.includes("{videoKey}"), "placeholder left unexpanded");
  const plain = signerFetchUrl("https://vidcloud.eu.org/api/v1/videos/get-hls-key", "f", "360/main.m3u8", "t");
  assert.equal(plain, "https://vidcloud.eu.org/api/v1/videos/get-hls-key?videoKey=f&key=360%2Fmain.m3u8&authorization=t");
  assert.equal(isProxySigner(plain), false);
});

test("fetchSigned asks our own worker before any partner relay", async () => {
  const { fetchSigned } = await import("../lib/sign.mjs");
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("generate_token")) return new Response("guest-token-value-123456");
    if (u.includes("get-hls-key")) {
      asked.push(u);
      return new Response("#EXTM3U\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const got = await fetchSigned("folder-123", "360/main.m3u8");
    assert.equal(got.ok, true);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(asked.length >= 1, "no signer was asked");
  assert.ok(
    asked[0].startsWith("https://ars-signer.example.workers.dev/api/v1/videos/get-hls-key"),
    `our own worker must be asked first, got ${asked[0]}`
  );
});
