/**
 * Stream resolution tests.
 *
 * The old resolver only ever asked for `720/main.m3u8`. Videos published
 * without a 720p rendition were therefore reported as "not published" and the
 * lecture would not play, even though the stream was available. These tests pin
 * the quality fallback, the signer failover, and the honest no-video answers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const FOLDER = "042ebf01-cf9a-404b-a12c-a1c5021475a3";

/**
 * Successful probes are cached per folder for ten minutes, so every test gets
 * its own folder id — otherwise the first test's plan would leak into the next.
 */
function mpd(folder) {
  return `https://d1d34p8vz63oiq.cloudfront.net/${folder || FOLDER}/master.mpd`;
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function playlistResponse() {
  return new Response("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4.0,\n000.ts\n#EXT-X-ENDLIST\n", {
    status: 200,
    headers: { "content-type": "application/vnd.apple.mpegurl" },
  });
}

test("falls back to a lower rendition when 720p is missing", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");
  const asked = [];

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        asked.push(String(url));
        // only 480p exists for this video
        if (/key=480%2Fmain\.m3u8|key=480\/main\.m3u8/.test(String(url))) {
          return playlistResponse();
        }
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 404 });
    },
    () => resolveStream({ rawUrl: mpd("aaaaaaaa-1111-4111-8111-111111111111") })
  );

  assert.equal(plan.playable, true);
  assert.equal(plan.kind, "hls");
  assert.equal(plan.quality, "480");
  assert.match(plan.url, /key=480\/main\.m3u8/);
  assert.ok(asked.some((u) => /720/.test(u)), "720p should have been tried first");
});

test("tries the next signer host when the first one rejects", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");
  const hosts = [];

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        const host = new URL(String(url)).host;
        hosts.push(host);
        if (host === "vidcloud.eu.org") {
          return new Response("Forbidden", { status: 403 });
        }
        return playlistResponse();
      }
      return new Response("nope", { status: 404 });
    },
    () => resolveStream({ rawUrl: mpd("bbbbbbbb-2222-4222-8222-222222222222") })
  );

  assert.equal(plan.playable, true);
  assert.ok(new Set(hosts).size > 1, `expected several signers, saw ${hosts.join(",")}`);
});

test("reports an actionable reason when no rendition exists", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      return new Response(JSON.stringify({ success: false }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
    () => resolveStream({ rawUrl: mpd("cccccccc-3333-4333-8333-333333333333") })
  );

  assert.equal(plan.playable, false);
  assert.equal(plan.url, "");
  assert.match(plan.reason, /not published a playable stream/i);
  assert.match(plan.reason, /live class|notes-only|processing/i);
});

test("a signed URL is relayed through the media gateway, not the signer", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");
  const signed = `${mpd("dddddddd-4444-4444-8444-444444444444")}?Signature=abc&Key-Pair-Id=XYZ&Policy=p`;

  const plan = await withFetch(
    async () => {
      throw new Error("no network call should be made for an already-signed URL");
    },
    () => resolveStream({ rawUrl: signed })
  );

  assert.equal(plan.playable, true);
  assert.equal(plan.kind, "dash");
  assert.match(plan.url, /^\/api\/stream\?folder=/);
});

test("non-video entries are explained instead of reported as broken", async () => {
  const { default: handler } = await import("../api/stream.mjs");

  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(body) {
      this.body = body;
    },
  };

  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            _id: "69f9e76e7d74d12302ff0f1d",
            topic: "Units and Measurement : DPP 09",
            lectureType: "PDF",
            isVideoLecture: false,
            status: "COMPLETED",
            homeworkIds: [{ _id: "x" }],
            videoDetails: {},
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
    () =>
      handler(
        {
          method: "GET",
          url: "/api/stream?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&id=69f9e76e7d74d12302ff0f1d",
          headers: { host: "example.test" },
        },
        res
      )
  );

  const payload = JSON.parse(res.body);
  assert.equal(payload.success, true, "a lecture without video is not a server error");
  assert.equal(payload.playable, false);
  assert.match(payload.reason, /document, not a video/i);
});

test("each kind of video-less entry gets its own explanation", async () => {
  const { explainNoVideo } = await import("../lib/playback.mjs");

  const doc = explainNoVideo({ lectureType: "PDF", status: "COMPLETED", isVideoLecture: false });
  assert.match(doc, /document, not a video/i);

  const upcoming = explainNoVideo({ lectureType: "LIVE", status: "NOT_STARTED", isVideoLecture: true });
  assert.match(upcoming, /live class/i);

  const processing = explainNoVideo({ lectureType: "RECORDED", status: "PENDING", hasNotes: true });
  assert.match(processing, /notes and DPPs/i);

  const missing = explainNoVideo({ lectureType: "LIVE", status: "COMPLETED", hasNotes: false });
  assert.match(missing, /has not published a video/i);

  assert.match(explainNoVideo(null), /could not be found/i);
});
