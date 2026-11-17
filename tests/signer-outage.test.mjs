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

test("the watch page retries an outage on its own", async () => {
  const lecture = await readFile(new URL("../public/assets/lecture.js", import.meta.url), "utf8");
  assert.match(lecture, /plan\.signerDown/);
  assert.match(lecture, /Signing service is down/);
  assert.match(lecture, /Retrying automatically in the background/);
});
