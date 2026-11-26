/**
 * Our own signer, on Cloudflare, leads the ladder.
 *
 * The Vercel lane died behind a 402 fair-use wall and the partner
 * relays are strangers' quotas — so the lead lane is now a signer
 * that runs inside the site's own Cloudflare Worker and talks to
 * PW's official API directly. These tests pin that contract: the
 * official hosts are asked first, a 402 walks to the next official
 * host, and no third-party relay is touched on the happy path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

function stubFetch(handler) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("generate_token")) return new Response("guest-token-value-123456");
    return handler(u, opts);
  };
  return { asked, restore: () => { globalThis.fetch = original; } };
}

test("askOwnSigner asks PW's official API first and streams the answer", async () => {
  const { askOwnSigner, OWN_SIGNER_HOST, isOwnSigner } = await import("../lib/own-signer.mjs");
  assert.ok(isOwnSigner(OWN_SIGNER_HOST));
  const { asked, restore } = stubFetch((u) => {
    if (u.includes("api.penpencil.xyz")) {
      return new Response("#EXTM3U\n#EXT-X-ENDLIST\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const res = await askOwnSigner("folder-1", "720/main.m3u8", "");
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("#EXTM3U"));
  } finally {
    restore();
  }
  const signAsks = asked.filter((u) => u.includes("get-hls-key"));
  assert.equal(signAsks.length, 1, `expected exactly one signing ask, got ${signAsks.join(", ")}`);
  assert.ok(signAsks[0].startsWith("https://api.penpencil.xyz/"), signAsks[0]);
});

test("a 402 from the first official host walks to the second", async () => {
  const { askOwnSigner } = await import("../lib/own-signer.mjs");
  const { asked, restore } = stubFetch((u) => {
    if (u.includes("api.penpencil.xyz")) return new Response("quota", { status: 402 });
    if (u.includes("api.penpencil.co")) return new Response("#EXTM3U\n", { status: 200 });
    return new Response("nope", { status: 404 });
  });
  try {
    const res = await askOwnSigner("folder-2", "360/main.m3u8", "some-token-value");
    assert.equal(res.status, 200);
  } finally {
    restore();
  }
  const signAsks = asked.filter((u) => u.includes("get-hls-key"));
  assert.ok(signAsks[0].includes("api.penpencil.xyz"), signAsks[0]);
  assert.ok(signAsks.some((u) => u.includes("api.penpencil.co")), signAsks.join(", "));
});

test("a hung upstream cannot hold the ask past its deadline", async () => {
  // Three upstreams x three credentials x a long timeout was a
  // 72-second worst case hiding inside one probe ask. The deadline
  // caps the whole walk: one hung fetch spends it, nothing else is
  // asked, and the answer is an honest 502.
  const { askOwnSigner, forgetOwnSignerRefusals } = await import("../lib/own-signer.mjs");
  forgetOwnSignerRefusals();
  let asks = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("generate_token")) return new Response("guest-token-value-123456");
    asks += 1;
    await new Promise((r) => setTimeout(r, 300));
    throw new Error("hang");
  };
  try {
    const started = Date.now();
    const res = await askOwnSigner("folder-hang", "720/main.m3u8", "", { timeoutMs: 4000, deadlineMs: 120 });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 502);
    assert.equal(asks, 1, `the walk kept asking after the deadline (${asks} asks)`);
    assert.ok(elapsed < 500, `the ask took ${elapsed} ms against a 120 ms deadline`);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchSigned mints through the own Cloudflare lane before any relay", async () => {
  const { fetchSigned } = await import("../lib/sign.mjs");
  const { asked, restore } = stubFetch((u) => {
    if (u.includes("api.penpencil.xyz") || u.includes("api.penpencil.co")) {
      return new Response("#EXTM3U\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const got = await fetchSigned("folder-3", "720/main.m3u8", { attempts: 1 });
    assert.equal(got.ok, true);
    await got.response.text();
  } finally {
    restore();
  }
  const relayAsks = asked.filter(
    (u) => u.includes("get-hls-key") && (u.includes("vidcloud") || u.includes("studyspark") || u.includes("streamvideo") || u.includes("vercel"))
  );
  assert.deepEqual(relayAsks, [], `no relay should be asked on the happy path: ${relayAsks.join(", ")}`);
});
