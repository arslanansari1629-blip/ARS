/**
 * The Allen platform: its own catalogue, its own bt_/cr_ ids, never
 * the PW shapes. The upstream routes are the ones Nexthope's own
 * Allen pages call (discovered live): /Allen/batches.json,
 * /Allen/api/subjects|topics|contents, and /api/token play URLs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeAllenBatch,
  normalizeAllenLecture,
  normalizeAllenSubject,
  normalizeAllenTopic,
  resetAllenCache,
} from "../lib/allen.mjs";

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
    body: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("utf8"),
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
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

async function callBatches(query) {
  const { default: handler } = await import("../api/batches.mjs");
  const res = fakeRes();
  await handler({ method: "GET", url: `/api/batches?${query}`, headers: {} }, res);
  await res.done;
  return { status: res.statusCode, json: async () => JSON.parse(res.text()) };
}

test("a Nexthope batches.json row normalises to code/ids/exam", () => {
  const out = normalizeAllenBatch({
    batch_id: "bt_TgS6lWQF1S9ESPIh1BCOf",
    batch_name: "D6TL-36-DILC21",
    course_id: "cr_LylAze94OqLyj641cXJTA",
    course_name: "JEE (MAIN + ADVANCED) LEADER ENGLISH",
    class: "Class 12 Plus",
    stream: "JEE Advanced",
    batch_status: "LIVE",
  });
  assert.equal(out.code, "D6TL-36-DILC21");
  assert.equal(out.batchId, "bt_TgS6lWQF1S9ESPIh1BCOf");
  assert.equal(out.courseId, "cr_LylAze94OqLyj641cXJTA");
  assert.equal(out.exam, "JEE Advanced");
  const neet = normalizeAllenBatch({
    batch_id: "bt_Kf1IzzyNFJiF0eubGsbd0",
    batch_name: "X1ME-1AP-RMGAJ",
    course_name: "PRE-MEDICAL ENTHUSIAST ENGLISH",
    stream: "NEET",
  });
  assert.equal(neet.exam, "NEET");
});

test("PW catalogue rows can never pass as Allen batches", () => {
  // Nexthope's shared API answers its PW catalogue under /Allen/api/*
  // too (live: 17,302 PW rows). No bt_ id, no Allen batch — the one
  // failure this section must never ship.
  assert.equal(normalizeAllenBatch({ name: "Lakshya JEE 2025", batch_id: "65d862392b1da90018ad8f3b", batch_name: "Lakshya" }), null);
  assert.equal(normalizeAllenBatch({ batch_id: "bt_x", batch_name: "65d862392b1da90018ad8f3b" }), null);
  assert.equal(normalizeAllenBatch({ batch_name: "D6TL-36-DILC21" }), null, "a code without its bt_ id cannot be opened");
});

test("Allen subject, topic and lecture rows normalise from upstream variants", () => {
  const s = normalizeAllenSubject({ subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" });
  assert.equal(s.id, "984");
  assert.equal(s.taxonomyId, "1763385325sj");
  const t = normalizeAllenTopic({ topic_id: "1295", name: "Chemistry In Everyday Life", order: 1, videos_count: 3 });
  assert.equal(t.id, "1295");
  const lec = normalizeAllenLecture({
    content_id: "79b3a1ac-bec7-4780-b5c6-e06bb8c76ec7",
    title: "CSD CHEMISTRY DARPAN 304",
    duration: "77:00",
    play_url: "/api/token?token=abc&media=1",
  });
  assert.equal(lec.title, "CSD CHEMISTRY DARPAN 304");
  assert.match(lec.playUrl, /^https:\/\/stream\.nexthope\.sbs\/api\/token\?token=abc/, "play_url must be made absolute against the Allen upstream");
});

test("/api/allen serves batches, subjects and lectures from the real upstream routes", async () => {
  resetAllenCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const u = String(url);
    if (u.includes("/Allen/batches.json")) {
      return new Response(
        JSON.stringify([
          {
            batch_id: "bt_TgS6lWQF1S9ESPIh1BCOf",
            batch_name: "D6TL-36-DILC21",
            course_id: "cr_LylAze94OqLyj641cXJTA",
            course_name: "JEE (MAIN + ADVANCED) LEADER ENGLISH",
            stream: "JEE Advanced",
            class: "Class 12 Plus",
            batch_status: "LIVE",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/Allen/api/subjects")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            { subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" },
            { subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/Allen/api/contents")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ content_id: "lec-1", title: "Darpan 304", duration: "77:00", play_url: "/api/token?token=t1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const batches = await callBatches("action=allen&view=batches");
    assert.equal(batches.status, 200);
    const bbody = await batches.json();
    assert.equal(bbody.items[0].code, "D6TL-36-DILC21");

    const subjects = await callBatches("action=allen&view=subjects&batch=bt_TgS6lWQF1S9ESPIh1BCOf&course=cr_LylAze94OqLyj641cXJTA");
    const sbody = await subjects.json();
    assert.equal(sbody.items.length, 1, "the upstream's enrolled+curriculum duplicates must collapse to one card");

    const lectures = await callBatches(
      "action=allen&view=lectures&batch=bt_TgS6lWQF1S9ESPIh1BCOf&course=cr_LylAze94OqLyj641cXJTA&subject=984&taxonomy=1763385325sj&topic=1295"
    );
    const lbody = await lectures.json();
    assert.equal(lbody.items[0].id, "lec-1");
    assert.match(lbody.items[0].playUrl, /\/api\/token\?token=t1/);
    assert.ok(seen.some((x) => x.includes("nexthope.sbs/Allen/api/contents")), "lectures must come from the contents route");
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/allen without a batch id answers a useful 400, never a crash", async () => {
  const res = await callBatches("action=allen&view=subjects");
  assert.equal(res.status, 400);
});

test("the Allen page, route aliases and scanner contract are wired", async () => {
  const page = await readFile(new URL("../public/allen.html", import.meta.url), "utf8");
  assert.match(page, /id="allenGrid"/);
  assert.match(page, /id="allenSearch"/);
  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  assert.match(script, /\/api\/allen\?view=batches/, "the page must read its own API, not Nexthope directly");
  assert.ok(!/nexthope/i.test(script), "the browser must never hardcode the upstream host");
  const scanner = await readFile(new URL("../lib/scanner.mjs", import.meta.url), "utf8");
  assert.match(scanner, /"allen\.html"/, "the scanner would never notice a broken Allen page");
  const worker = await readFile(new URL("../functions/api/[[route]].js", import.meta.url), "utf8");
  assert.match(worker, /allen: \["batches", "allen"\]/, "the Worker would 404 /api/allen");
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok((vercel.rewrites || []).some((r) => r.source === "/api/allen"), "Vercel would 404 /api/allen");
});
