/**
 * The Allen platform: its own catalogue, its own codes, never the PW
 * shapes. The upstream route names are discovered, not documented,
 * so the client walks candidates — these tests pin that walk, the
 * normalisation, and the route wiring that keeps /allen alive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ALLEN_CANDIDATES,
  normalizeAllenBatch,
  normalizeAllenLecture,
  normalizeAllenSubject,
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

async function callBatches(query, headers = {}) {
  const { default: handler } = await import("../api/batches.mjs");
  const res = fakeRes();
  await handler(
    { method: "GET", url: `/api/batches?${query}`, headers },
    res
  );
  await res.done;
  return { status: res.statusCode, json: async () => JSON.parse(res.text()) };
}

test("Allen batch candidates cover the likely upstream route names", () => {
  assert.ok(ALLEN_CANDIDATES.batches.length >= 8, "too few batch route candidates to survive a renamed upstream");
  assert.ok(ALLEN_CANDIDATES.batches.some((p) => p.includes("allen")));
});

test("a Nexthope-shaped Allen card normalises to code/exam/class", () => {
  const out = normalizeAllenBatch({ name: "Leader JEE Advanced 12+", code: "D6TL-36-DILC21", class: "Class 12 Plus" });
  assert.equal(out.code, "D6TL-36-DILC21");
  assert.equal(out.exam, "JEE Advanced");
  assert.equal(out.class, "Class 12 Plus");
  const neet = normalizeAllenBatch({ name: "Pre-Medical Enthusiast", id: "X1ME-1AP-RMGAJ" });
  assert.equal(neet.exam, "NEET", 'a "Pre-Medical" batch must land under NEET, not JEE');
  assert.equal(normalizeAllenBatch({ name: "No code here" }), null, "a batch without a code is unopenable and must drop");
});

test("Allen subject and lecture rows normalise from upstream variants", () => {
  assert.equal(normalizeAllenSubject({ title: "Physics", videos: 42 }).name, "Physics");
  assert.equal(normalizeAllenSubject({ title: "Physics", videos: 42 }).lectures, 42);
  const lec = normalizeAllenLecture({ title: "Rotational Mechanics 1", videoId: "abc" });
  assert.equal(lec.title, "Rotational Mechanics 1");
  assert.equal(lec.id, "abc");
});

test("/api/allen serves batches from the first working upstream candidate", async () => {
  resetAllenCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/api/allen/batches")) {
      return new Response(
        JSON.stringify({
          success: true,
          batches: [{ name: "Nurture JEE", code: "8QTN-1A-49TN1", class: "Class 11" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const res = await callBatches("action=allen&view=batches");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.items[0].code, "8QTN-1A-49TN1");
    assert.equal(body.items[0].exam, "JEE Advanced");
    assert.ok(seen.some((u) => u.includes("nexthope.sbs")), "the Allen section must actually ask Nexthope's backend");
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/allen without a code answers a useful 400, never a crash", async () => {
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
  assert.ok(
    (vercel.rewrites || []).some((r) => r.source === "/api/allen"),
    "Vercel would 404 /api/allen"
  );
});
