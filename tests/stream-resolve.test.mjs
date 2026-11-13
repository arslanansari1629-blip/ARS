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
  // Only 480p exists, so only 480p may be advertised — offering a 720p level that
  // the signer does not store would give the player a quality that cannot play.
  assert.deepEqual(plan.renditions, ["480"]);
  // The player gets a master playlist, not the rendition's own media playlist:
  // that is what gives hls.js levels for the quality picker to switch between.
  assert.match(plan.url, /key=master\.m3u8/);
  // ...and it must name the renditions it may offer. This assertion is the
  // regression guard for the bug that made every lecture unplayable: the relay
  // was asked for a `master.m3u8` no signer stores (403, dead player), because
  // the plan never said which renditions existed.
  assert.match(plan.url, /renditions=480/, "the plan does not tell the relay which renditions exist");
  assert.equal(
    new URL(`http://x${plan.url}`).searchParams.get("renditions"),
    "480",
    "only the renditions that answered may be advertised"
  );
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

test("a signer refusal is not reported as 'not published'", async () => {
  // This is the live production case: the schedule carries a real, non-DRM
  // `master.mpd`, but every signer answers 401/403 because the site only holds a
  // guest PW session. The old message said PW had not published a stream, which
  // is false — the recording exists and its address is in the response.
  const { resolveStream } = await import("../lib/api-data.mjs");

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      return new Response("Unauthorised Access", { status: 401 });
    },
    () => resolveStream({ rawUrl: mpd("eeeeeeee-5555-4555-8555-555555555555") })
  );

  assert.equal(plan.playable, false);
  assert.doesNotMatch(plan.reason, /has not published/i);
  assert.match(plan.reason, /recording exists/i);
  assert.match(plan.reason, /401\/403|refuses|guest/i);
  // The schedule address must stay visible so the failure is diagnosable.
  assert.equal(plan.sourceUrl, mpd("eeeeeeee-5555-4555-8555-555555555555"));
});

test("an unreachable signer is reported as a transport problem", async () => {
  const { resolveStream } = await import("../lib/api-data.mjs");

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      throw new Error("connect ECONNREFUSED");
    },
    () => resolveStream({ rawUrl: mpd("ffffffff-6666-4666-8666-666666666666") })
  );

  assert.equal(plan.playable, false);
  assert.doesNotMatch(plan.reason, /has not published/i);
  assert.match(plan.reason, /could not be reached|reloading/i);
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
  // `/api/stream` answers with JSON, so pointing the player at it was a silent
  // dead lecture. A signed plan must go to the media gateway.
  assert.match(plan.url, /^\/api\/hls\?folder=/);
  assert.match(plan.url, /asset=master\.mpd/);
});

test("the media gateway mints what the CDN refuses instead of dead-ending", async () => {
  const { default: gateway } = await import("../lib/hls.mjs");

  // A schedule URL with no signature: the CDN answers 403, and the player used
  // to be told "media host answered 403" with nothing to do about it.
  const call = async (query) => {
    const headers = {};
    const chunks = [];
    let redirect = "";
    const result = await new Promise((resolve) => {
      const res = {
        statusCode: 0,
        write(b) {
          chunks.push(Buffer.from(b));
        },
        setHeader(k, v) {
          headers[k] = v;
          if (k === "Location") redirect = v;
        },
        end(body) {
          if (body) chunks.push(Buffer.from(body));
          resolve({ status: this.statusCode, headers, redirect, body: Buffer.concat(chunks).toString() });
        },
      };
      gateway({ method: "GET", url: `/api/hls?${query}`, headers: { host: "arsvibe.test" } }, res);
    });
    return result;
  };

  await withFetch(
    async (url) => {
      const s = String(url);
      if (s.includes("cloudfront.net") && !s.includes("Signature=")) {
        return new Response("denied", { status: 403 });
      }
      if (s.includes("generate_token")) return new Response("guest-token-value-123456");
      if (s.includes("get-hls-key")) {
        const key = new URL(s).searchParams.get("key");
        // The signer has per-rendition playlists only — never a master.
        if (/master\./.test(key)) return new Response("no", { status: 403 });
        if (/\.m3u8$/.test(key)) {
          return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n000.ts\n", {
            headers: { "content-type": "application/vnd.apple.mpegurl" },
          });
        }
        return new Response("KEYBYTES", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    },
    async () => {
      // A master: the gateway redirects to the plan's playable master, it does
      // not try to fetch a master from a signer that has none.
      const master = await call(
        "folder=d780e1e3-f446-4218-97f8-5d3f4dd4ca05&asset=master.mpd&host=d1d34p8vz63oiq.cloudfront.net"
      );
      assert.equal(master.status, 302, "the gateway should hand over the playable master");
      assert.match(master.redirect, /^\/api\/sign\?/);
      assert.match(master.redirect, /key=master\.m3u8/);
      assert.match(master.redirect, /renditions=/, "the master needs the rendition list");

      // A single file: relayed through the signer, bytes and all.
      const key = await call(
        "folder=d780e1e3-f446-4218-97f8-5d3f4dd4ca05&asset=enc.key&host=d1d34p8vz63oiq.cloudfront.net"
      );
      assert.equal(key.status, 200, JSON.stringify(key.body));
      assert.equal(key.body, "KEYBYTES");
    }
  );
});

test("the media gateway says something useful when nothing can open the file", async () => {
  const { default: gateway } = await import("../lib/hls.mjs");
  await withFetch(
    async (url) => {
      const s = String(url);
      if (s.includes("cloudfront.net")) return new Response("denied", { status: 403 });
      return new Response(JSON.stringify({ success: false }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const out = await new Promise((resolve) => {
        const res = {
          statusCode: 0,
          headers: {},
          write() {},
          setHeader(k, v) {
            this.headers[k] = v;
          },
          end(body) {
            resolve({ status: this.statusCode, body: String(body || "") });
          },
        };
        gateway(
          {
            method: "GET",
            url: "/api/hls?folder=00000000-0000-4000-8000-000000000000&asset=master.mpd&host=d1d34p8vz63oiq.cloudfront.net",
            headers: { host: "arsvibe.test" },
          },
          res
        );
      });
      assert.equal(out.status, 403);
      assert.match(out.body, /signature/i, "the failure does not say why or what to do");
    }
  );
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

/**
 * The site's own reads must not loop back over HTTP.
 *
 * `UPSTREAM_BASE` used to be the literal `/api/pw`, resolved against
 * `VERCEL_URL`. On Vercel the deployment URL sits behind deployment protection,
 * so that self-fetch got an HTML auth page and every lecture resolved to "no
 * video" while `/api/pw` itself worked fine when called directly. The reads now
 * call the same dispatcher in-process.
 */
test("site reads go through the in-process PW dispatcher", async () => {
  // This file pins PW_UPSTREAM_BASE for the other tests, so read the default
  // from a fresh module instance with the override removed.
  const pinned = process.env.PW_UPSTREAM_BASE;
  delete process.env.PW_UPSTREAM_BASE;
  const fresh = await import("../lib/upstream.mjs?in-process-default");
  if (pinned === undefined) delete process.env.PW_UPSTREAM_BASE;
  else process.env.PW_UPSTREAM_BASE = pinned;

  assert.equal(fresh.UPSTREAM_BASE, "pw", "default must be in-process, not a URL");

  const { upstreamJson } = await import("../lib/upstream.mjs?in-process-default");

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    // A loopback would show up as a request to our own deployment.
    assert.doesNotMatch(url, /\/api\/pw/, "must not fetch its own HTTP route");
    return new Response(JSON.stringify({ success: true, data: { _id: "batch-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await upstreamJson("/v3/batches/batch-1/details");
    assert.equal(result.ok, true);
    assert.equal(result.data.data._id, "batch-1");
    assert.equal(seen.length, 1);
    // The credential is attached by the dispatcher, not by the caller.
    assert.match(seen[0], /^https:\/\/api\.penpencil\.co\/v3\/batches\/batch-1\/details$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * Two schedule routes, and only one of them carries the stream URL.
 *
 * The modern `/v1/.../schedule-details` answers with the full record but an empty
 * `videoDetails.videoUrl`; the legacy `/Schedule` is 404 on api.penpencil.co yet
 * returns the signed `master.mpd` on the vidcloud mirror. Preferring "modern"
 * unconditionally silently unmounted every lecture, so the reader must take
 * whichever record actually has a stream.
 */
test("fetchSchedule prefers the record that carries a video URL", async () => {
  const { fetchSchedule } = await import("../lib/api-data.mjs");

  const modern = {
    _id: "lec-1",
    topic: "Modern record",
    videoDetails: { name: "Modern record", videoUrl: "", status: "Ready" },
  };
  const legacy = {
    _id: "lec-1",
    topic: "Legacy record",
    videoDetails: {
      name: "Legacy record",
      videoUrl: "https://d1d34p8vz63oiq.cloudfront.net/abc-123/master.mpd",
      status: "Ready",
    },
  };

  await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("schedule-details")) return jsonResponseSafe({ success: true, data: modern });
      if (u.includes("/Schedule?")) return jsonResponseSafe({ success: true, data: legacy });
      return jsonResponseSafe({ success: false }, 404);
    },
    async () => {
      const res = await fetchSchedule("b", "s", "lec-1");
      assert.equal(res.ok, true);
      assert.match(res.lecture.videoUrl, /abc-123\/master\.mpd/, "the stream URL must survive");
      assert.equal(res.lecture.title, "Legacy record");
    }
  );
});

test("fetchSchedule explains itself when neither route answers", async () => {
  const { fetchSchedule } = await import("../lib/api-data.mjs");
  await withFetch(
    async () => jsonResponseSafe({ success: false }, 404),
    async () => {
      const res = await fetchSchedule("b", "s", "lec-1");
      assert.equal(res.ok, false);
      assert.match(res.error, /status 404|404/);
    }
  );
});

function jsonResponseSafe(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("advertises every rendition that answered, lowest first", async () => {
  const { resolveStream, masterPlaylist } = await import("../lib/api-data.mjs");

  const plan = await withFetch(
    async (url) => {
      if (String(url).includes("generate_token")) {
        return new Response("guest-token-value-123456", { status: 200 });
      }
      if (String(url).includes("get-hls-key")) {
        // 720 and 360 exist; 1080 and 480 do not.
        if (/key=(720|360)\/main\.m3u8/.test(String(url))) return playlistResponse();
        return new Response(JSON.stringify({ success: false }), { status: 404 });
      }
      return new Response("nope", { status: 404 });
    },
    () => resolveStream({ rawUrl: mpd("dddddddd-4444-4444-8444-444444444444") })
  );

  assert.deepEqual(plan.renditions, ["720", "360"], "best answer first");

  const text = masterPlaylist([
    { quality: "720", main: "https://x/api/sign?key=720%2Fmain.m3u8" },
    { quality: "360", main: "https://x/api/sign?key=360%2Fmain.m3u8" },
  ]);
  const variants = text.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(variants.length, 2);
  assert.match(text, /^#EXTM3U/);
  // hls.js treats the last variant as the highest quality, so order matters.
  assert.match(variants[0], /360/, "lowest rendition must come first");
  assert.match(variants[1], /720/);
  assert.match(text, /RESOLUTION=1280x720/);
  assert.match(text, /RESOLUTION=640x360/);
});

test("the relay mints a playable master playlist instead of asking the signer", async () => {
  const { default: relay } = await import("../lib/sign.mjs");

  // No network is stubbed below: a correct implementation never calls a signer
  // for the master, so any outbound request here would be a bug in itself.
  const call = (query) =>
    new Promise((resolve) => {
      const headers = {};
      const chunks = [];
      const res = {
        statusCode: 0,
        setHeader(k, v) {
          headers[k] = v;
        },
        end(body) {
          if (body) chunks.push(Buffer.from(body));
          resolve({
            status: this.statusCode,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        },
      };
      relay(
        { method: "GET", url: `/api/sign?${query}`, headers: { host: "arsvibe.test" } },
        res
      );
    });

  const master = await call("videoKey=abc-123&key=master.m3u8&renditions=720,360");
  assert.equal(master.status, 200);
  assert.match(master.headers["Content-Type"], /mpegurl/);
  // hls.js is a cross-origin consumer of this URL; without CORS it cannot read it.
  assert.equal(master.headers["Access-Control-Allow-Origin"], "*");
  assert.match(master.body, /^#EXTM3U/);

  const variants = master.body.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(variants.length, 2, master.body);
  assert.match(variants[0], /key=360%2Fmain\.m3u8/, "lowest rendition must come first");
  assert.match(variants[1], /key=720%2Fmain\.m3u8/);
  for (const v of variants) {
    assert.match(v, /^https:\/\/arsvibe\.test\/api\/sign\?/, `variant is not same-origin: ${v}`);
  }

  const bad = await call("videoKey=abc-123&key=master.m3u8");
  assert.equal(bad.status, 400, "a master with no renditions must not pretend to be a playlist");
  assert.match(bad.body, /renditions/i);
});

test("the health probe walks plan → master → rendition → segment", async () => {
  const { probePlayback } = await import("../api/token.mjs");

  const out = await withFetch(
    async (url) => {
      const s = String(url);
      if (s.includes("cloudfront.net") && !s.includes("Signature=")) {
        return new Response("denied", { status: 403 });
      }
      if (s.includes("generate_token")) return new Response("guest-token-value-123456");
      if (s.includes("get-hls-key")) {
        const key = new URL(s).searchParams.get("key");
        if (/master\.m3u8/.test(key)) return new Response("no", { status: 403 });
        if (/\.m3u8$/.test(key)) return playlistResponse();
        return new Response(Buffer.alloc(4096, 7), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    },
    () => probePlayback(mpd("eeeeeeee-5555-4555-8555-555555555555"))
  );

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(
    out.steps.map((s) => s.step),
    ["plan", "master", "rendition", "segment"]
  );
  assert.ok(out.steps.every((s) => s.ok), JSON.stringify(out.steps));
  // The point of the probe: a lecture is only "working" once real bytes arrived,
  // not merely when the schedule named a URL.
  assert.ok(out.steps.at(-1).bytes > 1000);
});

test("the health probe names the step that broke", async () => {
  const { probePlayback } = await import("../api/token.mjs");

  const out = await withFetch(
    async (url) => {
      const s = String(url);
      if (s.includes("cloudfront.net")) return new Response("denied", { status: 403 });
      if (s.includes("generate_token")) return new Response("guest-token-value-123456");
      // Every rendition answers, but the segment itself never will.
      if (s.includes("get-hls-key")) {
        const key = new URL(s).searchParams.get("key");
        if (/\.m3u8$/.test(key)) return playlistResponse();
        return new Response("gone", { status: 404 });
      }
      return new Response("nope", { status: 404 });
    },
    () => probePlayback(mpd("ffffffff-6666-4666-8666-666666666666"))
  );

  assert.equal(out.ok, false);
  assert.equal(out.step, "segment", `expected the segment step to be blamed, got ${JSON.stringify(out)}`);
  // The reason is whatever the relay last saw (404 from the signer, or the 502
  // it answers once every signer refused). What matters is that a reader is told
  // *which* step failed instead of a generic "playback is broken".
  assert.match(out.reason, /segment answered \d{3}/);
});

test("a /drm/ address yields its folder instead of an empty string", async () => {
  // The url shape that exposed this: a real CA Foundation Khazana 2026 lecture.
  // The pattern required the uuid to follow the host directly, so everything
  // after `/drm/` was unmatchable and the folder came back "". Callers read ""
  // as "not a PW asset" and told the student a cloudfront.net stream was
  // "hosted outside the PW CDN".
  const { parseFolder, isDrmUrl } = await import("../lib/api-data.mjs");

  const plain = "https://d1d34p8vz63oiq.cloudfront.net/33377452-995f-4091-a98e-7068cf901f0b/master.mpd";
  const drm = "https://d1d34p8vz63oiq.cloudfront.net/drm/7e2dfafb-61ef-4b6b-a8f8-1377cb8ad26f/master.mpd";

  assert.equal(parseFolder(plain), "33377452-995f-4091-a98e-7068cf901f0b");
  assert.equal(
    parseFolder(drm),
    "7e2dfafb-61ef-4b6b-a8f8-1377cb8ad26f",
    "a /drm/ url must still name the folder it belongs to"
  );

  // The DRM flag is the separate fact: relaying is impossible for a different
  // reason, and the two must not collapse into one another.
  assert.equal(isDrmUrl(plain), false);
  assert.equal(isDrmUrl(drm), true);
});

test("a DRM lecture is named as DRM, not as an unknown host", async () => {
  // The failure a reader actually saw, before the fix:
  //   "This lecture is hosted outside the PW CDN, so it cannot be relayed here."
  // about a `d1d34p8vz63oiq.cloudfront.net` url. The advice that followed
  // ("use the source player link") is useless for Widevine content, and the
  // sentence is simply false about a host the site relays every day.
  const { resolveStream } = await import("../lib/api-data.mjs");

  const drm = "https://d1d34p8vz63oiq.cloudfront.net/drm/7e2dfafb-61ef-4b6b-a8f8-1377cb8ad26f/master.mpd";
  const plan = await resolveStream({ rawUrl: drm });

  assert.equal(plan.playable, false);
  assert.equal(plan.kind, "drm", `expected kind "drm", got "${plan.kind}"`);
  assert.equal(plan.drm, true);
  assert.ok(/DRM|Widevine/i.test(plan.reason), `the reason did not mention DRM: ${plan.reason}`);
  assert.ok(
    !/outside the PW CDN/i.test(plan.reason),
    "a PW CDN url must never be described as outside the PW CDN"
  );
  // The address is still handed back so the reader can try the source player.
  assert.equal(plan.sourceUrl, drm);
});

test("a DRM lecture is answered without touching the signer at all", async () => {
  // Every signer refuses a DRM folder (401/403), and a refused pass is retried
  // with a freshly minted token — so resolving one DRM lecture used to cost
  // two full host×rendition sweeps plus a token mint before saying what the
  // URL already proved. The answer must now be immediate and offline.
  const { resolveStream } = await import("../lib/api-data.mjs");
  let calls = 0;
  const plan = await withFetch(
    async () => {
      calls += 1;
      return new Response("nope", { status: 403 });
    },
    () =>
      resolveStream({
        rawUrl: "https://d1d34p8vz63oiq.cloudfront.net/drm/9a15c4a4-d53a-484a-b74d-992fbfaec6e4/master.mpd",
      })
  );
  assert.equal(plan.playable, false);
  assert.equal(plan.kind, "drm");
  assert.equal(calls, 0, `a DRM answer must not probe the signer (saw ${calls} fetches)`);
});

test("a rendition probe asks each signer pair exactly once", async () => {
  // Regression guard: the sweep once started every pair twice (an allSettled
  // bundle plus a per-pair loop), doubling signer traffic and earning
  // rate-limit refusals a single sweep would not have. Count distinct asks.
  const { resolveStream } = await import("../lib/api-data.mjs");
  const asked = [];
  const plan = await withFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("generate_token")) return new Response("guest-token-value-123456", { status: 200 });
      if (u.includes("get-hls-key")) {
        asked.push(u);
        return new Response("nope", { status: 404 });
      }
      return new Response("nope", { status: 404 });
    },
    () => resolveStream({ rawUrl: mpd("12345678-9abc-4def-8123-456789abcdef") })
  );
  assert.equal(plan.playable, false);
  assert.ok(asked.length > 0, "the probe never asked a signer");
  assert.equal(
    new Set(asked).size,
    asked.length,
    `each signer pair must be asked once, saw duplicates in ${asked.length} asks`
  );
});
