/**
 * Content audit — behaviour tests.
 *
 * The audit exists to answer "which lectures in this batch are broken, and why",
 * and its whole value is in the "why". A report that says "412 lectures not
 * playing" when 399 of them are simply not published yet is worse than no report:
 * it sends an operator hunting for a fault that does not exist.
 *
 * So these tests are mostly about classification, plus the two properties a
 * sweep needs to be trustworthy: one unreadable chapter must not end the batch,
 * and the report must never claim to have covered more than it did.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const BATCH = "698ad3519549b300a5e1cc6a";
const SUBJECT = "physics-by-rajwant-singh-sir-964222";

/** The upstream token endpoints all mint a token under some `generate_token` path. */
const TOKEN = /generate_token/;

const MASTER = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=792000,RESOLUTION=1280x720",
  "720/main.m3u8",
  "",
].join("\n");

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A whole upstream: batch details, one subject, two chapters, and a schedule
 * whose answers are decided per lecture id by the caller.
 */
function stubUpstream({ lectures, schedule }) {
  return async (input) => {
    const url = String(input);

    if (TOKEN.test(url)) return new Response("minted-token-abcdefghijklmnop", { status: 200 });

    if (/\/v3\/batches\/.*\/details|\/BatchInfo\?/.test(url)) {
      return json({ data: { _id: BATCH, name: "Arjuna JEE 2027", subjects: [{ subject: "Physics", slug: SUBJECT }] } });
    }

    if (/SubjectInfo\?/.test(url)) {
      // Careful with this shape: `upstreamJson` unwraps nothing, and
      // `fetchChapters` reads `res.data.data`, so the body must be
      // `{"data": [...]}`. One extra level and the chapter list is silently
      // empty — which is exactly how this stub first failed.
      return json({ data: [{ _id: "chapter-1", name: "Units", displayOrder: 1 }] });
    }

    // The contents listing the site itself uses: `contentType` + `tag`, with the
    // rows under `questions` and the title under `videoDetails.name`.
    if (/contentType=videos/.test(url)) {
      // Both readers parse `res.data.data` out of the *same* `{"data": [...]}`
      // envelope (verified against the live API), so do not nest it twice.
      return json({
        data: lectures.map((l) => ({
          _id: l.id,
          topic: l.title,
          videoDetails: { name: l.title, status: "Ready" },
        })),
      });
    }

    if (/schedule-details|\/Schedule\?/.test(url)) {
      const id = url.match(/schedule\/([^/?]+)\/schedule-details/)?.[1] || url.match(/ContentId=([^&]+)/)?.[1];
      const answer = schedule[id] || {};
      return json({
        data: {
          _id: id,
          topic: answer.title || id,
          videoDetails: {
            name: answer.title || id,
            videoUrl: answer.videoUrl || "",
            status: answer.status || "Ready",
          },
        },
      });
    }

    if (/get-hls-key/.test(url)) {
      return new Response(MASTER, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }

    return json({}, 404);
  };
}

test("a lecture with a working stream is reported as playing", async () => {
  const { auditLecture } = await import("../lib/audit.mjs");

  const lecture = await withFetch(
    stubUpstream({
      lectures: [],
      schedule: { lec1: { title: "Units 01", videoUrl: "https://d1d34p8vz63oiq.cloudfront.net/11111111-2222-4333-8444-555555555555/master.mpd" } },
    }),
    () => auditLecture({ batch: BATCH, subject: SUBJECT, id: "lec1" })
  );

  assert.equal(lecture.state, "plays", `expected plays, got ${lecture.state}: ${lecture.detail}`);
  // The start point is mid-ladder by design (see `pickStartPoint`); what the
  // audit reports is that the ladder resolved and which rung it would open on.
  assert.ok(lecture.quality, "a playing lecture must report the quality it starts on");
  assert.ok(lecture.renditions.includes("720"), `720 was not in the ladder: ${lecture.renditions}`);
});

test("a lecture the source has not published is pending, not broken", async () => {
  // The distinction that makes the whole report usable. A live class that has
  // not been recorded yet is not a fault, and reporting it as one is how an
  // operator learns to ignore the panel.
  const { auditLecture } = await import("../lib/audit.mjs");

  const lecture = await withFetch(
    stubUpstream({ lectures: [], schedule: { lec2: { title: "Live class", videoUrl: "", status: "Not Ready" } } }),
    () => auditLecture({ batch: BATCH, subject: SUBJECT, id: "lec2" })
  );

  assert.equal(lecture.state, "pending");
  assert.equal(lecture.hasVideoUrl, false);
  // The reason must survive into the row, or the state is just a colour.
  assert.match(lecture.detail, /not published|live|recording/i, `unhelpful detail: ${lecture.detail}`);
});

test("a video URL that no signer will serve is no-stream, not pending", async () => {
  // The lecture exists and the schedule carries its URL; what failed is signing.
  // That is a credential or a mirror fault, and an operator can chase it.
  const { auditLecture } = await import("../lib/audit.mjs");

  const lecture = await withFetch(
    async (input) => {
      const url = String(input);
      if (TOKEN.test(url)) return new Response("minted-token-abcdefghijklmnop", { status: 200 });
      if (/get-hls-key/.test(url)) return new Response("Forbidden", { status: 403 });
      if (/schedule-details|\/Schedule\?/.test(url)) {
        return json({
          data: {
            _id: "lec3",
            videoDetails: {
              name: "Units 03",
              videoUrl: "https://d1d34p8vz63oiq.cloudfront.net/33333333-2222-4333-8444-555555555555/master.mpd",
              status: "Ready",
            },
          },
        });
      }
      return json({}, 404);
    },
    () => auditLecture({ batch: BATCH, subject: SUBJECT, id: "lec3" })
  );

  assert.equal(lecture.state, "no-stream", `got ${lecture.state}: ${lecture.detail}`);
  assert.equal(lecture.hasVideoUrl, true, "the report must show that a URL was there");
  assert.ok(lecture.detail.length > 0, "a no-stream verdict with no reason is a dead end");
});

test("one unreadable chapter does not end the batch", async () => {
  // A sweep is the one place where throwing is unacceptable: the chapter that
  // failed would hide every chapter after it.
  const { auditBatch } = await import("../lib/audit.mjs");

  const report = await withFetch(
    async (input) => {
      const url = String(input);
      if (/\/v3\/batches\/.*\/details|\/BatchInfo\?/.test(url)) {
        return json({ data: { _id: BATCH, name: "Arjuna", subjects: [{ subject: "Physics", slug: SUBJECT }] } });
      }
      if (/SubjectInfo\?/.test(url)) {
        // Two chapters: the first one's listing is refused, the second works.
        return json({
          data: [
            { _id: "bad-chapter", name: "Broken", displayOrder: 1 },
            { _id: "good-chapter", name: "Good", displayOrder: 2 },
          ],
        });
      }
      // Anchor the tag: `/tag=bad-chapter/` would also match `tag=good-chapter`
      // once the URL is compared loosely, and the "working" chapter would then
      // be answered with the failure.
      if (/[?&]tag=bad-chapter(&|$)/.test(url)) return new Response("nope", { status: 500 });
      if (/[?&]tag=good-chapter(&|$)/.test(url)) {
        // Same envelope the live API uses: `{"data": [ { _id, videoDetails } ]}`.
        return json({ data: [{ _id: "lec9", topic: "Units 09", videoDetails: { name: "Units 09" } }] });
      }
      if (TOKEN.test(url)) return new Response("minted-token-abcdefghijklmnop", { status: 200 });
      if (/schedule-details|\/Schedule\?/.test(url)) {
        return json({
          data: {
            _id: "lec9",
            videoDetails: {
              name: "Units 09",
              videoUrl: "https://d1d34p8vz63oiq.cloudfront.net/99999999-2222-4333-8444-555555555555/master.mpd",
            },
          },
        });
      }
      if (/get-hls-key/.test(url)) return new Response(MASTER, { status: 200 });
      return json({}, 404);
    },
    () => auditBatch({ batch: BATCH, limit: 10 })
  );

  assert.equal(report.ok, true);
  assert.equal(report.totals.lectures, 1, "the working chapter was not audited");
  assert.equal(report.totals.plays, 1);
  assert.ok(
    report.notes.some((n) => /bad-chapter|nope|500/.test(n)),
    `the failed chapter vanished from the report: ${JSON.stringify(report.notes)}`
  );
});

test("the report never claims to have covered more than it did", async () => {
  const { auditBatch } = await import("../lib/audit.mjs");

  const many = Array.from({ length: 8 }, (_, i) => ({ id: `lec${i}`, title: `Units 0${i}` }));
  const schedule = Object.fromEntries(
    many.map((l) => [l.id, { title: l.title, videoUrl: "", status: "Ready" }])
  );

  const report = await withFetch(
    stubUpstream({ lectures: many, schedule }),
    () => auditBatch({ batch: BATCH, limit: 3 })
  );

  assert.equal(report.totals.lectures, 3, "the limit was not honoured");
  assert.equal(report.truncated, true, "a partial sweep must say that it is partial");
  assert.ok(
    report.notes.some((n) => /limit 3/i.test(n)),
    `nothing in the report explains the truncation: ${JSON.stringify(report.notes)}`
  );
});

test("the headline separates pending work from real faults", async () => {
  const { auditHeadline } = await import("../lib/audit.mjs");

  const line = auditHeadline({
    ok: true,
    totals: { lectures: 400, plays: 387, pending: 12, "no-stream": 1, broken: 0, unknown: 0 },
  });

  assert.match(line, /387\/400 playing/);
  assert.match(line, /12 not published/);
  assert.match(line, /1 refused/);
  // A reader must be able to tell 12 acceptable from 1 actionable.
  assert.equal(/12 refused/.test(line), false);
});
