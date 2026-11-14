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
