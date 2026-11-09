/**
 * Route-level tests for `/api/download`.
 *
 * The assembly logic is covered in `download.test.mjs`; this file drives the
 * actual handler, because the layer above it has its own ways to be wrong — a
 * status code that is not 200, an attachment header that never gets set, a
 * binary body written as text, a rewrite that never reaches the handler.
 *
 * The network is stubbed at `fetch`, so these run offline and are deterministic:
 * a signer that answers, a playlist with two segments, and a 16-byte key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const FOLDER = "11111111-2222-3333-4444-555555555555";
const KEY = Buffer.from("0123456789abcdef", "utf8");
/** One 188-byte MPEG-TS packet, per segment, with a printable sequence mark. */
const PACKET = 188;

/** Encrypt a segment the way the source does: AES-128-CBC, IV = sequence. */
function encryptSegment(sequence) {
  const plain = Buffer.alloc(PACKET, 0x47);
  plain[PACKET - 1] = sequence + 1;
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence, 12);
  const cipher = crypto.createCipheriv("aes-128-cbc", KEY, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** Every URL the handler asked for, so same-origin self-calls can be ruled out. */
const called = [];

/** A signer good enough for the resolver: every rendition answers, or one does. */
function signerStub({ rendition = "240" } = {}) {
  const keyed = (url) => {
    const parsed = new URL(String(url), "https://x");
    return parsed.searchParams.get("key") || "";
  };

  return async (input) => {
    const url = String(input);
    called.push(url);

    if (url.includes("generate_token")) {
      return new Response("guest-token-value-1234567890", { status: 200 });
    }

    if (url.includes("get-hls-key")) {
      const key = keyed(url);
      // The resolver probes every rendition; only one needs to answer.
      if (new RegExp(`^${rendition}/main\\.m3u8$`).test(key)) {
        const media = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-TARGETDURATION:6",
          '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
          "#EXTINF:6.000,",
          "000.ts",
          "#EXTINF:6.000,",
          "001.ts",
          "#EXT-X-ENDLIST",
        ].join("\n");
        return new Response(media, {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      // Strict on purpose: the source names the key `enc.key`, with no
      // rendition in front of it. Accepting `240/enc.key` too would hide a bug
      // that only appears against the real signer.
      if (key === "enc.key") {
        return new Response(KEY, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      if (/^240\/\d{3}\.ts$/.test(key)) {
        const index = Number(key.match(/(\d{3})\.ts$/)[1]);
        return new Response(encryptSegment(index), {
          status: 200,
          headers: { "content-type": "video/mp2t" },
        });
      }
      return new Response(JSON.stringify({ success: false }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: false }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
}

/** A response object that records what the handler did. */
function fakeRes() {
  const headers = {};
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  return {
    statusCode: 200,
    headers,
    body: () => (chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)),
    text: () => Buffer.concat(chunks).toString("utf8"),
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      finished();
    },
    done,
  };
}

async function call(query, { stub = signerStub() } = {}) {
  called.length = 0;
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    const { default: handler } = await import("../lib/download-route.mjs");
    const res = fakeRes();
    await handler(
      { method: "GET", url: `/api/download?${query}`, headers: { host: "site.test" } },
      res
    );
    await res.done;
    return res;
  } finally {
    globalThis.fetch = original;
  }
}

const base = `folder=${FOLDER}&quality=240&name=${encodeURIComponent("Units and Dimension 10")}`;

test("list mode reports the shape of the lecture before anything is downloaded", async () => {
  const res = await call(`mode=list&${base}`);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.text());
  assert.equal(body.success, true);
  assert.equal(body.playable, true);
  assert.equal(body.segments, 2);
  assert.equal(body.seconds, 12);
  assert.equal(body.encrypted, true);
  assert.equal(body.quality, "240");
  assert.equal(body.label, "240p");
  assert.deepEqual(body.renditions, ["240"]);
  assert.equal(body.slices, 1, "a two-segment lecture is one slice");
  // The roster is only sent when asked for: a 55-minute lecture is 554 entries.
  assert.equal(body.files, undefined);
});

test("list mode sends the segment roster only when it is requested", async () => {
  const res = await call(`mode=list&files=1&${base}`);
  const body = JSON.parse(res.text());
  assert.equal(body.files.length, 2);
  assert.equal(body.files[0].key, "240/000.ts");
  assert.equal(body.files[0].seconds, 6);
});

test("a plain slice comes back as decrypted MPEG-TS with a filename", async () => {
  const res = await call(`mode=file&format=plain&limit=2&${base}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "video/mp2t");
  assert.match(res.headers["content-disposition"], /attachment; filename="Units and Dimension 10 240p\.ts"/);
  assert.equal(res.headers["x-download-format"], "plain");
  assert.equal(res.headers["x-download-total"], "2");
  assert.equal(res.headers["x-download-done"], "1");
  assert.equal(res.headers["x-download-segments"], "2");

  // The failure this guards: the handler fetched its own deployment origin and
  // got "fetch failed" — stage 500, production only.
  assert.deepEqual(
    called.filter((u) => u.includes("site.test")),
    [],
    "the handler must not call its own origin"
  );

  const body = res.body();
  assert.equal(body.length, 2 * PACKET, "both segments should be present, decrypted");
  assert.equal(body[0], 0x47, "a decrypted slice must start with an MPEG-TS sync byte");
  // Decrypted, not merely concatenated: the ciphertext would not carry this mark.
  assert.equal(body[PACKET - 1], 1);
  assert.equal(body[2 * PACKET - 1], 2);
});

test("a playlist slice comes back as a self-contained manifest", async () => {
  const res = await call(`mode=file&limit=2&${base}`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /mpegurl/);
  assert.match(res.headers["content-disposition"], /\.m3u8"/);
  const text = res.text();
  assert.match(text, /URI="data:application\/octet-stream;base64,/);
  assert.equal((text.match(/data:video\/MP2T;base64,/g) || []).length, 2);
  // Nothing in the saved file may point back at this site.
  assert.equal(/https?:\/\//.test(text), false);
});

test("a slice in the middle reports where it started and what comes next", async () => {
  const res = await call(`mode=file&format=plain&limit=1&offset=1&${base}`);
  assert.equal(res.headers["x-download-start"], "1");
  assert.equal(res.headers["x-download-next"], "2");
  assert.equal(res.headers["x-download-done"], "1");
  assert.equal(res.body().length, PACKET);
});

test("a lecture with no stream is an honest 200, not a server error", async () => {
  const stub = async () => new Response("{}", { status: 404 });
  const res = await call("mode=list&folder=does-not-exist", { stub });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.text());
  assert.equal(body.success, true);
  assert.equal(body.playable, false);
  assert.match(body.error, /no downloadable stream|not published/i);
});

test("a missing folder is a 400 that says what to send", async () => {
  const res = await call("mode=list");
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.text());
  assert.equal(body.success, false);
  assert.match(body.error, /folder=/);
});

test("an unknown mode is refused rather than guessed", async () => {
  const res = await call(`mode=everything&${base}`);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.text()).error, /Unknown mode/);
});

test("one file can be fetched on its own, as an attachment", async () => {
  const res = await call(`asset=${encodeURIComponent("240/000.ts")}&${base}`);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-disposition"], /attachment; filename=".*000\.ts"/);
  // One file, byte for byte: this is the encrypted segment as the source holds
  // it, so its length is the ciphertext's, block padding included.
  assert.equal(res.body().equals(encryptSegment(0)), true);
});

test("a bursty signer is retried instead of failing the slice", async () => {
  // The production bug: `mode=list` succeeded and the slice a second later
  // reported "rendition answered 401", because the signer was throttling. One
  // refusal must not be reported as "this lecture cannot be downloaded".
  let refusals = 0;
  const stub = async (input, opts) => {
    const url = String(input);
    if (url.includes("main.m3u8") && refusals < 2) {
      refusals += 1;
      return new Response(JSON.stringify({ success: false }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return signerStub()(input, opts);
  };

  const res = await call(`mode=file&format=plain&limit=2&${base}`, { stub });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-download-format"], "plain");
  assert.equal(res.body()[0], 0x47, "the retried slice should carry real media");
  assert.ok(refusals >= 2, "the signer should have been asked again");
});

test("a rendition that refuses falls back to one that answers", async () => {
  // `playable:false` for a lecture whose sibling rendition is fine is a lie the
  // page acts on: it hides the Save button instead of downloading anything.
  //
  // A fresh folder keeps this out of the ten-minute plan cache, and 240 answers
  // the first time (the probe) then refuses — which is exactly how it behaved
  // in production: the probe succeeded and the download a moment later did not.
  const OTHER = "99999999-8888-7777-6666-555555555555";
  let asked240 = 0;
  const base = signerStub();
  const stub = async (input, opts) => {
    const url = String(input);
    const key = new URL(url, "https://x").searchParams.get("key") || "";
    if (url.includes("get-hls-key") && /^240\/main\.m3u8$/.test(key)) {
      asked240 += 1;
      if (asked240 > 1) {
        return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
      }
    }
    const wanted = /^(\d+)\/main\.m3u8$/.exec(key);
    if (url.includes("get-hls-key") && wanted && wanted[1] !== "240") {
      return new Response(["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXTINF:6.000,", "000.ts", "#EXT-X-ENDLIST"].join("\n"), {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return base(input, opts);
  };

  const res = await call(`mode=list&folder=${OTHER}&quality=240&name=x`, { stub });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.text());
  assert.equal(body.playable, true, "a working rendition should be reported");
  assert.notEqual(body.quality, "240", "the failing rendition should not be advertised");
});

test("HEAD is accepted so a player can check before downloading", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = signerStub();
  try {
    const { default: handler } = await import("../lib/download-route.mjs");
    const res = fakeRes();
    await handler({ method: "HEAD", url: `/api/download?mode=list&${base}`, headers: { host: "site.test" } }, res);
    await res.done;
    assert.notEqual(res.statusCode, 405, "a HEAD probe was refused");
  } finally {
    globalThis.fetch = original;
  }
});
