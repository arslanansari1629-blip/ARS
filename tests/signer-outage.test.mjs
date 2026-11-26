/**
 * A dead guest-token mint is a signing *outage*, not a per-lecture refusal.
 *
 * November 2026: vidcloud answers 502, streamvideo 500, studyspark denies,
 * and PW's official signer rejects the built-in fallback token — so every
 * lecture on the site refused at once. The resolver must say "temporary,
 * retry" (`signerDown`), and the watch page must keep retrying on its own
 * instead of declaring the lecture permanently refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const mpd = (folder) => `https://d1d34p8vz63oiq.cloudfront.net/${folder}/master.mpd`;

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("when no token can be minted, a signer refusal is a retryable outage", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");
  const { resetToken } = await import("../lib/pw-auth.mjs");
  resetToken();

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("down", { status: 502 });
      }
      return new Response("Unauthorised Access", { status: 401 });
    },
    () => resolveStream({ rawUrl: mpd("11111111-7777-4777-8777-777777777777") })
  );

  assert.equal(plan.playable, false);
  assert.equal(plan.signerDown, true);
  assert.ok(plan.retryAfter >= 10, `outage plans must carry a retry delay, got ${plan.retryAfter}`);
  assert.match(plan.reason, /not answering right now|temporary outage/i);
  assert.doesNotMatch(plan.reason, /cannot sign this one/i);
});

test("with a minted token, the same refusal stays a per-lecture answer", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");
  const { resetToken } = await import("../lib/pw-auth.mjs");
  resetToken();

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      return new Response("Unauthorised Access", { status: 401 });
    },
    () => resolveStream({ rawUrl: mpd("22222222-8888-4888-8888-888888888888") })
  );

  assert.equal(plan.playable, false);
  assert.ok(!plan.signerDown, "a minted token means the refusal is the lecture's, not an outage");
  assert.match(plan.reason, /refuses to mint|cannot sign/i);
});

test("a 402 from the lead signer walks the whole ladder instead of declaring an outage", async () => {
  // The November 2026 live failure, reproduced: our own Vercel lane
  // answered 402 (quota wall) five times, no tally recognised 402 as
  // a refusal, `refused` stayed 0, the mint/anchor passes never ran,
  // and a healthy vidcloud sitting second in the ladder was never
  // asked. 402 is a refusal; the walk must reach the healthy host.
  const { resolveStream, forgetSignerToken } = await import("../lib/api-data.mjs");
  const { resetToken } = await import("../lib/pw-auth.mjs");
  const { recordSignerResult } = await import("../lib/selfheal.mjs");
  resetToken();
  forgetSignerToken();
  // Earlier tests in this file taught the healer that every host is
  // dead (wall-to-wall 401 stubs), which ranks the healthy lane last
  // and starves it of probe budget. Clear the lesson so this test
  // measures the ladder, not the accumulated quarantine.
  for (const h of [
    "https://arsvibe-pw-sepia.vercel.app/api/pw/v1/videos/get-hls-key",
    "https://vidcloud.eu.org/api/v1/videos/get-hls-key",
    "https://www.learnxpw.site/api/v1/videos/get-hls-key",
    "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key",
    "https://proxy.streamvideo.co.in/api/v1/videos/get-hls-key",
    "https://api.penpencil.xyz/v1/videos/get-hls-key",
    "https://api.penpencil.co/v1/videos/get-hls-key",
  ]) {
    recordSignerResult(h, true, {});
  }

  const plan = await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("generate_token")) return new Response("down", { status: 502 });
      if (u.includes("arsvibe-pw-sepia.vercel.app")) return new Response("quota", { status: 402 });
      if (u.includes("vidcloud.eu.org")) {
        return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg-1.ts\n", {
          status: 200,
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      return new Response("denied", { status: 403 });
    },
    () => resolveStream({ rawUrl: mpd("44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa") })
  );

  assert.equal(plan.playable, true, "the healthy second lane must be reached past a 402 wall");
});

test("empty 200s from every signer are a signing failure, never 'not published'", async () => {
  // The November 2026 Vercel-lane regression: signer hosts answered 200
  // with empty bodies, so every tally (refused/answered/unreachable/
  // notFound) came back zero — and the plan fell through to "PW has not
  // published", a false claim about a recording whose folder the
  // schedule itself handed us. Zero tallies must still classify as a
  // signing-side failure with a diag attached.
  const { resolveStream } = await import("../lib/api-data.mjs");
  const { resetToken } = await import("../lib/pw-auth.mjs");
  resetToken();

  const plan = await withFetch(
    async () => new Response("", { status: 200, headers: { "content-type": "text/plain" } }),
    () => resolveStream({ rawUrl: mpd("33333333-9999-4999-8999-999999999999") })
  );

  assert.equal(plan.playable, false);
  assert.doesNotMatch(plan.reason, /has not published/i, "a published folder must never be reported as unpublished");
  assert.ok(plan.diag, "a signing failure must carry its diag");
  assert.equal(plan.diag.refused + plan.diag.answered + plan.diag.unreachable + plan.diag.notFound, 0);
});

test("the watch page retries an outage on its own", async () => {
  const lecture = await readFile(new URL("../public/assets/lecture.js", import.meta.url), "utf8");
  assert.match(lecture, /plan\.signerDown/);
  assert.match(lecture, /Signing service is down/);
  assert.match(lecture, /Retrying automatically in the background/);
});
