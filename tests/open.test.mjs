/**
 * The opening sheet — a title sequence that must never become a gate.
 *
 * The failure mode worth guarding is not "the animation looks wrong". It is a
 * visitor who cannot reach the catalogue: a sheet that plays for someone who
 * asked for reduced motion, an overlay that holds the page hidden after its
 * module fails, a key handler that outlives the sheet and swallows Space and
 * Enter on the home page underneath. So these tests are about control — who
 * can skip, what the page looks like when the sequence does not run, and what
 * is left behind when it does.
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
const PORT = 4290;
const FIXPORT = 4291;
const BASE = `http://127.0.0.1:${PORT}`;

const children = [];
let version = 0;
const REAL_FETCH = globalThis.fetch.bind(globalThis);

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
    await new Promise((r) => setTimeout(r, 150));
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
  await waitFor(`${BASE}/open`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

/** Load a page into jsdom with an optional media-query answer and storage. */
async function load(pathname, { reduce = false, hash = "", storage = null } = {}) {
  const res = await REAL_FETCH(`${BASE}${pathname}`);
  const html = await res.text();
  const dom = new JSDOM(html, {
    url: `${BASE}${pathname}${hash}`,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.matchMedia = (query) => ({
    matches: reduce && /prefers-reduced-motion/.test(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  });
  if (storage) for (const [k, v] of Object.entries(storage)) window.sessionStorage.setItem(k, v);
  return dom;
}

/** Execute a browser module against a jsdom window, as pages.test.mjs does. */
async function run(dom, src) {
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.localStorage = window.localStorage;
  globalThis.DOMParser = window.DOMParser;
  globalThis.matchMedia = window.matchMedia;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string" ? new URL(input, BASE) : input;
    return REAL_FETCH(target, init);
  };
  version += 1;
  await import(`${src}?v=${version}`);
  await new Promise((r) => setTimeout(r, 350));
}

test("the opening page is a complete sheet with no JavaScript at all", async () => {
  const res = await REAL_FETCH(`${BASE}/open`);
  assert.equal(res.ok, true, "/open is not served");
  const html = await res.text();

  // Every beat has something to draw, in the markup: the mark, the wordmark,
  // the catalogue rows, the title block, and the way out.
  for (const hook of ["openSheet", "openGo", "openTree", "openStatus", "openProgress"]) {
    assert.match(html, new RegExp(`id="${hook}"`), `/open has no #${hook}`);
  }
  assert.match(html, /class="open-mark"/, "the mark is missing from the sheet");
  assert.match(html, /open-word-main">ArsVibe/, "the wordmark is missing");
  assert.equal(
    (html.match(/class="ot-row"/g) || []).length,
    5,
    "the catalogue should draw five rows"
  );
  // The batch count ships with the page, so the sheet is never blank while the
  // one live request is in flight.
  assert.match(html, /14,201/);

  // Nothing may be hidden in the markup itself: every hidden state is scoped to
  // `.open-js`, which only exists once the module runs.
  assert.equal(/class="open-js"/.test(html), false, "a hidden state is baked into the HTML");

  // The page is not indexable — the catalogue is the front door — but it still
  // carries a canonical URL and a description.
  assert.match(html, /name="robots" content="noindex/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /name="description"/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /id="main"/);
  assert.match(html, /offline-boot\.js/, "the opener does not boot the offline shell");
});

test("reduced motion gets the finished drawing, not a shorter animation", async () => {
  const dom = await load("/open", { reduce: true });
  const { window } = dom;
  await run(dom, "/assets/open.js");
  const root = window.document.documentElement;

  assert.equal(root.classList.contains("open-quiet"), true, "the still sheet was not marked");
  // `open-quiet` is the one class that makes the drawing final without motion.
  assert.equal(root.classList.contains("open-quiet"), true, "the still sheet was not marked");
  // It must not navigate on its own: a still sheet is a page, not a gate.
  assert.equal(root.classList.contains("open-done"), false, "reduced motion auto-leaves the sheet");
  assert.match(window.document.getElementById("openStatus").textContent, /AV-01/);
  assert.equal(window.document.getElementById("openProgress").style.transform, "scaleX(1)");
  window.close();
});

test("the sheet offers an exit that does not wait for the sequence", async () => {
  const dom = await load("/open");
  const { window } = dom;
  await run(dom, "/assets/open.js");
  const doc = window.document;

  assert.equal(doc.documentElement.classList.contains("open-js"), true, "the sheet never armed");

  // The skip link is a real href to the catalogue, so it works before any of
  // the script does.
  const go = doc.getElementById("openGo");
  assert.equal(go.getAttribute("href"), "/");

  // Escape is the other way out. jsdom does not navigate, so what is asserted
  // is that the sheet marks itself finished rather than swallowing the key.
  const event = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  doc.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, "Escape was ignored");
  assert.equal(doc.documentElement.classList.contains("open-done"), true, "Escape did not close it");
  window.close();
});

test("the exit removes its own listeners, so the catalogue keeps its keys", async () => {
  // The sheet is an overlay on the home page. If its key handler outlives it,
  // Space and Enter stop working anywhere on the page underneath.
  const dom = await load("/open");
  const { window } = dom;
  await run(dom, "/assets/open.js");
  const doc = window.document;

  doc.getElementById("openGo").click();
  await new Promise((r) => setTimeout(r, 60));

  const after = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  doc.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false, "the sheet still intercepts Space after closing");
  window.close();
});

test("the front door plays the sheet once per session, never twice", async () => {
  const html = await (await REAL_FETCH(`${BASE}/`)).text();

  // Arming is in <head>, before the hero can paint: an intro that appears after
  // the page is already visible is worse than none.
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /intro-armed/, "the front door does not arm the sheet before paint");
  assert.match(head, /arsvibe\.open\.played/, "the session flag is not set before paint");
  // And it is a failsafe, not a promise: the class comes off on its own.
  assert.match(head, /setTimeout[\s\S]{0,200}remove\("intro-armed"\)/, "there is no failsafe");

  // The catalogue is only hidden while that class is on. The rule that shows it
  // again is what keeps a failed module from hiding the site.
  const css = await (await REAL_FETCH(`${BASE}/assets/arsvibe.css`)).text();
  assert.match(css, /\.intro-armed\s*\{[\s\S]{0,200}overflow: hidden/, "the armed state is unstyled");
  assert.match(
    css,
    /html:not\(\.intro-armed\)\s*>\s*body\s*\{[\s\S]{0,80}visibility: visible/,
    "nothing turns the page back on when the sheet is not there"
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.open-js \.ot-row/,
    "the reduced-motion still sheet is not fully specified"
  );

  // Every beat must be over by the time the sheet lifts, or the last frame the
  // visitor sees is a half-drawn drawing.
  const lifecycle = await (await REAL_FETCH(`${BASE}/assets/open.js`)).text();
  const run = Number(/const DURATION = (\d+)/.exec(lifecycle)?.[1] || 0);
  assert.ok(run > 2000 && run < 5000, `the sequence runs for ${run}ms`);
  const latest = [...css.matchAll(/animation:[^;]*?(\d+)ms var\(--ease\) forwards/g)]
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a)[0];
  assert.ok(latest < run, `the last beat starts at ${latest}ms but the sheet lifts at ${run}ms`);

  // The module itself is what lifts the sheet, and the sheet is fetched from
  // /open — one copy of the markup, two mountings.
  const js = await (await REAL_FETCH(`${BASE}/assets/open.js`)).text();
  assert.match(js, /fetch\("\/open"/, "the overlay does not come from /open");
  assert.match(js, /setItem\(PLAYED, "1"\)/, "the sheet is never marked as played");
  assert.match(js, /shell\.remove\(\)/, "the overlay is never taken out of the page");
});

test("the front door mounts the sheet over the catalogue, then takes it away", async () => {
  // This is the mounting that matters: the same sheet as /open, laid over the
  // live home page, lifted without a navigation so the catalogue keeps its
  // scroll and its rendered cards.
  const dom = await load("/");
  const { window } = dom;
  const doc = window.document;
  const root = doc.documentElement;

  // The inline failsafe does not run in jsdom (runScripts is off), so arm the
  // page by hand exactly as that script would.
  root.classList.add("intro-armed");

  await run(dom, "/assets/open.js");
  await new Promise((r) => setTimeout(r, 700));

  const intro = doc.getElementById("intro");
  assert.ok(intro, "the front door mounted no sheet");
  assert.ok(intro.querySelector(".open-sheet"), "the overlay is not the sheet");
  assert.ok(intro.querySelector("#openGo"), "the overlay has no way out");
  assert.equal(root.classList.contains("open-js"), true, "the overlay never armed its beats");

  // Leaving: the way out works immediately, the page is given back, and the
  // sheet is removed rather than left as an invisible layer over the hero.
  intro.querySelector("#openGo").click();
  await new Promise((r) => setTimeout(r, 900));

  assert.equal(doc.getElementById("intro"), null, "the sheet stayed in the page");
  assert.equal(root.classList.contains("intro-armed"), false, "the page was never handed back");
  assert.equal(window.sessionStorage.getItem("arsvibe.open.played"), "1", "the visit was not marked");

  // And the catalogue it was covering is still there, untouched.
  assert.match(doc.body.textContent, /Every Physics Wallah batch/);
  window.close();
});

test("a session that already opened the site gets no sheet at all", async () => {
  const dom = await load("/", { storage: { "arsvibe.open.played": "1" } });
  const { window } = dom;
  const doc = window.document;
  doc.documentElement.classList.add("intro-armed"); // as if the inline script had run

  await run(dom, "/assets/open.js");
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(doc.getElementById("intro"), null, "the sheet played twice in one session");
  assert.equal(
    doc.documentElement.classList.contains("intro-armed"),
    false,
    "the page was left hidden after skipping the sheet"
  );
  window.close();
});
