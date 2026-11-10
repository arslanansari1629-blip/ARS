/**
 * A mid-lecture retry must not re-read the schedule.
 *
 * `api/stream` resolves a lecture in two steps: read the schedule (which yields
 * the video folder), then probe that folder for a signature. The folder does not
 * change during a lecture, but the schedule read is two upstream calls with
 * 25-second timeouts. On a retry the player now sends the folder it already has,
 * so the second step happens immediately.
 *
 * The risk in that shortcut is a *dead* folder: skipping the schedule means a
 * lecture whose folder changed would never be found again. So the fast path has
 * to fall back, and this pins both halves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/** Stand in for the network: a schedule that always answers, a signer that may not. */
function stubFetch({ signerOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (/Schedule|schedule-details/i.test(url)) {
      return new Response(
        JSON.stringify({
          data: {
            _id: "lec",
            topic: "A lecture",
            videoDetails: {
              name: "A lecture",
              // The folder in the schedule differs from the one the page sent,
              // which is how the fallback is observable.
              videoUrl: "https://d1d34p8vz63oiq.cloudfront.net/aaaa1111-2222-3333-4444-555555555555/master.mpd",
              status: "Ready",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (/get-hls-key/.test(url)) {
      if (!signerOk) return new Response("nope", { status: 403 });
      return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n720/main.m3u8\n", {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    return new Response("{}", { status: 404 });
  };
  return calls;
}

const handler = (await import("../api/stream.mjs")).default;

/** Minimal req/res pair, enough for this route. */
function call(query) {
  const req = { method: "GET", headers: { host: "localhost" }, url: `/api/stream?${query}` };
  let body = "";
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(chunk) {
      body += chunk == null ? "" : String(chunk);
    },
  };
  return handler(req, res).then(() => ({
    status: res.statusCode,
    headers: res.headers,
    body: body ? JSON.parse(body) : null,
  }));
}

const FOLDER = "e76c2cf2-413b-4f14-a7b5-8ebeb6c60523";
const BASE = "batch=b1&subject=s1&id=lec1";

test("a retry that names its folder does not re-read the schedule", async () => {
  const calls = stubFetch({ signerOk: true });
  const out = await call(`${BASE}&folder=${FOLDER}&attempt=2`);

  assert.equal(out.body.playable, true, JSON.stringify(out.body).slice(0, 300));
  assert.equal(out.body.fastPath, "folder");
  assert.equal(
    calls.some((c) => /Schedule|schedule-details/i.test(c.url)),
    false,
    `the schedule was re-read anyway: ${calls.map((c) => c.url).join(" | ")}`
  );
  // No cache: a plan carries a live signed path.
  assert.match(String(out.headers["cache-control"] || ""), /no-store/);
});

test("a folder the signer will not sign falls back to the schedule", async () => {
  // The dangerous case: the shortcut must never be the reason a lecture that
  // *does* have a stream is reported as unplayable.
  const calls = stubFetch({ signerOk: false });
  const out = await call(`${BASE}&folder=${FOLDER}&attempt=2`);

  assert.ok(
    calls.some((c) => /Schedule|schedule-details/i.test(c.url)),
    `a dead folder was not retried through the schedule: ${calls.map((c) => c.url).join(" | ")}`
  );
  // And it reports the new folder rather than the dead one it was handed.
  assert.notEqual(out.body.fastPath, "folder");
});

test("a first load still reads the schedule", async () => {
  const calls = stubFetch({ signerOk: true });
  await call(BASE);
  assert.ok(
    calls.some((c) => /Schedule|schedule-details/i.test(c.url)),
    "a first load skipped the schedule and so cannot know the folder"
  );
});

test("a folder that is not a folder id is refused by the shortcut", async () => {
  const calls = stubFetch({ signerOk: true });
  const out = await call(`${BASE}&folder=..%2F..%2Fetc%2Fpasswd`);
  // Not a UUID, so it must not be used as one — and the route still answers.
  assert.notEqual(out.body.fastPath, "folder");
  assert.ok(calls.length > 0);
});
