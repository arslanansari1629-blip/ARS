/**
 * Shell tests.
 *
 * The pieces added for offline use and accessibility are small, and every one of
 * them fails silently: a page still renders without a canonical URL, a dialog
 * still opens without trapping focus, a worker still registers without keeping
 * anything. So each is asserted against a real DOM rather than by reading the
 * source for a string.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

/** Install a jsdom document as the global the browser modules expect. */
function mount(html, url = "https://arsvibe-pw-sepia.vercel.app/batch?id=abc") {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.HTMLElement = window.HTMLElement;
  // Node 22 exposes `navigator` as a getter-only global; define it instead.
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  return { dom, window, doc: window.document };
}

const HEAD = `<!DOCTYPE html><html lang="en"><head>
<title>Batch — ArsVibe PW</title>
<meta name="description" content="site wide" />
<meta property="og:title" content="ArsVibe — every Physics Wallah batch" />
<meta property="og:description" content="site wide" />
<meta property="og:image" content="https://arsvibe-pw-sepia.vercel.app/assets/og.png" />
<link rel="canonical" href="https://arsvibe-pw-sepia.vercel.app/batch" />
</head><body></body></html>`;

test("setPageMeta rewrites the entity's own title, description and canonical URL", async () => {
  const { doc, dom } = mount(HEAD);
  const { setPageMeta, clamp, ORIGIN } = await import("/assets/app.js");

  setPageMeta({
    title: "Lakshya JEE 2027 — ArsVibe PW",
    description: clamp(`Lakshya JEE 2027 course, ${"subjects ".repeat(30)}`),
    canonical: `${ORIGIN}/batch?id=abc`,
    image: "https://static.pw.live/cover.jpg",
  });

  assert.equal(doc.title, "Lakshya JEE 2027 — ArsVibe PW");

  // The share tags must be the entity's, not the site's: a link pasted into a
  // group chat is the only introduction most batches get.
  assert.equal(doc.querySelector('meta[property="og:title"]').content, "Lakshya JEE 2027 — ArsVibe PW");
  assert.match(doc.querySelector('meta[property="og:description"]').content, /Lakshya JEE/);
  assert.match(doc.querySelector('meta[property="og:description"]').content, /…$/);
  assert.equal(doc.querySelector('meta[name="description"]').content, doc.querySelector('meta[property="og:description"]').content);
  assert.equal(doc.querySelector('link[rel="canonical"]').getAttribute("href"), `${ORIGIN}/batch?id=abc`);
  assert.equal(doc.querySelector('meta[property="og:url"]').content, `${ORIGIN}/batch?id=abc`);
  assert.equal(doc.querySelector('meta[property="og:image"]').content, "https://static.pw.live/cover.jpg");

  // Rewriting must not duplicate: there is still exactly one of each tag.
  for (const sel of ['meta[property="og:title"]', 'link[rel="canonical"]', 'meta[name="description"]']) {
    assert.equal(doc.querySelectorAll(sel).length, 1, `${sel} was duplicated`);
  }
  dom.window.close();
});

test("clamp trims on a word boundary and never leaves a dangling separator", async () => {
  const { clamp } = await import("/assets/app.js");

  assert.equal(clamp("short"), "short");
  const long = clamp("Physics Wallah batch with subjects, chapters, lectures, notes and DPPs for JEE 2027", 40);
  assert.ok(long.length <= 40, `too long: ${long.length}`);
  assert.match(long, /…$/);
  assert.equal(/\s[,;:—-]?…$/.test(long), false, `dangling separator in "${long}"`);
  // Collapsing whitespace matters: descriptions are built from titles that wrap.
  assert.equal(clamp("a\n\n  b\tc"), "a b c");
});

test("setStructuredData rewrites in place instead of stacking blocks", async () => {
  const { doc, dom } = mount(HEAD);
  const { setStructuredData } = await import("/assets/app.js");

  setStructuredData({ "@type": "Course", name: "First batch" });
  setStructuredData({ "@type": "Course", name: "Second batch" });

  const blocks = doc.querySelectorAll('script[type="application/ld+json"][data-dynamic]');
  assert.equal(blocks.length, 1, "a second graph was appended instead of replacing the first");
  assert.equal(JSON.parse(blocks[0].textContent).name, "Second batch");
  dom.window.close();
});

test("the menu button is a disclosure, not a mystery button", async () => {
  const html = `<!DOCTYPE html><html><body>
    <header id="nav">
      <button id="navToggle" aria-label="Open menu" aria-expanded="false" aria-controls="navLinks">menu</button>
      <nav id="navLinks"><a href="/" data-page="home">Home</a><a href="/batches.html" data-page="batches">Batches</a></nav>
    </header>
  </body></html>`;
  const { doc, window, dom } = mount(html, "https://example.test/");

  const { mountChrome } = await import("/assets/app.js");
  mountChrome("batches");

  const toggle = doc.getElementById("navToggle");
  const links = doc.getElementById("navLinks");

  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "opening is not announced");
  assert.ok(links.classList.contains("open"));

  // Choosing a destination closes the panel; otherwise it covers the page the
  // visitor just navigated to.
  links.querySelector("a").click();
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "the panel stayed open after a link");
  assert.equal(toggle.getAttribute("aria-label"), "Open menu");

  // Escape is the expected way out of a disclosure.
  toggle.click();
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(toggle.getAttribute("aria-expanded"), "false", "Escape did not close the menu");

  // The current page is marked for assistive tech, not only painted blue.
  assert.equal(links.querySelector('[data-page="batches"]').getAttribute("aria-current"), "page");
  dom.window.close();
});

test("the worker registration is inert where a worker cannot run", async () => {
  const { dom } = mount(HEAD, "http://arsvibe-pw-sepia.vercel.app/".replace("http", "http"));
  // jsdom has no navigator.serviceWorker: registration must resolve to null
  // rather than throw, because nothing awaits it in a way that could report.
  const { registerWorker, offlineReady, cacheForOffline } = await import("/assets/sw-register.js");

  assert.equal(await registerWorker(), null);
  assert.equal(offlineReady(), false);
  assert.equal(cacheForOffline("/api/media?url=x"), false);
  dom.window.close();
});

test("the offline page recovers on its own when the connection returns", async () => {
  const html = `<!DOCTYPE html><html><body>
    <div class="off-wrap"><p>offline</p></div>
    <button id="retry">Try again</button>
  </body></html>`;
  const { doc, window, dom } = mount(html, "https://arsvibe-pw-sepia.vercel.app/offline.html");

  // jsdom's `location.reload` is not implementable (and not redefinable), so the
  // module is given a stand-in location: counting the call is the assertion.
  let reloaded = 0;
  Object.defineProperty(globalThis, "location", {
    value: { reload: () => { reloaded += 1; } },
    configurable: true,
  });
  // The module calls the bare `addEventListener`, which in a browser is a window
  // binding, not a global Node provides.
  Object.defineProperty(globalThis, "addEventListener", {
    value: window.addEventListener.bind(window),
    configurable: true,
  });

  await import("/assets/offline-page.js");

  doc.getElementById("retry").click();
  assert.equal(reloaded, 1, "the retry button does nothing");

  // The module listens on the window (a bare `addEventListener` in a page module).
  window.dispatchEvent(new window.Event("online"));
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(reloaded, 2, "coming back online did not reload");
  assert.equal(doc.querySelector(".off-wrap").dataset.hint, "online");
  dom.window.close();
});

test("the reader asks for its document to be kept, and says so only once it is", async () => {
  const html = `<!DOCTYPE html><html><body>
    <div class="pdf-head"><div class="title" id="docTitle"></div><div class="tiny" id="docMeta"></div></div>
    <main id="main"><iframe id="frame"></iframe></main>
    <a id="downloadBtn"></a><a id="openBtn"></a>
  </body></html>`;
  const target = "https://static.pw.live/notes/ch3.pdf";
  const url = `https://arsvibe-pw-sepia.vercel.app/viewer.html?url=${encodeURIComponent(target)}&name=${encodeURIComponent("Ch3 Notes.pdf")}`;
  const { doc, window, dom } = mount(html, url);

  /* A minimal Cache Storage: enough to observe the contract (the page asks, the
     copy appears, the page then claims it is saved) without a browser. */
  const store = new Map();
  const caches = {
    keys: async () => ["arsvibe-v2-files"],
    open: async () => ({
      match: async (key) => store.get(String(key)),
      put: async (key, value) => store.set(String(key), value),
      keys: async () => [...store.keys()].map((k) => ({ url: k })),
    }),
    match: async (key) => store.get(String(key)),
  };
  // In a browser `caches` is window.caches; the module checks `"caches" in window`
  // before it trusts it, so both bindings have to exist here.
  Object.defineProperty(globalThis, "caches", { value: caches, configurable: true });
  Object.defineProperty(window, "caches", { value: caches, configurable: true });

  // A worker is "controlling" this page, so the page believes it can keep things.
  const posted = [];
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: { controller: { postMessage: (msg) => posted.push(msg) } },
    configurable: true,
  });

  await import(`/assets/viewer.js?t=${Date.now()}`);
  const relay = doc.getElementById("frame").getAttribute("src");
  assert.match(relay, /^\/api\/media\?url=/);

  // The relay URL is what must be kept: the displayed document and the stored
  // one have to be the same request, or the offline copy is never the one used.
  const until = async (check, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  assert.ok(await until(() => posted.length === 1), "the page never asked to keep the document");
  assert.deepEqual(posted, [{ type: "cache-url", url: relay }]);
  assert.ok(
    await until(() => /will be kept/.test(doc.getElementById("docMeta").textContent)),
    `the page did not report the copy is pending: ${doc.getElementById("docMeta").textContent}`
  );

  // Now the worker finishes writing; a later sweep must report the truth.
  store.set(relay, { ok: true });
  assert.ok(
    await until(() => /Saved on this device/.test(doc.getElementById("docMeta").textContent), 4000),
    "the page never confirmed the copy was stored"
  );
  dom.window.close();
});
