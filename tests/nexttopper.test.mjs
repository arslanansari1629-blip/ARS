/**
 * The Next Toppers platform: a folder-tree app on the Nexthope
 * backend (discovered live via view=raw): POST all-courses /
 * course-details / all-content under /nexttopper/api, leaves typed
 * by file_type (3 folder, 5 test, 1 PDF, video otherwise).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  nextTopperApi,
  normalizeNtCourse,
  normalizeNtItem,
  ntProxyAllowed,
  resetNtCache,
  rewriteNtPlaylist,
  splitNtCourseId,
} from "../lib/nexttopper.mjs";

function fakeRes() {
  const headers = {};
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  return {
    statusCode: 200,
    headers,
    text: () => Buffer.concat(chunks).toString("utf8"),
    setHeader(k, v) {
      headers[String(k).toLowerCase()] = String(v);
    },
    getHeader(k) {
      return headers[String(k).toLowerCase()];
    },
    write(c) {
      if (c) chunks.push(Buffer.from(c));
      return true;
    },
    end(c) {
      if (c) chunks.push(Buffer.from(c));
      finished();
    },
    done,
  };
}

async function call(params) {
  const res = fakeRes();
  await nextTopperApi({ method: "GET", url: "/api/nexttopper", headers: {} }, res, params);
  await res.done;
  return { status: res.statusCode, body: JSON.parse(res.text()) };
}

test("course ids split the -p<parent> form like their content page", () => {
  assert.deepEqual(splitNtCourseId("176"), { id: "176", parent: "1" });
  assert.deepEqual(splitNtCourseId("176-p42"), { id: "176", parent: "42" });
});

test("a course row normalises with a class read off its title", () => {
  const c = normalizeNtCourse({ id: 176, title: "10TH ABHAY BATCH 2027", thumbnail: "https://d.cloudfront.net/x.png" });
  assert.equal(c.id, "176");
  assert.equal(c.class, "Class 10");
  assert.equal(normalizeNtCourse({ id: 9, title: "CUET (Science)" }).class, "CUET");
  assert.equal(normalizeNtCourse({ title: "no id" }), null);
});

test("content leaves are typed the way their own parser types them", () => {
  const folder = normalizeNtItem({ id: 1, title: "Physics", file_type: 3, data: { content_counts: { video: { paid: 4, free: 1 } } } });
  assert.equal(folder.kind, "folder");
  assert.equal(folder.counts.videos, 5);
  assert.equal(normalizeNtItem({ id: 2, title: "Notes", file_type: 1 }).kind, "pdf");
  assert.equal(normalizeNtItem({ entity_id: 3, test_name: "Mock 1" }).kind, "test");
  const vid = normalizeNtItem({ id: 4, title: "Lec 1", data: { file_url: "https://d.cloudfront.net/a.m3u8", duration: "42:10" } });
  assert.equal(vid.kind, "video");
  assert.equal(vid.fileUrl, "https://d.cloudfront.net/a.m3u8");
  assert.equal(normalizeNtItem({ name: "no id anywhere" }), null);
});

test("batches view reads the course_list_layout list through a POST", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      url,
      text: async () =>
        JSON.stringify({
          data: [
            { layout_type: "banner_layout", list: [] },
            { layout_type: "course_list_layout", list: [{ id: 176, title: "10TH ABHAY BATCH 2027", thumbnail: "https://d.cloudfront.net/t.png" }] },
          ],
        }),
    };
  };
  try {
    resetNtCache();
    const out = await call({ view: "batches" });
    assert.equal(out.status, 200);
    assert.equal(out.body.success, true);
    assert.equal(out.body.total, 1);
    assert.equal(out.body.items[0].class, "Class 10");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/nexttopper\/api\/all-courses$/);
    assert.equal(calls[0].body.limit, "100");
  } finally {
    globalThis.fetch = realFetch;
    resetNtCache();
  }
});

test("batches view merges batches_latest.json — where course 176 lives — ahead of the API subset", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const jsonRes = (obj) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      url: u,
      text: async () => JSON.stringify(obj),
    });
    if (u.includes("batches_latest.json"))
      return jsonRes({ new: [{ id: 176, title: "AARAMBH 2.0 10th BATCH 26-27", thumbnail: "https://d.cloudfront.net/a.png" }], old: [] });
    if (u.includes("batches.json")) return jsonRes({ new: [{ id: 62, title: "AARAMBH 2.0 10TH BATCH 2025-26" }] });
    // the all-courses POST: a subset that does NOT know 176
    return jsonRes({ data: [{ layout_type: "course_list_layout", list: [{ id: 264, title: "10TH ABHAY BATCH 2027" }] }] });
  };
  try {
    resetNtCache();
    const out = await call({ view: "batches" });
    assert.equal(out.body.success, true);
    const ids = out.body.items.map((c) => c.id);
    assert.deepEqual(ids, ["176", "264", "62"]);
    assert.equal(out.body.items[0].class, "Class 10");
    assert.equal(out.body.items[2].archive, true);
  } finally {
    globalThis.fetch = realFetch;
    resetNtCache();
  }
});

test("content view reports a truly empty folder as empty, not an error to retry", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify({ data: [] }),
  });
  try {
    resetNtCache();
    const out = await call({ view: "content", course: "176", folder: "0" });
    assert.equal(out.body.success, false);
    assert.equal(out.body.empty, true);
  } finally {
    globalThis.fetch = realFetch;
    resetNtCache();
  }
});

test("play view sorts hls / mp4 / youtube / vdc honestly", async () => {
  const hls = await call({ view: "play", file: "https://d123.cloudfront.net/x/index.m3u8" });
  assert.equal(hls.body.kind, "hls");
  assert.match(hls.body.proxyUrl, /view=playlist/);
  const yt = await call({ view: "play", file: "https://www.youtube.com/watch?v=abcdefghijk" });
  assert.equal(yt.body.kind, "youtube");
  // A vdc leaf resolves through GET /api/vc?<id> to a plain HLS file.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/nexttopper\/api\/vc\?4812015_0_1$/);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ success: true, data: { data: { link: { file_url: "https://dbil.cloudfront.net/v/4812015/x.m3u8", token: "" } } } }),
    };
  };
  try {
    const vdc = await call({ view: "play", file: "", vdc: "4812015_0_1" });
    assert.equal(vdc.body.success, true);
    assert.equal(vdc.body.kind, "hls");
    assert.equal(vdc.body.via, "vc");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("playlist rewrite recurses playlists and relays binaries", () => {
  const out = rewriteNtPlaylist(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg1.ts\nvariant.m3u8\n',
    "https://d123.cloudfront.net/x/index.m3u8"
  );
  assert.match(out, /URI="\/api\/media\?url=[^"]*key\.bin/);
  assert.match(out, /\/api\/nexttopper\?view=playlist&u=[^\n]*variant\.m3u8/);
  assert.equal(ntProxyAllowed("https://d123.cloudfront.net/x.m3u8"), true);
  assert.equal(ntProxyAllowed("https://evil.example/x.m3u8"), false);
  assert.equal(ntProxyAllowed("http://d123.cloudfront.net/x.m3u8"), false);
});

test("the raw probe refuses to wander off the NT tree", async () => {
  const out = await call({ view: "raw", path: "/Allen/batches.json" });
  assert.equal(out.body.success, false);
});

test("the /nexttopper page carries the catalogue + player contract", async () => {
  const page = await readFile(new URL("../public/nexttopper.html", import.meta.url), "utf8");
  for (const id of ["ntGrid", "ntSearch", "ntClassChips", "ntContent", "ntCrumbs", "ntVideo"]) {
    assert.match(page, new RegExp(`id="${id}"`), `#${id} is missing`);
  }
  assert.match(page, /\/assets\/platforms\/next-toppers\.jpg/, "NT logo must be the local asset");
  const js = await readFile(new URL("../public/assets/nexttopper.js", import.meta.url), "utf8");
  assert.match(js, /view=batches/, "catalogue wiring missing");
  assert.match(js, /view=content/, "folder wiring missing");
  assert.match(js, /view=play/, "play wiring missing");
});
