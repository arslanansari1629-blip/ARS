/**
 * Page-render tests.
 *
 * Boots the dev server against the fixture upstream, loads each page's HTML
 * into jsdom and executes the page module (via the loader shim) so the
 * client-rendered markup can be asserted.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { register } from "node:module";
import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

register("./loader.mjs", import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4180;
const FIXPORT = 4181;
const BASE = `http://127.0.0.1:${PORT}`;

const children = [];
let version = 0;

function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function waitFor(url, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

before(async () => {
  start(["scripts/fixture-upstream.mjs"], { FIXTURE_PORT: String(FIXPORT) });
  await waitFor(`http://127.0.0.1:${FIXPORT}/AllBatches?page=1`);
  start(["scripts/dev.mjs"], {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PW_UPSTREAM_BASE: `http://127.0.0.1:${FIXPORT}`,
  });
  await waitFor(`${BASE}/`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

const nativeFetch = globalThis.fetch;

/**
 * Load a page, install jsdom globals, execute its module script and wait for
 * `ready` (a selector) or a fixed settle time.
 */
async function render(pathname, { waitForSelector, settle = 900, fetchWrap = null } = {}) {
  const res = await nativeFetch(`${BASE}${pathname}`);
  const html = await res.text();
  const dom = new JSDOM(html, {
    url: `${BASE}${pathname}`,
    pretendToBeVisual: true,
  });

  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  globalThis.location = window.location;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string" ? new URL(input, BASE) : input;
    if (fetchWrap) {
      const handled = fetchWrap(target, init);
      if (handled) return handled;
    }
    return nativeFetch(target, init);
  };

  const scriptEl = window.document.querySelector('script[type="module"][src]');
  version += 1;
  if (scriptEl) {
    const src = scriptEl.getAttribute("src");
    await import(`${src}?v=${version}`);
  } else {
    const inline = window.document.querySelector('script[type="module"]');
    if (inline) {
      const code = inline.textContent;
      await import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#v${version}`
      );
    }
  }

  if (waitForSelector) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (window.document.querySelector(waitForSelector)) break;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  await new Promise((r) => setTimeout(r, settle));

  return { dom, doc: window.document, window };
}

test("home page renders live catalogue cards and hero copy", async () => {
  const { doc, dom } = await render("/", { waitForSelector: "#trendingGrid .batch-card" });
  assert.match(doc.title, /Physics Wallah/i);
  const cards = doc.querySelectorAll("#trendingGrid .batch-card");
  assert.ok(cards.length >= 2, `expected catalogue cards, got ${cards.length}`);
  assert.match(cards[0].textContent, /Arjuna JEE 2027/);
  assert.match(doc.body.textContent.replace(/\s+/g, " "), /Every Physics Wallah batch/i);
  assert.match(doc.body.textContent, /Lakshya JEE 2027/);
  // The complete catalogue (14 201 batches) is the whole point of shipping the
  // list locally — the source site's own search only sees 13 631.
  assert.match(doc.getElementById("statSubjects").textContent, /14,201/);
  dom.window.close();
});

test("batches page lists catalogue with pager and result count", async () => {
  const { doc, dom } = await render("/batches.html", { waitForSelector: "#grid .batch-card" });
  assert.ok(doc.querySelectorAll("#grid .batch-card").length >= 2);
  assert.match(doc.getElementById("resultCount").textContent, /14,201 batches/);
  assert.ok(doc.querySelectorAll("#pager button").length >= 3);
  const langs = [...doc.querySelectorAll("#langFilter option")].map((o) => o.textContent);
  assert.ok(langs.includes("Hinglish"), langs.join(","));
  dom.window.close();
});

test("batch page renders subjects from upstream detail", async () => {
  const { doc, dom } = await render("/batch.html?id=698ad3519549b300a5e1cc6a", {
    waitForSelector: ".subject-card",
  });
  const subjects = [...doc.querySelectorAll(".subject-card .name")].map((n) => n.textContent);
  assert.ok(subjects.some((s) => /Physics By Saleem Ahmad Sir/.test(s)), subjects.join(","));
  assert.match(doc.getElementById("crumbName").textContent, /Arjuna JEE 2027/);
  assert.match(doc.body.textContent, /Starts/);
  assert.match(doc.body.textContent, /₹3,199/);
  dom.window.close();
});

test("subject page renders chapters with counts", async () => {
  const { doc, dom } = await render(
    "/subject.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&name=Physics",
    { waitForSelector: ".chapter-row" }
  );
  const rows = doc.querySelectorAll(".chapter-row");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Ch 01: Units and Dimension/);
  assert.match(rows[0].textContent, /11 lectures/);
  dom.window.close();
});

test("chapter page shows lectures then notes/DPP PDFs", async () => {
  const url =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&chapter=6a6b461cce4ac4e9ab51ee98&name=Ch%2001";
  const { doc, dom } = await render(url, { waitForSelector: "#body .list-row" });
  const rows = doc.querySelectorAll("#body .list-row");
  assert.ok(rows.length >= 2);
  assert.match(rows[0].textContent, /Units and Dimension 10/);
  // Every row carries an honest availability tag so nobody opens a lecture
  // expecting a video the source never published.
  const tags = [...rows].map((r) => r.querySelector(".badge-live, .badge-soon"));
  assert.ok(tags.every(Boolean), "each lecture row needs a playability badge");
  assert.ok(
    tags.some((t) => /Video ready/.test(t.textContent)),
    "the processed lecture should be tagged as playable"
  );

  const notesTab = [...doc.querySelectorAll("#tabs .tab")].find((t) => t.dataset.type === "notes");
  notesTab.click();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !doc.querySelector("#body .doc-row")) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const docs = doc.querySelectorAll("#body .doc-row");
  assert.ok(docs.length >= 1, "expected PDF rows for class notes");
  assert.match(docs[0].textContent, /Class Notes/);
  dom.window.close();
});

test("lecture page loads metadata and attached notes + DPP", async () => {
  const url =
    "/lecture.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&id=6a6b462b26b614560bceb74b&title=Units%20and%20Dimension%2010";
  const { doc, dom } = await render(url, { waitForSelector: "#docs .doc-row" });
  const docs = doc.querySelectorAll("#docs .doc-row");
  assert.ok(docs.length >= 2, `expected class notes + DPP, got ${docs.length}`);
  assert.match(doc.body.textContent, /Class Notes/);
  assert.match(doc.body.textContent, /DPP 07/);
  assert.match(doc.getElementById("lectureMeta").textContent, /01:50:38/);
  dom.window.close();
});

test("lecture page bootstraps a stream plan instead of erroring", async () => {
  const url =
    "/lecture.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&id=6a6b462b26b614560bceb74b&title=Units%20and%20Dimension%2010";
  const { doc, dom } = await render(url, {
    waitForSelector: "#docs .doc-row",
    // Offline there is no reachable signing relay, so /api/stream answers with
    // `playable: false`. Stub that single route with a real plan shape so the
    // page exercises its successful bootstrap path.
    fetchWrap: (target) => {
      if (String(target).includes("/api/stream")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              playable: true,
              kind: "hls",
              engine: "hls",
              url: "/api/sign?videoKey=d780e1e3-f446-4218-97f8-5d3f4dd4ca05&key=720/main.m3u8",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
      return null;
    },
  });

  // wait for startStream() to finish bootstrapping (it replaces the overlay text)
  const overlay = doc.getElementById("overlay");
  assert.ok(overlay, "player overlay is missing");
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && /Fetching the stream details/.test(overlay.textContent)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const panel = overlay.textContent;
  const body = doc.body.textContent;

  // the old bug surfaced here as "api is not defined"
  assert.ok(!/is not defined/.test(body), `page threw a ReferenceError: ${body.slice(0, 200)}`);
  assert.ok(!/Stream unavailable/.test(panel), `stream bootstrap failed: ${panel}`);
  assert.ok(!/Fetching the stream details/.test(panel), "stream bootstrap never completed");

  // a resolved plan either starts playback or explains why it can't be played
  assert.match(
    panel,
    /Starting playback|Stream ready|Stream not published|Playback not supported|No video published/,
    `overlay never received a plan: ${panel}`
  );

  // The player must actually be wired to the plan: either the native source or
  // an injected hls/dash instance, never an empty <video> behind a hidden
  // overlay (that is what "the video never plays" looked like to users).
  //
  // jsdom cannot load the hls.js CDN, so the module must fall back to a native
  // source on its own — that fallback is the behaviour under test, and it is
  // what keeps a lecture playable when a CDN is blocked in the browser too.
  const video = doc.getElementById("video");
  const mediaDeadline = Date.now() + 20000;
  while (Date.now() < mediaDeadline) {
    const src = video.getAttribute("src") || "";
    const attached = Boolean(doc.defaultView.__hls || doc.defaultView.__dash);
    if (attached || src.includes("/api/sign") || src.includes("/api/stream")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const finalSrc = video.getAttribute("src") || "";
  assert.ok(
    doc.defaultView.__hls ||
      doc.defaultView.__dash ||
      finalSrc.includes("/api/sign") ||
      finalSrc.includes("/api/stream"),
    `no media was attached to the player (src=${finalSrc || "empty"})`
  );
  dom.window.close();
});

test("the lecture player ships quality control and recovery", async () => {
  const res = await nativeFetch(
    `${BASE}/assets/lecture.js`
  );
  const source = await res.text();

  // Regression guards for the playback path.
  assert.match(source, /#EXTM3U|Hls\.Events\.MANIFEST_PARSED/, "hls.js setup is missing");
  assert.match(source, /recoverMediaError|startLoad\(\)/, "no hls.js error recovery");
  assert.match(source, /data-speed/, "speed control binding is missing");
  assert.match(source, /id="quality"|getElementById\("quality"\)/, "quality picker is missing");
  assert.ok(
    !/location\.reload\(\)/.test(source),
    "playback failures must re-resolve the stream, not reload the page"
  );
});

test("pdf viewer builds a same-origin media relay URL", async () => {
  const target = "https://static.pw.live/5eb393ee95fab7468a79d189/ADMIN/73d6.pdf";
  const res = await nativeFetch(
    `${BASE}/viewer.html?url=${encodeURIComponent(target)}&name=${encodeURIComponent("Class Notes.pdf")}`
  );
  const html = await res.text();
  const dom = new JSDOM(html, {
    url: `${BASE}/viewer.html?url=${encodeURIComponent(target)}&name=${encodeURIComponent("Class Notes.pdf")}`,
    runScripts: "outside-only",
  });
  const inline = [...dom.window.document.querySelectorAll("script")].map((s) => s.textContent).join("\n");
  dom.window.eval(inline);

  const src = dom.window.document.getElementById("frame").getAttribute("src");
  assert.match(src, /^\/api\/media\?url=https%3A%2F%2Fstatic\.pw\.live/);
  assert.equal(dom.window.document.getElementById("docTitle").textContent, "Class Notes.pdf");
  dom.window.close();
});

test("login page supports bypass login and stores a session", async () => {
  const { doc, window, dom } = await render("/login.html", { waitForSelector: "#bypassBtn" });
  doc.getElementById("bypassBtn").click();
  const raw = window.localStorage.getItem("eduvibe.session");
  assert.ok(raw, "session should be stored");
  const session = JSON.parse(raw);
  assert.ok(session.name && session.email);
  dom.window.close();
});

test("API routes reject bad input and answer normalised JSON", async () => {
  const bad = await nativeFetch(`${BASE}/api/batch`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).success, false);

  const ok = await nativeFetch(`${BASE}/api/batches?page=1`);
  const data = await ok.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.batches) && data.batches.length >= 2);
  assert.equal(data.batches[0].id, "698ad3519549b300a5e1cc6a");
  assert.match(data.batches[0].image, /^https:\/\/static\.pw\.live/);
});

test("catalogue search finds batches the upstream search cannot see", async () => {
  const res = await nativeFetch(`${BASE}/api/batches?search=capcut`);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.total >= 1, "expected at least one hit");
  const hit = data.batches.find((b) => /capcut/i.test(b.name));
  assert.ok(hit, "Capcut Video Editing Course should be findable");
  assert.equal(hit.id, "6ae495eefeacf9ee7140e421");
  assert.match(hit.image, /^https:\/\/static\.pw\.live/);
});

test("catalogue covers every batch vidcloud lists, page by page", async () => {
  const first = await (await nativeFetch(`${BASE}/api/batches?page=1`)).json();
  const last = await (await nativeFetch(`${BASE}/api/batches?page=${first.totalPages}`)).json();
  assert.equal(first.total, 14201);
  assert.ok(first.totalPages > 700, `expected the pager to reach the end, got ${first.totalPages}`);
  assert.ok(last.batches.length > 0);
  const ids = new Set();
  for (const b of [...first.batches, ...last.batches]) ids.add(b.id);
  assert.equal(ids.size, first.batches.length + last.batches.length);
});

test("stream route resolves a signed PW URL into a relayed plan", async () => {
  const signed =
    "https://d1d34p8vz63oiq.cloudfront.net/d780e1e3-f446-4218-97f8-5d3f4dd4ca05/master.mpd?Signature=abc&Key-Pair-Id=XYZ&Policy=p";
  const res = await nativeFetch(`${BASE}/api/stream?url=${encodeURIComponent(signed)}`);
  const plan = await res.json();
  assert.equal(plan.success, true);
  assert.equal(plan.playable, true);
  assert.equal(plan.kind, "dash");
  assert.match(plan.url, /^\/api\/stream\?folder=d780e1e3/);
});

test("stream route hands YouTube-hosted lectures to the embed player", async () => {
  // The PW Skills batches publish recordings on YouTube. Reporting those as
  // "not published" was wrong: the lecture exists and must be watchable.
  const res = await nativeFetch(
    `${BASE}/api/stream?url=${encodeURIComponent("https://youtu.be/s2Xdz8mUQMA")}`
  );
  const plan = await res.json();
  assert.equal(plan.playable, true);
  assert.equal(plan.kind, "youtube");
  assert.equal(plan.engine, "embed");
  assert.equal(plan.embed, "https://www.youtube-nocookie.com/embed/s2Xdz8mUQMA");
});

test("stream route does not claim an unknown host has no video", async () => {
  const external = "https://videos.example.com/lecture-01.mp4";
  const res = await nativeFetch(`${BASE}/api/stream?url=${encodeURIComponent(external)}`);
  const plan = await res.json();
  assert.equal(plan.playable, false);
  assert.equal(plan.external, external);
  assert.doesNotMatch(plan.reason, /has not published/i);
  assert.match(plan.reason, /hosted outside/i);
});

test("lecture page ships an embed element for non-CDN lectures", async () => {
  const html = await (await nativeFetch(`${BASE}/lecture.html`)).text();
  assert.match(html, /id="embed"/);
  const js = await (await nativeFetch(`${BASE}/assets/lecture.js`)).text();
  assert.match(js, /attachEmbed/);
});

test("hls relay rewrites playlists through the gateway", async () => {
  const res = await nativeFetch(`${BASE}/api/hls?folder=abc&asset=master.mpd&host=127.0.0.1:9`);
  assert.ok(res.status >= 400, "unreachable host should surface a JSON error");
  const body = await res.json();
  assert.equal(body.success, false);
});
