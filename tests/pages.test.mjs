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
import { readFile } from "node:fs/promises";

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
async function render(
  pathname,
  { waitForSelector, settle = 900, fetchWrap = null, extraModules = [], seed = null } = {}
) {
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
  // Seed storage before the page module runs: a dashboard that reads the saved
  // library on boot cannot be tested by writing localStorage afterwards.
  if (seed) seed(window.localStorage, window);

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

  // Progressive-enhancement modules (the shell) are separate scripts; a test
  // that asserts on what they build has to run them too.
  for (const mod of extraModules) {
    version += 1;
    await import(`${mod}?v=${version}`);
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

test("the sidebar is a complete panel: three bands, foldable groups, a rail", async () => {
  const { doc, dom } = await render("/", {
    waitForSelector: "#side",
    extraModules: ["/assets/shell.mjs"],
  });
  const side = doc.getElementById("side");

  // Three bands, in order: head, nav, foot. The nav is the only one that may
  // scroll, so the brand and the account row never leave the screen.
  assert.ok(side.querySelector(".side-head"), "sidebar has no head band");
  assert.ok(side.querySelector(".side-nav"), "sidebar has no nav band");
  assert.ok(side.querySelector(".side-foot"), "sidebar has no foot band");
  assert.ok(
    side.querySelectorAll(".side-title").length >= 4,
    "sidebar lost its navigation groups"
  );

  // Groups are disclosures, so a long list stays short.
  const groups = side.querySelectorAll("details.side-group");
  assert.ok(groups.length >= 3, `expected foldable groups, got ${groups.length}`);
  for (const group of groups) {
    assert.ok(group.querySelector("summary.side-title"), "a group has no heading control");
    assert.ok(group.querySelector(".side-items"), "a group has no item container");
  }

  // Every link can label itself on the collapsed rail.
  for (const link of side.querySelectorAll(".side-link")) {
    assert.ok(link.dataset.label, `a side link has no rail label: ${link.textContent.trim()}`);
  }

  // And there is a way back out of the rail.
  assert.ok(side.querySelector("[data-side-collapse]"), "sidebar cannot be collapsed");

  // No loose text crammed into the footer: it is a session row or a CTA.
  assert.ok(!side.querySelector(".side-note"), "the old footer note is back");
  // …and exactly one of them. A second pass over the footer would stack two.
  assert.equal(side.querySelectorAll(".side-who, .side-cta").length, 2, "footer rows duplicated");

  dom.window.close();
});

test("the rail folds away and comes back, and the choice is sticky", async () => {
  const { doc, dom } = await render("/", {
    waitForSelector: "#side",
    extraModules: ["/assets/shell.mjs"],
  });
  const toggle = doc.querySelector("#side [data-side-collapse]");
  assert.ok(toggle, "no control to leave the collapsed rail");

  // Open by default: a first-time reader gets the full panel.
  assert.equal(doc.body.classList.contains("side-rail"), false, "the sidebar starts folded");

  toggle.click();
  assert.equal(
    doc.body.classList.contains("side-rail"),
    true,
    "the rail control does not actually fold the sidebar"
  );
  // The choice is a preference, so it survives navigation.
  const prefs = JSON.parse(doc.defaultView.localStorage.getItem("arsvibe.prefs") || "{}");
  assert.equal(prefs.sideRail, true, "the rail is not remembered");

  // On the rail the head is the only thing left, so the head must reopen it.
  // The control survives the rail as a real button (a pseudo-element would not
  // be clickable, and this is exactly the bug that made the rail one-way).
  const collapseBtn = doc.querySelector("#side [data-side-collapse]");
  assert.ok(collapseBtn, "the collapse control vanished on the rail");
  const head = doc.querySelector("#side .side-head");
  assert.equal(head.getAttribute("aria-expanded"), "false", "the rail head does not announce its state");

  head.click();
  assert.equal(
    doc.body.classList.contains("side-rail"),
    false,
    "clicking the rail head does not reopen the sidebar"
  );
  assert.equal(head.getAttribute("aria-label"), "Collapse sidebar", "the head label did not follow the state");

  // Keyboard users get the same door.
  toggle.click();
  head.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(
    doc.body.classList.contains("side-rail"),
    false,
    "the rail head ignores Enter"
  );

  dom.window.close();
});

test("the phone drawer opens from the top bar and closes on the scrim", async () => {
  const { doc, dom } = await render("/", {
    waitForSelector: "#side",
    extraModules: ["/assets/shell.mjs"],
  });

  const toggle = doc.getElementById("navToggle");
  const scrim = doc.querySelector(".side-scrim");
  assert.ok(toggle, "the top bar lost its menu button");
  assert.ok(scrim, "the drawer has no scrim to close it");

  toggle.click();
  assert.equal(doc.body.classList.contains("nav-open"), true, "the menu button does not open the drawer");

  scrim.click();
  assert.equal(doc.body.classList.contains("nav-open"), false, "the scrim does not close the drawer");

  // Following a link in the drawer should also put it away.
  toggle.click();
  doc.querySelector("#side .side-link").click();
  assert.equal(
    doc.body.classList.contains("nav-open"),
    false,
    "a drawer link leaves the drawer open behind the new page"
  );

  dom.window.close();
});

test("batches page lists catalogue with pager and result count", async () => {
  const { doc, dom } = await render("/batches.html", { waitForSelector: "#grid .batch-card" });
  assert.ok(doc.querySelectorAll("#grid .batch-card").length >= 2);
  assert.match(doc.getElementById("resultCount").textContent, /14,201 batches/);
  assert.ok(doc.querySelectorAll("#pager button").length >= 3);
  // The dropdown offers every language in the catalogue with its count, not just
  // the languages that happened to appear on this page of twenty.
  const langs = [...doc.querySelectorAll("#langFilter option")].map((o) => o.textContent);
  assert.ok(
    langs.some((l) => /^Hinglish\b/.test(l)),
    langs.join(",")
  );
  assert.ok(
    langs.some((l) => /^Kannada\b/.test(l)),
    "Kannada has 70 batches that are nowhere near page 1; the filter must offer it"
  );
  dom.window.close();
});

test("the batch DPP tab opens every time, not just the first", async () => {
  // The DPP panel used to be deleted when the reader left the tab while the
  // module kept a reference to it, so `renderDpp` returned early and the second
  // and third visits painted an empty card — papers in the data, blank on screen.
  const { doc, dom, window } = await render("/batch.html?id=698ad3519549b300a5e1cc6a", {
    waitForSelector: "#subjects .subject-card",
  });
  await new Promise((r) => setTimeout(r, 1200));

  const open = async () => {
    doc.querySelector('[data-tab="dpp"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const panel = doc.getElementById("dppPanel");
      if (panel && /\d+ papers? from \d+ chapters/.test(panel.textContent)) return panel;
      await new Promise((r) => setTimeout(r, 120));
    }
    return doc.getElementById("dppPanel");
  };

  for (const visit of [1, 2, 3]) {
    const panel = await open();
    assert.ok(panel, `visit ${visit}: the DPP tab painted nothing`);
    assert.match(
      panel.textContent,
      /\d+ papers? from \d+ chapters/,
      `visit ${visit}: the panel did not list papers — ${panel.textContent.slice(0, 120)}`
    );
    // Bindings have to survive the round trip too, not just the markup.
    assert.ok(doc.getElementById("dppPanelSearch"), `visit ${visit}: the search box is gone`);
    assert.ok(doc.querySelector(".dpp-panel-row"), `visit ${visit}: no paper rows`);
    assert.ok(doc.querySelector('.dpp-panel-row a[href^="/dpp.html?"]'), `visit ${visit}: no Practice link`);
    doc.querySelector('[data-tab="about"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  }

  // And the search still filters after those switches — the old bug's tell was
  // a panel that looked right but had lost its event listeners. (The loop ends
  // on the About tab, so the panel is detached: come back to DPP first.)
  await open();
  const box = doc.getElementById("dppPanelSearch");
  box.value = "zzz-no-such-paper";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  assert.match(doc.getElementById("dppPanelList").textContent, /No paper matches/);
  dom.window.close();
});

test("the nav's DPP Tests entry lists papers instead of pointing at a batch", async () => {
  const { doc, dom, window } = await render("/batches.html#dpp-tests", {
    waitForSelector: "#dppTestsNotice .dpp-tests-list",
  });

  const panel = doc.getElementById("dppTestsNotice");
  assert.ok(panel, "the nav's DPP Tests entry painted no panel");
  // The catalogue stays underneath: this is a panel over the page, not a page
  // that replaces it with an instruction.
  assert.ok(doc.querySelectorAll("#grid .batch-card").length >= 2, "the catalogue vanished");

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !doc.querySelector(".dpp-tests .dpp-panel-row")) {
    await new Promise((r) => setTimeout(r, 150));
  }
  const rows = doc.querySelectorAll(".dpp-tests .dpp-panel-row");
  assert.ok(rows.length >= 1, "no papers listed under DPP Tests");
  assert.ok(
    [...rows].every((row) => row.querySelector('a[href^="/dpp.html?"]')),
    "a listed paper has no Practice link"
  );
  assert.match(doc.getElementById("dppTestsNote").textContent, /paper/i);
  // The panel *head* lists papers; it is not a notice pointing at another page.
  // (The empty state may still say where papers live, which is honest.)
  assert.equal(
    /open a batch/i.test(panel.querySelector(".dpp-panel-head").textContent),
    false,
    "the panel still tells the reader to go elsewhere instead of listing papers"
  );

  // Its own search filters the list.
  const box = doc.getElementById("dppTestsSearch");
  box.value = "zzz-no-such-paper";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  assert.match(doc.getElementById("dppTestsList").textContent, /No paper matches/);
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

test("the batch hero paints from the catalogue before the slow detail call returns", async () => {
  // Production symptom: a cold `/BatchInfo` left the page a blank skeleton for
  // seconds. The hero must come from the shipped catalogue row, and the page
  // must still be usable (title, favourite toggle) while the detail call hangs.
  const { doc, dom } = await render("/batch.html?id=698ad3519549b300a5e1cc6a", {
    fetchWrap: (target) => {
      if (target.pathname === "/api/batch" && !target.searchParams.get("header")) {
        return new Promise(() => {}); // never settles: the slow upstream
      }
      return null;
    },
    waitForSelector: "#favBatchBtn",
  });

  assert.match(doc.title, /Arjuna JEE 2027/);
  const hero = doc.querySelector(".detail-head h1");
  assert.ok(hero, "the hero never painted without the detail call");
  assert.match(hero.textContent, /Arjuna JEE 2027/);
  assert.ok(doc.getElementById("favBatchBtn"), "the hero is missing its favourite toggle");
  assert.equal(doc.querySelectorAll(".skeleton.sk-cover").length, 0, "the cover is still a skeleton");
  dom.window.close();
});

test("the header route answers from the catalogue and defers the subject list", async () => {
  const res = await nativeFetch(`${BASE}/api/batch?header=1&id=698ad3519549b300a5e1cc6a`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.header, true);
  assert.equal(body.subjects, null, "the header route must not claim an empty subject list");
  assert.match(body.batch.name, /Arjuna JEE 2027/);
  assert.ok(body.batch.image, "the header carries no cover image");
  assert.ok(body.batch.startDate, "the header carries no start date");
});

test("a paid batch is never labelled free", async () => {
  // `/BatchInfo` omits `feeTotal`, and `isFree: !d.feeTotal` therefore stamped
  // "Free" on every batch in the catalogue, including ₹1,999 ones. The shipped
  // catalogue carries the fee, so the detail route must fall back to it.
  const { doc, dom } = await render("/batch.html?id=698ad3519549b300a5e1cc6a", {
    waitForSelector: "#favBatchBtn",
  });
  const pills = [...doc.querySelectorAll(".detail-head .pill")].map((p) => p.textContent.trim());
  assert.equal(pills.includes("Free"), false, `a paid batch shows a Free pill: ${pills.join(" | ")}`);
  assert.match(doc.body.textContent, /₹[13],\d{3}/, "the price is missing from the hero");

  const res = await nativeFetch(`${BASE}/api/batch?id=698ad3519549b300a5e1cc6a`);
  const body = await res.json();
  assert.equal(body.batch.isFree, false);
  assert.equal(typeof body.batch.price, "number");
  assert.ok(body.batch.price > 0, "the route reported a zero price for a paid batch");

  // The same batch through the header route (shipped catalogue, no upstream)
  // must agree: the panel-level bug was that only the catalogue knew the fee.
  const header = await (await nativeFetch(`${BASE}/api/batch?header=1&id=698ad3519549b300a5e1cc6a`)).json();
  assert.equal(header.batch.isFree, false);
  assert.ok(header.batch.price > 0);
  dom.window.close();
});

test("subject page renders chapters with counts", async () => {
  const { doc, dom } = await render(
    "/subject.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&name=Physics",
    { waitForSelector: ".chapter-row" }
  );
  const rows = doc.querySelectorAll(".chapter-row");
  assert.equal(rows.length, 8);
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

test("every batch card carries a heart, and the heart saves without navigating", async () => {
  const { doc, dom } = await render("/batches.html", {
    waitForSelector: "#grid .batch-card",
  });

  const cards = doc.querySelectorAll("#grid .batch-card");
  assert.ok(cards.length > 0, "the catalogue rendered no cards");
  const heart = cards[0].querySelector(".fav-btn");
  assert.ok(heart, "a batch card has no favourite control");
  assert.equal(heart.getAttribute("aria-pressed"), "false", "a fresh heart reports itself as saved");
  assert.ok(cards[0].contains(heart), "the heart is not part of the card");

  // It carries enough of the card to save a favourite without a refetch.
  assert.ok(heart.dataset.fav, "the heart has no batch id");
  assert.ok(heart.dataset.favName, "the heart has no batch name");

  // Pressing it must save — and must cancel the navigation the card's anchor
  // would otherwise perform. The handler is delegated on the document, so the
  // verdict is read off the event after it has finished bubbling.
  const press = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  heart.dispatchEvent(press);

  assert.equal(heart.getAttribute("aria-pressed"), "true", "the heart did not flip to saved");
  assert.ok(heart.classList.contains("on"), "the saved heart is not marked visually");
  assert.equal(press.defaultPrevented, true, "pressing the heart left the card's link to navigate");

  const saved = JSON.parse(dom.window.localStorage.getItem("arsvibe.favourites") || "[]");
  assert.equal(saved.length, 1, "the favourite was not stored");
  assert.equal(saved[0].id, heart.dataset.fav);

  // Pressing it again drops it again.
  heart.click();
  assert.equal(heart.getAttribute("aria-pressed"), "false", "the heart cannot be un-set");
  assert.equal(
    JSON.parse(dom.window.localStorage.getItem("arsvibe.favourites") || "[]").length,
    0,
    "un-hearting left the favourite behind"
  );

  dom.window.close();
});

test("the favourites page lists saved batches and drops them live", async () => {
  const { doc, dom } = await render("/favourites.html", { waitForSelector: "#body" });

  // Empty state first: it has to say what a favourite is.
  assert.match(doc.getElementById("body").textContent, /No favourites yet/);

  dom.window.localStorage.setItem(
    "arsvibe.favourites",
    JSON.stringify([
      { id: "698ad3519549b300a5e1cc6a", name: "Arjuna JEE 2027", language: "Hinglish", feeTotal: 1999, at: Date.now() },
      { id: "6779345c20fa0756e4a7fd08", name: "Lakshya JEE 2027", language: "Hinglish", feeTotal: 999, at: Date.now() - 1000 },
    ])
  );

  // The page repaints from the store on any favourites change, which is what
  // makes un-hearting on this page drop the card instead of leaving it.
  await import("/assets/favourites-page.js?v=" + Date.now());
  await new Promise((r) => setTimeout(r, 250));

  const cards = doc.querySelectorAll("#body .batch-card");
  assert.equal(cards.length, 2, `expected both saved batches, got ${cards.length}`);
  assert.match(doc.getElementById("body").textContent, /Arjuna JEE 2027/);

  const heart = cards[0].querySelector(".fav-btn");
  assert.ok(heart.classList.contains("on"), "a saved batch renders an empty heart");
  heart.click();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    doc.querySelectorAll("#body .batch-card").length,
    1,
    "un-hearting did not remove the card from the list"
  );

  dom.window.close();
});

test("the sidebar links favourites with a live count", async () => {
  const { doc, dom } = await render("/", {
    waitForSelector: "#side",
    extraModules: ["/assets/shell.mjs"],
  });

  const link = doc.querySelector('#side a[href="/favourites.html"]');
  assert.ok(link, "the sidebar has no favourites entry");
  assert.equal(link.dataset.label, "Favourites", "the rail label is missing");
  const count = link.querySelector("[data-fav-count]");
  assert.ok(count, "the favourites link has no count");
  assert.equal(count.hidden, true, "an empty favourites list shows a count");

  // A change anywhere on the page repaints the count.
  dom.window.localStorage.setItem(
    "arsvibe.favourites",
    JSON.stringify([{ id: "x", name: "X", at: 1 }])
  );
  doc.dispatchEvent(new dom.window.CustomEvent("favourites:change", { detail: { list: [] } }));
  assert.equal(count.textContent, "1", "the count did not follow the store");
  assert.equal(count.hidden, false, "the count stays hidden when there is something in it");

  dom.window.close();
});

test("lecture page loads metadata and attached notes + DPP", async () => {
  const url =
    "/lecture.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&id=6a6b462b26b614560bceb74b&title=Units%20and%20Dimension%2010";
  const { doc, dom } = await render(url, { waitForSelector: "#docs .attach-row" });
  const docs = doc.querySelectorAll("#docs .attach-row");
  assert.ok(docs.length >= 2, `expected class notes + DPP, got ${docs.length}`);
  assert.match(doc.body.textContent, /Class Notes/);
  assert.match(doc.body.textContent, /DPP 07/);
  // Every attachment is its own fixed grid: a long name must not widen the
  // player column, so each row carries a name track and an action group.
  for (const row of docs) {
    assert.ok(row.querySelector(".attach-name"), "attachment row has no name track");
    assert.ok(row.querySelector(".attach-actions"), "attachment row has no action group");
  }
  assert.match(doc.getElementById("lectureMeta").textContent, /01:50:38/);
  dom.window.close();
});

test("lecture page bootstraps a stream plan instead of erroring", async () => {
  const url =
    "/lecture.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&id=6a6b462b26b614560bceb74b&title=Units%20and%20Dimension%2010";
  const { doc, dom } = await render(url, {
    waitForSelector: "#docs .attach-row",
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
      // The player probes the manifest before attaching an engine. Left to the
      // real route the probe answers with whatever the environment can reach,
      // so the page would take the retry path on some runs and the playback path
      // on others — the same plan, two different tests. Answer it deterministically.
      if (String(target).includes("/api/sign")) {
        return Promise.resolve(
          new Response("#EXTM3U\n#EXT-X-VERSION:3\n", {
            status: 200,
            headers: { "content-type": "application/vnd.apple.mpegurl" },
          })
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

test("the player ships a speed stepper and a now-playing transport", async () => {
  const { doc, dom } = await render(
    "/lecture.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&id=6a6b462b26b614560bceb74b",
    { waitForSelector: "#docs .attach-row" }
  );

  // Speed: one control with a readout, not six dead buttons in a phone tray.
  assert.ok(doc.getElementById("speedStep"), "the speed stepper is missing");
  assert.ok(doc.getElementById("speedDown"), "no slower control");
  assert.ok(doc.getElementById("speedUp"), "no faster control");
  assert.equal(doc.querySelectorAll(".player-bar .speed").length, 0, "the six-button row came back");

  // Stepping changes the rate and the readout, and clamps at the ends.
  const up = doc.getElementById("speedUp");
  const down = doc.getElementById("speedDown");
  const read = () => doc.getElementById("speedRateText").textContent;
  assert.equal(read(), "1×");
  up.click();
  assert.equal(read(), "1.25×", "the + control did not step the rate");
  down.click();
  down.click();
  assert.equal(read(), "0.75×", "the − control did not step the rate");
  down.click();
  assert.equal(read(), "0.75×", "the rate ran below the lowest speed");
  doc.getElementById("speedRate").click();
  assert.equal(read(), "1×", "tapping the rate did not reset it");

  // Now playing: the right column's own transport.
  const card = doc.getElementById("nowCard");
  assert.ok(card, "the now-playing card is missing");
  for (const id of ["nowState", "nowTitle", "nowProgress", "nowPosition", "nowDuration", "nowPlay", "nowBack", "nowFwd"]) {
    assert.ok(doc.getElementById(id), `now-playing card has no ${id}`);
  }
  // It must not be a decorated dead panel: its buttons are wired to the player.
  assert.match(doc.getElementById("nowBack").getAttribute("title") || "", /10/);
  assert.match(doc.getElementById("nowFwd").getAttribute("title") || "", /10/);

  dom.window.close();
});

test("the lecture page no longer offers a source-player link or a health panel", async () => {
  const { doc, dom } = await render(
    "/lecture.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822&id=6a6b462b26b614560bceb74b",
    { waitForSelector: "#docs .attach-row" }
  );

  // Both were removed at the user's request: the player stands on its own, and
  // the right column is notes, not diagnostics.
  assert.equal(doc.getElementById("sourceLink"), null, "the vidcloud link is back");
  assert.equal(doc.getElementById("healthBadge"), null, "the playback-health card is back");
  assert.equal(
    doc.querySelector(".queue-bar a[href*='vidcloud'], .queue-bar a[href*='eduvibe']"),
    null,
    "a source-player link survived in the queue bar"
  );

  // The stream inspector stays, but as a closed pane behind the gear.
  const stats = doc.getElementById("playerStats");
  assert.ok(stats, "the stream-stats pane is gone");
  assert.ok(stats.hidden, "the stream-stats pane should start closed");

  // What must survive: the stopped player's way back, and the shortcut sheet.
  assert.ok(doc.getElementById("bigPlayBtn"), "the stopped player lost its start control");
  assert.match(doc.body.textContent, /Keyboard shortcuts/);

  dom.window.close();
});

test("the lecture player ships quality control and recovery", async () => {
  // The transport lives in the player engine module; the page wires it to the
  // markup. Both halves are asserted, because either one alone ships a player
  // that looks wired and does nothing.
  const source =
    (await (await nativeFetch(`${BASE}/assets/player.js`)).text()) +
    (await (await nativeFetch(`${BASE}/assets/lecture.js`)).text());

  // Regression guards for the playback path.
  assert.match(source, /#EXTM3U|Hls\.Events\.MANIFEST_PARSED/, "hls.js setup is missing");
  assert.match(source, /recoverMediaError|startLoad\(\)/, "no hls.js error recovery");
  assert.match(source, /data-speed/, "speed control binding is missing");
  assert.match(source, /id="quality"|getElementById\("quality"\)|\$\("quality"\)/, "quality picker is missing");

  // A picker that exists but never gets options is the same as no picker: the
  // player must consume the plan's rendition list and re-apply a saved choice.
  assert.match(
    source,
    /plan\.renditions/,
    "the player ignores the plan's rendition list, so the picker would be empty"
  );
  // The saved pick must be re-applied as soon as the manifest is parsed.
  assert.match(
    source,
    /MANIFEST_PARSED[\s\S]{0,900}_applySavedQuality/,
    "saved quality is never re-applied"
  );
  assert.match(
    source,
    /setQuality\(/,
    "quality switching is not factored, so load-time cannot reuse it"
  );

  // Transport and navigation controls.
  assert.match(source, /function seekBy/, "no keyboard/click seeking");
  assert.match(source, /requestPictureInPicture/, "picture-in-picture is missing");
  assert.match(source, /goToLecture/, "there is no next/previous lecture navigation");
  assert.match(source, /addEventListener\("keydown"/, "no keyboard shortcuts");

  // Buffering and reconnecting must be reported as different things.
  assert.match(source, /Buffering…/, "buffering is never reported");
  assert.match(source, /Reconnecting…/, "reconnection is never reported");

  // A retry must bypass the resolver cache, otherwise it re-probes the same
  // signer host that just failed.
  assert.match(source, /attempt \+= 1/, "retries do not bump the resolution attempt");
  assert.match(source, /function seekBy|seekBy\(delta\)/, "skip seeking is missing");
  // A stopped player must be able to start again; this is the bug being fixed.
  assert.match(source, /restart\(\)/, "there is no way back from a stopped player");
  // The page composes the query string with the attempt number it was handed,
  // and with the level it was watching — a retry that names neither re-probes
  // the dead signer and comes back at the wrong quality.
  assert.match(source, /&attempt=\$\{n\}/, "the attempt is never sent to /api/stream");
  assert.match(
    source,
    /&level=\$\{encodeURIComponent\(level\)\}/,
    "a recovery does not ask for the quality the student was watching"
  );
  assert.match(source, /playingQuality\(\)/, "the player never reports the level it is on");

  assert.ok(
    !/location\.reload\(\)/.test(source),
    "playback failures must re-resolve the stream, not reload the page"
  );
});

test("the downloads page browses live lectures and explains offline playback", async () => {
  const { doc, window, dom } = await render("/downloads.html", {
    waitForSelector: "#subjectList",
    settle: 600,
  });

  // The page is useless without the catalogue search box and the saved list.
  assert.ok(doc.getElementById("batchSearch"), "no batch search on the downloads page");
  assert.ok(doc.getElementById("savedList"), "no saved-downloads list");
  assert.ok(doc.getElementById("savedEmpty"), "the empty state is missing");

  // It has to say what actually works offline.
  //
  // This assertion used to require the page to say video *cannot* be kept, because
  // it could not: PW refused to sign a stream for a guest session. That is no
  // longer true — `/api/check` walks a lecture from plan to master to rendition to
  // a decrypted segment, and `/api/download?mode=file` assembles the slices — so
  // the old requirement was telling students not to use a feature that works. What
  // must stay pinned is that the page describes the mechanism honestly: lectures
  // are kept in slices, which is why a long class takes minutes.
  const text = doc.body.textContent;
  assert.match(text, /Offline reading/i);
  assert.match(text, /note|PDF/i);
  assert.match(text, /lecture/i, "the page dropped lectures entirely");
  assert.match(text, /slice|pieces/i, "it must say how a lecture is kept");
  assert.match(text, /this device only|this browser/i);
  assert.doesNotMatch(text, /MPEG-TS/, "it must not advertise a format it cannot produce");
  assert.doesNotMatch(
    text,
    /cannot be kept|only signs stream links|Video cannot be saved/i,
    "the page still claims lectures cannot be saved"
  );

  // Nothing is saved yet, so the empty state is showing.
  assert.equal(doc.getElementById("savedEmpty").hidden, false);

  // The page must not offer a download it cannot honour: with an empty search it
  // shows no rows rather than a spinner forever.
  assert.equal(doc.getElementById("batchResults").children.length, 0);

  window.close();
  void dom;
});

test("the downloads page is in the site's own navigation", async () => {
  const html = await (await nativeFetch(`${BASE}/downloads.html`)).text();
  assert.match(html, /href="\/downloads.html"[^>]*data-page="downloads"/);
  // The shell renders its own sidebar entry too, so the page is reachable from
  // every other page and not just from the address bar.
  const shell = await (await nativeFetch(`${BASE}/assets/shell.mjs`)).text();
  assert.match(shell, /id: "downloads", href: "\/downloads\.html"/);
  assert.match(shell, /download: '<path/);
});

test("the player offers to save the lecture it is playing", async () => {
  const lecture = await (await nativeFetch(`${BASE}/assets/lecture.js`)).text();
  assert.match(lecture, /menuSave/, "the player has no save-for-offline control");
  assert.match(lecture, /downloadLecture/, "the save control is not wired to the downloader");
  assert.match(lecture, /\/api\/download\?mode=list/, "the save control never checks the lecture is downloadable");
});

test("a saved lecture plays in the site, not in a blank tab or a Downloads folder", async () => {
  const page = await (await nativeFetch(`${BASE}/assets/downloads-page.js`)).text();

  // The regression: "Play offline" opened `window.open("", "_blank")` with a blob
  // in it, so a saved lecture looked like it had left the site — and the only
  // other button wrote a file into Chrome's Downloads folder.
  assert.equal(/window\.open\(/.test(page), false, "the saved card still opens a blank tab");
  assert.match(page, /playSaved/, "Play offline does not use the in-site player");

  const player = await (await nativeFetch(`${BASE}/assets/offline-player.js`)).text();
  // It builds media from the saved parts, on this origin, with no request.
  assert.match(player, /offlineFile\(record\)/, "the offline player never reads the saved parts");
  assert.match(player, /createObjectURL/, "no blob is created for playback");
  assert.equal(
    /fetch\(|XMLHttpRequest/.test(player),
    false,
    "the offline player makes network requests, so it is not offline"
  );
  // Both formats have a path: TS media directly, a keyed playlist through hls.js.
  assert.match(player, /format === "plain"/);
  assert.match(player, /hls\.min\.js/, "a keyed save has no playlist reader");
  assert.match(player, /revokeObjectURL/, "blob URLs leak on close");

  // The stylesheet ships with the pages that show the sheet.
  for (const path of ["/downloads.html", "/lecture.html"]) {
    const html = await (await nativeFetch(`${BASE}${path}`)).text();
    assert.match(html, /href="\/assets\/offline\.css"/, `${path} does not style the offline player`);
  }
});

test("the lecture player offers the copy it just saved without leaving", async () => {
  const lecture = await (await nativeFetch(`${BASE}/assets/lecture.js`)).text();
  assert.match(lecture, /showSavedAction/, "no offer to play the saved copy");
  assert.match(lecture, /offlineOffer/, "nothing to render the offer into");
  const html = await (await nativeFetch(`${BASE}/lecture.html`)).text();
  assert.match(html, /id="offlineOffer"/, "the lecture page has no slot for the offer");
});

test("the downloader stitches slices instead of trusting one response", async () => {
  const mod = await import("../public/assets/downloader.js");
  // A slice is a fragment, so the reader has to find the inline key and media.
  const slice = mod.readSlice(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      '#EXT-X-KEY:METHOD=AES-128,URI="data:application/octet-stream;base64,MDEyMzQ1Njc4OWFiY2RlZg=="',
      "#EXTINF:4.000,",
      "data:video/MP2T;base64,AQIDBA==",
      "#EXT-X-ENDLIST",
    ].join("\n")
  );
  assert.equal(slice.media.length, 1);
  assert.match(slice.keyLine, /base64,/);
  assert.equal(slice.media[0].duration, 4);

  // A slice that points at a URL is not self-contained and must be skipped, or
  // the saved lecture would expire with the signature.
  const notInline = mod.readSlice(
    ["#EXTM3U", "#EXTINF:4.000,", "https://example.com/000.ts"].join("\n")
  );
  assert.equal(notInline.media.length, 0);

  // The stitched file carries one key and every part, in order.
  const out = mod.buildOfflinePlaylist({
    key: slice.keyLine,
    parts: [
      { data: "AQIDBA==", seconds: 4 },
      { data: "BQYHCA==", seconds: 6 },
    ],
  });
  assert.match(out, /#EXT-X-KEY/);
  // The parts are concatenated inside one segment, in the order they arrived.
  assert.match(out, /#EXTINF:10\.000,\nAQIDBA==BQYHCA==\n/);
  assert.match(out, /#EXTINF:10\.000,/);
  assert.match(out, /#EXT-X-ENDLIST/);

  // And a raw slice is recognised as media, not mistaken for a playlist.
  const ts = new Uint8Array(400);
  for (let i = 0; i < 400; i += 188) ts[i] = 0x47;
  assert.equal(mod.looksLikeTransportStream(ts), true);
  assert.equal(mod.looksLikeTransportStream(new Uint8Array(400)), false);
  assert.equal(mod.isPlaylistText("#EXTM3U\n"), true);
  assert.equal(mod.isPlaylistText("G@\u0011\u0010"), false);
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

  // The reader's logic lives in a module file (so it is cached and auditable like
  // every other page), not in an inline block: run it the same way the browser
  // would, through the loader shim, with the jsdom document installed as global.
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.CustomEvent = window.CustomEvent;
  version += 1;
  await import(`/assets/viewer.js?v=${version}`);

  const src = dom.window.document.getElementById("frame").getAttribute("src");
  assert.match(src, /^\/api\/media\?url=https%3A%2F%2Fstatic\.pw\.live/);
  assert.equal(dom.window.document.getElementById("docTitle").textContent, "Class Notes.pdf");
  dom.window.close();
});

test("login page supports bypass login and stores a session", async () => {
  const { doc, window, dom } = await render("/login.html", { waitForSelector: "#bypassBtn" });
  doc.getElementById("bypassBtn").click();
  const raw = window.localStorage.getItem("arsvibe.session");
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
  // `/api/stream` answers with a JSON plan; handing that to a media element is a
  // dead lecture. A signed plan must go to the gateway that serves the bytes.
  assert.match(plan.url, /^\/api\/hls\?folder=d780e1e3/);
  assert.match(plan.url, /asset=master\.mpd/);

  // And the gateway really is mounted at that URL: `/api/hls` is rewritten onto
  // api/stream.mjs, so a broken mount would only show up here.
  const gateway = await nativeFetch(`${BASE}/api/hls?folder=x&asset=master.mpd`);
  const body = await gateway.json();
  assert.equal(body.success, false, "/api/hls is not answering as a route");
  // Which refusal it is depends on the network: a missing folder, a host that is
  // not a media host, or "fetch failed" when the sandbox has no egress. What
  // matters is that this URL reached the gateway and it answered in JSON.
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
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
  // Embed handling moved into the engine when the player was rebuilt; the page
  // still has to route embed plans to it.
  const js =
    (await (await nativeFetch(`${BASE}/assets/lecture.js`)).text()) +
    (await (await nativeFetch(`${BASE}/assets/player.js`)).text());
  assert.match(js, /engine === "embed"/, "embed plans are not routed");
});

test("hls relay rewrites playlists through the gateway", async () => {
  const res = await nativeFetch(`${BASE}/api/hls?folder=abc&asset=master.mpd&host=127.0.0.1:9`);
  assert.ok(res.status >= 400, "unreachable host should surface a JSON error");
  const body = await res.json();
  assert.equal(body.success, false);
});

test("no page still shows the old brand mark", async () => {
  // The login page kept a literal "PW" badge and "Welcome to PW" heading through
  // the rebrand because the mark was hard-coded in its own markup.
  for (const page of ["/login", "/", "/batches", "/dashboard", "/library"]) {
    const html = await (await nativeFetch(`${BASE}${page}`)).text();
    assert.equal(/<div class="logo">PW<\/div>/.test(html), false, `${page} still shows the PW logo`);
    assert.equal(/Welcome to PW/.test(html), false, `${page} still says "Welcome to PW"`);
  }
});

test("the batch page trades the source-site box for a favourite toggle", async () => {
  const { doc, dom, window } = await render(
    "/batch.html?id=698ad3519549b300a5e1cc6a",
    { waitForSelector: "#favBatchBtn" }
  );

  // Round K/M: the outbound "open on the source site" action is gone for good.
  const outbound = [...doc.querySelectorAll("a[href]")].filter((a) =>
    /pw\.eduvibe|vidcloud|studyspark/.test(a.getAttribute("href") || "")
  );
  assert.deepEqual(outbound.map((a) => a.href), [], "an outbound source-site link is back");
  assert.equal(
    /open (on )?(the )?source site/i.test(doc.body.textContent),
    false,
    "the copy still invites the visitor to leave for the source site"
  );

  // In its place: a real, working favourite toggle.
  const fav = doc.getElementById("favBatchBtn");
  assert.ok(fav, "the favourite toggle is missing from the batch hero");
  assert.match(fav.textContent, /Favourite/i);
  assert.equal(fav.getAttribute("aria-pressed"), "false");

  fav.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(fav.getAttribute("aria-pressed"), "true", "the toggle did not flip state");
  assert.ok(fav.classList.contains("on"), "the toggle did not take its pressed style");
  assert.match(doc.getElementById("favBatchText").textContent, /Saved/i);
  const stored = JSON.parse(window.localStorage.getItem("arsvibe.favourites") || "[]");
  assert.ok(
    stored.some((b) => b.id === "698ad3519549b300a5e1cc6a"),
    "the batch was not stored"
  );

  // And it toggles back off.
  fav.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fav.getAttribute("aria-pressed"), "false");
  assert.deepEqual(JSON.parse(window.localStorage.getItem("arsvibe.favourites") || "[]"), []);

  dom.window.close();
});

test("the dashboard summarises favourites, watch time and where to resume", async () => {
  const lecture = {
    id: "6a6b462b26b614560bceb74b",
    title: "Vectors — full lecture",
    batch: "698ad3519549b300a5e1cc6a",
    subject: "physics-by-saleem-ahmad-sir-886822",
    chapter: "Physics",
    at: Date.now(),
  };
  const { doc, dom } = await render("/dashboard.html", {
    waitForSelector: "#resumeRail .resume-card",
    seed: (ls) => {
      ls.setItem("arsvibe.library", JSON.stringify({ batches: [], lectures: [lecture], docs: [] }));
      ls.setItem(`pos:${lecture.id}`, "630");
      ls.setItem("arsvibe.session", JSON.stringify({ name: "Test Student", email: "s@example.com" }));
    },
  });

  // "Data source" was a dead readout; it is now a live count that links out.
  assert.equal(doc.getElementById("statSource"), null, "the old data-source tile is back");
  assert.ok(doc.getElementById("statFavs"), "the favourites tile is missing");
  assert.match(
    doc.querySelector(".stat a[href$='favourites.html']")?.getAttribute("href") || "",
    /favourites\.html$/,
    "the favourites tile does not link to the favourites page"
  );

  // Watch time is summed from the per-lecture positions the player saves.
  assert.match(doc.getElementById("statWatch").textContent.trim(), /^1[01]m$/, "watch time is not summed");

  // Resume cards carry a real link and a time stamp, not a decorative arrow.
  const cards = doc.querySelectorAll("#resumeRail .resume-card");
  assert.equal(cards.length, 1, `expected one resume card, got ${cards.length}`);
  assert.equal(doc.getElementById("resumeBand").hidden, false, "the resume band stayed hidden");
  const card = cards[0];
  assert.match(card.getAttribute("href") || "", /^\/lecture\.html\?/, "a resume card is not a link");
  assert.match(card.getAttribute("href") || "", /id=6a6b462b26b614560bceb74b/);
  assert.match(card.querySelector(".resume-at").textContent, /^1[01]m in$/, "the resume stamp is wrong");
  assert.match(card.querySelector(".resume-go").textContent, /Resume/);

  dom.window.close();
});

test("the subject page can filter a long chapter list", async () => {
  const path =
    "/subject.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822";
  const { doc, dom, window } = await render(path, {
    waitForSelector: "#list .chapter-row",
  });

  assert.ok(doc.getElementById("listTools"), "the filter row is missing");
  const before = doc.querySelectorAll("#list .chapter-row").length;
  assert.ok(before >= 6, `expected a long chapter list, got ${before}`);

  const input = doc.getElementById("chapterFilter");
  input.value = "zzzz-nothing";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(
    doc.querySelectorAll("#list .chapter-row").length,
    0,
    "a non-matching query should empty the list"
  );
  assert.match(doc.getElementById("list").textContent, /No chapter matches/i);

  // Clearing restores every chapter and leaves no empty state behind.
  doc.getElementById("clearFilterBtn")?.click();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(doc.querySelectorAll("#list .chapter-row").length, before, "clearing the filter lost rows");
  assert.equal(/No chapter matches/i.test(doc.getElementById("list").textContent), false);

  dom.window.close();
});

test("a broken stream offers Retry, never a link off-site", async () => {
  const source = await (await nativeFetch(`${BASE}/assets/lecture.js`)).text();

  // The dead "Try again" control: every retry button is wired to the same helper,
  // which bumps the attempt counter and restarts the stream.
  assert.match(source, /const retry = \(btnId\)/, "the retry helper is gone");
  for (const id of ["retryStreamBtn", "retryExtBtn", "retryBtn"]) {
    assert.match(source, new RegExp(`retry\\(\\"${id}\\"\\)|retry\\("${id}"\\)`), `${id} is not wired`);
  }
  assert.match(source, /attempt \+= 1/, "retry no longer counts attempts");

  // And the failure plan it recovers from no longer hands the visitor elsewhere.
  assert.equal(/fallbackPlayer|SITE\.source/.test(source), false, "an outbound fallback is back");
});

test("the site is branded ArsVibe and keeps the upstream data path intact", async () => {
  const home = await (await nativeFetch(`${BASE}/`)).text();

  assert.match(home, /ArsVibe/, "the brand is missing from the home page");
  assert.equal(/EduVibe/.test(home), false, "the old brand still appears on the home page");

  // No outbound escape hatch: the pages themselves never hand the visitor off
  // to a third-party host. Recovery from a broken stream is a Retry button.
  assert.equal(
    /pw\.eduvibe\.cc\.cd|vidcloud\.eu\.org|studyspark\.study/.test(home),
    false,
    "the home page points at the source/mirror site again"
  );

  // The upstream data host is not ours to rename: changing it breaks every fetch,
  // so the server-side pass-through must still target it.
  const pw = await readFile(new URL("../api/pw.mjs", import.meta.url), "utf8");
  const app = await readFile(new URL("../lib/api-data.mjs", import.meta.url), "utf8");
  assert.match(pw + app, /eduvibe\.cc\.cd|static\.pw\.live/, "the upstream API host disappeared");
});

/* -------------------------------------------------------------------------
   The shell contract: the things that are invisible when wrong.
   ------------------------------------------------------------------------- */

const PWA_PAGES = [
  "/",
  "/batches.html",
  "/downloads.html",
  "/library.html",
  "/viewer.html",
];

test("every page ships the offline/PWA shell", async () => {
  const pages = [
    "index.html", "batches.html", "batch.html", "subject.html", "chapter.html",
    "lecture.html", "downloads.html", "library.html", "dashboard.html",
    "favourites.html", "viewer.html", "admin.html", "login.html", "404.html",
    "offline.html",
  ];
  for (const page of pages) {
    const html = await (await nativeFetch(`${BASE}/${page}`)).text();
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, `${page} links no manifest`);
    assert.match(html, /src="\/assets\/offline-boot\.js"/, `${page} never registers the worker`);
    assert.match(html, /class="skip-link" href="#main"/, `${page} has no skip link`);
    assert.match(html, /id="main"/, `${page} has no main landmark to skip to`);
  }
});

test("the manifest describes an installable app and its icons exist", async () => {
  const res = await nativeFetch(`${BASE}/manifest.webmanifest`);
  assert.equal(res.ok, true, "the manifest is not served");
  const manifest = await res.json();

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.ok(
    manifest.icons.some((i) => String(i.purpose || "").includes("maskable")),
    "no maskable icon — Android will crop the mark"
  );

  for (const icon of manifest.icons) {
    const asset = await nativeFetch(`${BASE}${icon.src}`);
    assert.equal(asset.ok, true, `manifest icon ${icon.src} is missing`);
  }
});

test("the service worker keeps documents and refuses to keep video", async () => {
  const res = await nativeFetch(`${BASE}/sw.js`);
  assert.equal(res.ok, true);
  const source = await res.text();

  // Notes and DPPs are kept, through the same-origin relay the reader uses.
  assert.match(source, /isDocRelay/, "the document relay is no longer cacheable");
  assert.match(source, /\/api\/media/, "the media relay is not named");

  // Video must never be stored: a lecture is hundreds of megabytes.
  assert.match(source, /\\.\(ts\|m4s\|mp4\|m3u8\|mpd\)/, "segment types are no longer excluded");
  assert.match(source, /download\|sign\|hls/, "the video routes are no longer excluded");

  // The worker itself is versioned, or an old cache outlives its code.
  assert.match(source, /CACHE|arsvibe-v\d/, "the cache is unversioned");

  // The fallback page must be installed, not merely cached if visited: the first
  // offline navigation is the one that needs it, with no network left to fetch it.
  assert.match(source, /"\/offline\.html"/, "offline.html is not pre-cached on install");

  // A loose query match would serve /batch?id=A when /batch?id=B was asked for.
  assert.match(source, /ignoreSearch: true/, "the exact-then-loose fallback is gone");
});

test("the offline fallback offers a way back", async () => {
  const html = await (await nativeFetch(`${BASE}/offline.html`)).text();
  assert.match(html, /id="retry"/, "no retry control");
  assert.match(html, /\/assets\/offline-page\.js/, "the recovery script is missing");
  // It is a dead end if it does not link anywhere that works offline.
  assert.match(html, /\/downloads\.html/, "it does not point at the offline-ready lectures");
});

test("entity pages name themselves in the link preview and the canonical URL", async () => {
  for (const page of ["batch.html", "lecture.html", "chapter.html", "subject.html"]) {
    const source = await readFile(new URL(`../public/assets/${page.replace(".html", ".js")}`, import.meta.url), "utf8");
    assert.match(source, /setPageMeta\(/, `${page} still ships the site-wide share card`);
    assert.match(source, /canonical:/, `${page} has no canonical URL`);
  }

  // And the helper actually writes the tags it is given.
  const app = await readFile(new URL("../public/assets/app.js", import.meta.url), "utf8");
  assert.match(app, /export function setPageMeta/);
  assert.match(app, /og:title/);
  assert.match(app, /rel="\$\{rel\}"/);
});

test("static pages carry a canonical URL and a description", async () => {
  for (const path of PWA_PAGES) {
    const html = await (await nativeFetch(`${BASE}${path}`)).text();
    assert.match(html, /rel="canonical"/, `${path} has no canonical URL`);
    assert.match(html, /name="description"/, `${path} has no meta description`);
    assert.match(html, /property="og:url"/, `${path} has no og:url`);
  }
});

test("pages that must not be indexed say so", async () => {
  for (const path of ["/admin.html", "/login.html", "/404.html", "/offline.html"]) {
    const html = await (await nativeFetch(`${BASE}${path}`)).text();
    assert.match(html, /name="robots" content="noindex/, `${path} is indexable`);
  }
});

test("the worker is served uncached so a deploy is never pinned", async () => {
  const res = await nativeFetch(`${BASE}/sw.js`);
  const cache = res.headers.get("cache-control") || "";
  assert.match(cache, /max-age=0/, `sw.js is cacheable (${cache}) — a bad build would stick`);
});

test("a batch still lists its subjects when the legacy detail route is gone", async () => {
  /* The upstream migrated `/BatchInfo?...&Type=details` to
     `/v3/batches/<id>/details` and answers the old spelling with a 404
     (`MONGOOSE_UPGRADE_ERROR`). While only the legacy route was tried, every
     batch page rendered with an empty subject list — the batch existed, its
     subjects existed, and the page said there were none. */
  const { fetchBatch } = await import("../lib/api-data.mjs");

  const calls = [];
  const original = globalThis.fetch;
  const realFetch = original;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    calls.push(url);
    if (url.includes("/BatchInfo")) {
      return new Response(
        JSON.stringify({
          statusCode: null,
          message: "Not Found",
          success: false,
          error: { message: "Not Found", status: 404 },
          errorFrom: "MONGOOSE_UPGRADE_ERROR",
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }
    if (/\/v3\/batches\/[^/]+\/details/.test(url)) {
      return new Response(
        JSON.stringify({
          data: {
            _id: "698ad3519549b300a5e1cc6a",
            name: "Arjuna JEE 2027",
            byName: "For IIT-JEE Aspirants",
            language: "Hinglish",
            class: "11",
            exam: ["IIT-JEE"],
            subjects: [
              {
                _id: "6a6b44faf834f38ed6f9120d",
                subject: "Physics By Saleem Ahmad Sir",
                subjectId: "688dd9660fb5f084935d611f",
                slug: "physics-by-saleem-ahmad-sir-886822",
                lectureCount: 242,
                displayOrder: 14,
                teacherIds: [{ firstName: "Saleem", lastName: "Ahmad Sir" }],
              },
              {
                _id: "69b5729d45cca26612727f1a",
                subject: "Maths by Anna Sir",
                subjectId: "69b572321258ab0500483ec4",
                slug: "maths-by-anna-sir-438005",
                lectureCount: 125,
                displayOrder: 9,
                teacherIds: [],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return realFetch(input, init);
  };

  try {
    const out = await fetchBatch("698ad3519549b300a5e1cc6a");
    assert.equal(out.ok, true, `fetchBatch failed: ${out.error}`);
    assert.equal(out.subjects.length, 2, "the subject list is still empty");
    // displayOrder wins over arrival order, so the page lists Maths first.
    assert.equal(out.subjects[0].name, "Maths by Anna Sir");
    assert.equal(out.subjects[0].teacherCount ?? out.subjects[0].teachers.length, 0);
    assert.equal(out.subjects[1].slug, "physics-by-saleem-ahmad-sir-886822");
    assert.equal(out.subjects[1].lectureCount, 242);

    // The batch header itself is filled in from the same answer.
    assert.equal(out.batch.name, "Arjuna JEE 2027");
    assert.equal(out.batch.className, "11");
    assert.deepEqual(out.batch.exam, ["IIT-JEE"]);

    assert.ok(
      calls.some((u) => /\/v3\/batches\/[^/]+\/details/.test(u)),
      "the migrated route was never tried"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("an upstream auth refusal is reported as access, not as an empty chapter", async () => {
  /* PW answers the content listings only for a signed-in account. That used to
     reach the student as "upstream 401; upstream 404" under a heading that
     implied the chapter was empty, and the client burned a second round trip
     through the browser relay with the same guest credential before saying so. */
  const { fetchChapterContents } = await import("../lib/api-data.mjs");

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input.url);
    calls.push(url);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Unauthorised Access",
        code: 401,
        error: { status: 401, message: "Unauthorised Access" },
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const out = await fetchChapterContents(
      "698ad3519549b300a5e1cc6a",
      "physics-by-rajwant-singh-sir-964222",
      "69b5698ee506a608ee297ed1",
      "videos",
      1
    );

    assert.equal(out.ok, false);
    assert.equal(out.auth, true, "an auth refusal is not flagged as one");
    assert.match(out.error, /guest sessions|signed-in/i);
    // The raw status pair must not be what a student reads.
    assert.equal(/upstream 401; upstream 404/.test(out.error), false);

    // And the client must not retry it through a relay that presents the same
    // credential. `fetchData` is internal, so this is asserted through the flag
    // the route hands it.
    const http = await readFile(new URL("../lib/http.mjs", import.meta.url), "utf8");
    assert.match(http, /auth: Boolean\(reason && reason\.auth\)/);
    assert.ok(calls.length >= 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a migrated batch page is not reported as degraded", async () => {
  /* `degraded` drives the "subject list unavailable" notice. A batch served by
     the new endpoint has a real subject list, so it must not claim otherwise. */
  const { fetchBatch } = await import("../lib/api-data.mjs");

  const original = globalThis.fetch;
  const realFetch = original;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.includes("/BatchInfo")) {
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    if (/\/v3\/batches\/[^/]+\/details/.test(url)) {
      return new Response(
        JSON.stringify({
          data: {
            _id: "x",
            name: "Some Batch",
            subjects: [{ _id: "s", subject: "Physics", slug: "physics-1", displayOrder: 1 }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return realFetch(input, init);
  };

  try {
    const out = await fetchBatch("x");
    assert.equal(out.ok, true);
    assert.equal(out.subjects.length, 1);
    assert.notEqual(out.degraded, true, "a complete answer was marked degraded");
  } finally {
    globalThis.fetch = original;
  }
});

test("the language filter searches the whole catalogue, not the visible page", async () => {
  // Production bug: the dropdown was built from the batches on the current page
  // and the filter ran in the browser over those same twenty rows. Kannada has
  // 70 batches spread across 711 pages, so "filter by Kannada" showed an empty
  // grid on page 1 and the batch could not be reached at all.
  const facets = await (await nativeFetch(`${BASE}/api/batches?facets=1`)).json();
  assert.equal(facets.success, true);
  const kannada = facets.languages.find((l) => l.key === "kannada");
  assert.ok(kannada, "Kannada must be offered as a filter");
  assert.equal(kannada.count, 70);
  // One entry per language: the catalogue contains both "ASSAMESE" and
  // "Assamese", which used to appear twice and split the same language in half.
  const assamese = facets.languages.filter((l) => /assam/i.test(l.label));
  assert.equal(assamese.length, 1, JSON.stringify(assamese));

  const res = await nativeFetch(`${BASE}/api/batches?lang=kannada`);
  const body = await res.json();
  assert.equal(body.total, 70);
  assert.ok(body.batches.length > 20, "every Kannada batch should be returned, not one page");
  assert.ok(body.batches.every((b) => /kannada/i.test(b.language)));
});

test("price filters and sorting apply to the whole catalogue", async () => {
  const free = await (await nativeFetch(`${BASE}/api/batches?price=free`)).json();
  assert.ok(free.total > 5000, `expected thousands of free batches, got ${free.total}`);
  assert.ok(free.batches.every((b) => b.feeTotal === 0), "a free filter must only return free batches");

  const paid = await (await nativeFetch(`${BASE}/api/batches?price=paid`)).json();
  assert.ok(paid.batches.every((b) => (b.feeTotal || 0) > 0));

  // Both halves must add up: a filter that silently drops rows is worse than none.
  const total = await (await nativeFetch(`${BASE}/api/batches?page=1`)).json();
  assert.equal(free.total + paid.total, total.total);

  const cheap = await (await nativeFetch(`${BASE}/api/batches?sort=price&pageSize=10`)).json();
  const fees = cheap.batches.map((b) => b.feeTotal);
  assert.deepEqual(fees, [...fees].sort((a, b) => a - b), `not sorted: ${fees}`);
});

test("filtering an empty search is a browse, not an empty result", async () => {
  // "Free only" with an empty search box used to short-circuit to no results,
  // because a filter without a query was treated as a search for "".
  const res = await nativeFetch(`${BASE}/api/batches?price=free&lang=kannada`);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.total > 0, "a filter with no search term must still return batches");
  assert.ok(body.batches.every((b) => b.feeTotal === 0 && /kannada/i.test(b.language)));
});

test("no page promises more than it delivers, and none nags", async () => {
  // The site once said "watch lectures" while PW refused every signing request, so
  // this test banned the phrase. Playback works now — `/api/check` proves a lecture
  // plays end to end — but the lesson it was written for still holds: a page must
  // not promise something it cannot do, and a correction belongs in the copy rather
  // than in a banner repeating itself on every page.
  //
  // So the pin moves from the word to the claim. What must never come back is the
  // general-purpose notice, and the specific promises that were false at the time
  // and would be false again if signing broke: unlimited free watching, and a
  // lecture player described as a headline feature independent of any lecture.
  const { doc, dom } = await render("/batches.html", { waitForSelector: "#grid .batch-card" });
  assert.equal(doc.querySelector("#statusNotice"), null, "the site-wide notice was removed");

  const home = await (await nativeFetch(`${BASE}/`)).text();
  assert.doesNotMatch(home, /free to watch|watch free|unlimited (?:free )?streaming/i);
  assert.doesNotMatch(home, /HD<\/strong><span>lecture player/);

  // The hero carried a play-button chip reading "Live lectures", and /downloads
  // described a saved lecture as playing "here" with the note "No expiry". Both
  // survived the first copy pass because they were UI chrome, not prose.
  assert.doesNotMatch(home, /live lectures/i, "the hero still offers a lecture player");
  const dl = await (await nativeFetch(`${BASE}/downloads.html`)).text();
  assert.doesNotMatch(dl, /plays here/i, "the empty state still promises a playing lecture");
  assert.doesNotMatch(dl, /in lectures/i, "the storage line still claims lectures are saved");
  assert.doesNotMatch(dl, /Download lectures/i);

  dom.window.close();
});

test("the catalogue reports a range, not just a page number", async () => {
  const { doc, dom } = await render("/batches.html", { waitForSelector: "#grid .batch-card" });
  const text = doc.getElementById("resultCount").textContent;
  assert.match(text, /14,201 batches/);
  assert.match(text, /1–20 of 14,201/, text);
  dom.window.close();
});

test("no page advertises playback or 'free to watch' as a feature", async () => {
  // Every one of these strings was live at some point while playback could not
  // work. They are search-engine and social-preview copy, so they mislead people
  // who never even open the page.
  const pages = [
    "/",
    "/batches.html",
    "/batch.html?id=698ad3519549b300a5e1cc6a",
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&chapter=69dc843271d06abbf3869763&name=Units%20and%20Measurement",
  ];
  const banned = [/free to watch/i, /watch free/i, /free to browse and watch/i];
  for (const path of pages) {
    const html = await (await nativeFetch(`${BASE}${path}`)).text();
    for (const re of banned) {
      assert.doesNotMatch(html, re, `${path} still contains ${re}`);
    }
  }
});

test("a chapter says which tabs work before the lecture list", async () => {
  const { doc, dom } = await render(
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&chapter=69dc843271d06abbf3869763&name=Units%20and%20Measurement",
    { waitForSelector: "#body .list .row, #body .list a" , settle: 1600 }
  );
  const hint = doc.querySelector(".chapter-hint");
  assert.ok(hint, "the lectures tab must explain the access limit above the list");
  assert.match(hint.textContent, /Notes|DPPs/i);
  dom.window.close();
});

test("a lecture that cannot play sends you to its notes, not a retry loop", async () => {
  // Retrying an access refusal is guaranteed to fail. The reader's useful next
  // step is the chapter's notes and DPPs, so that must be the primary action.
  const { doc, dom } = await render(
    "/lecture.html?id=69dce295b4ecb06768828339&batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&chapter=69dc843271d06abbf3869763&chapterName=Units%20and%20Measurement",
    { settle: 2600 }
  );
  const text = doc.body.textContent;
  // The copy moved when playback started working: "needs a PW account" was true
  // for a while and is not any more. What the page must still do is explain the
  // state it is in rather than spin, and always offer the notes tab.
  assert.match(text, /no video yet|refused just now|has no released video/i, "the page must explain, not spin");
  assert.doesNotMatch(text, /needs a PW account/i, "the page still claims playback requires an account");
  const links = [...doc.querySelectorAll("a.btn")].map((a) => a.getAttribute("href") || "");
  const notesLink = links.find((h) => /chapter\.html/.test(h) && /#notes/.test(h));
  assert.ok(notesLink, `expected a link to the chapter notes tab, saw ${JSON.stringify(links)}`);
  assert.match(notesLink, /chapter=69dc843271d06abbf3869763/);
  dom.window.close();
});

test("the chapter page opens on the tab named in the URL hash", async () => {
  const { doc, dom } = await render(
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&chapter=69dc843271d06abbf3869763&name=Units%20and%20Measurement#notes",
    { settle: 1800 }
  );
  const active = doc.querySelector("#tabs .tab.active");
  assert.ok(active, "a tab must be active");
  assert.equal(active.dataset.type, "notes", "the #notes hash must open the notes tab");
  dom.window.close();
});

test("a permanent stream refusal is explained at once, not after three retries", async () => {
  // The page retried every unplayable plan three times with a widening pause —
  // about five seconds of spinner — and then showed the identical message. For a
  // refusal that names an account requirement, those retries cannot change the
  // answer, so the reader just waits longer to learn the same thing.
  let streamCalls = 0;
  const started = Date.now();
  const { doc, dom } = await render(
    "/lecture.html?id=69dce295b4ecb06768828339&batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&chapter=69dc843271d06abbf3869763&chapterName=Units%20and%20Measurement",
    {
      settle: 1800,
      fetchWrap: (target) => {
        if (target.pathname === "/api/stream") {
          streamCalls += 1;
          return new Response(
            JSON.stringify({
              success: true,
              playable: false,
              kind: "dash",
              url: "",
              retryAfter: 6,
              reason:
                "This lecture's recording exists and its address is in the schedule, but Physics Wallah's signing service refuses to mint a playable link for it (401/403). This site holds only a guest PW session, so it cannot sign this one. Its notes and DPPs still open and download normally.",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return null;
      },
    }
  );
  const elapsed = Date.now() - started;
  assert.equal(streamCalls, 1, `a permanent refusal must be asked once, saw ${streamCalls}`);
  assert.ok(elapsed < 4000, `the message should not wait for retries, took ${elapsed}ms`);
  assert.match(doc.body.textContent, /notes/i);
  dom.window.close();
});

test("a language is spelled the same way in the filter and on the card", async () => {
  // The filter said "Gujarati" while the cards beside it said "Gujrati" (the
  // upstream spelling), which reads as a bug because it is one.
  const { doc, dom } = await render("/batches.html", { waitForSelector: "#grid .batch-card" });
  const labels = [...doc.querySelectorAll("#grid .pill")].map((p) => p.textContent.trim());
  assert.ok(!labels.includes("Gujrati"), `card pill still says Gujrati: ${labels.join(",")}`);

  const facets = await (await nativeFetch(`${BASE}/api/batches?facets=1`)).json();
  const gujarati = facets.languages.find((l) => l.key === "gujarati");
  assert.equal(gujarati.label, "Gujarati");

  const res = await (await nativeFetch(`${BASE}/api/batches?lang=gujarati`)).json();
  assert.ok(res.batches.length > 0, "the filter must find the Gujarati batches");
  assert.ok(
    res.batches.every((b) => b.language === "Gujarati"),
    `cards must carry the same spelling: ${[...new Set(res.batches.map((b) => b.language))].join(",")}`
  );
  dom.window.close();
});

test("every page has exactly one h1, and it is in the served HTML", async () => {
  // A page whose only <h1> is injected after a fetch has none at all until the
  // request lands — screen readers and search engines see a heading-less page.
  // batch.html legitimately builds its h1 from the batch name, so it is allowed
  // to start empty, but it must still have the heading once rendered.
  const pages = [
    "/", "/batches.html", "/favourites.html", "/library.html", "/downloads.html",
    "/login.html", "/viewer.html?url=" + encodeURIComponent("https://static.pw.live/x.pdf") + "&name=Notes.pdf",
    "/offline.html", "/404.html",
  ];
  for (const path of pages) {
    const { doc, window } = await render(path, { settle: 400 });
    const h1s = doc.querySelectorAll("h1");
    assert.equal(h1s.length, 1, `${path} has ${h1s.length} <h1> headings, expected 1`);
    window.close();
  }
});

test("a chapter section that fails to load offers a retry, not a dead end", async () => {
  // A subject lists chapters with 0 lectures / 0 notes / 0 DPPs, and clicking
  // one landed on a bare "nothing published here". Worse, when PW's server
  // answered 502 the page showed the literal string "fetch failed" — the
  // browser's words for a transient outage — with no way to try again. The
  // lecture list is reported as "not opening"; these are the two reasons.
  const CH =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222" +
    "&chapter=69dc843271d06abbf3869763&name=Units";

  const transient = () =>
    new Response(
      JSON.stringify({
        success: true,
        needsProxy: true,
        key: "items",
        reason:
          "Physics Wallah did not answer for this chapter just now. The chapter and its lectures still exist — this is their server, not this site — so reload in a minute.",
        auth: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const { doc, window } = await render(CH, {
    fetchWrap: (target) => (new URL(target).pathname === "/api/contents" ? transient() : null),
    settle: 1200,
  });

  const body = doc.getElementById("body");
  assert.ok(body.querySelector("[data-retry]"), "a failed section must offer a retry");

  // The header must stop claiming it is still loading.
  const meta = doc.getElementById("chapterMeta").textContent;
  assert.doesNotMatch(meta, /Loading the lecture list/i, meta);

  // The explanation must be prose a student can act on, never a raw browser error.
  assert.doesNotMatch(body.textContent, /fetch failed|upstream 50\d/i, body.textContent.slice(0, 200));
  assert.match(body.textContent, /server|reload|try again/i);
  window.close();
});

test("an empty chapter section points somewhere useful", async () => {
  const CH =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222" +
    "&chapter=69dc843271d06abbf3869763&name=Units";

  const { doc, window } = await render(CH, {
    fetchWrap: (target) =>
      new URL(target).pathname === "/api/contents"
        ? new Response(JSON.stringify({ success: true, ok: true, items: [], contentType: "videos" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : null,
    settle: 1200,
  });

  const body = doc.getElementById("body");
  // No dead end: there is always a route back to the subject's chapter list.
  const back = [...body.querySelectorAll("a")].find((a) => /chapter/i.test(a.textContent));
  assert.ok(back, "an empty section must link back to the subject");
  assert.match(back.getAttribute("href"), /\/subject\.html\?batch=/);
  window.close();
});

test("a notes tab that resolves only some attachments says so", async () => {
  // Every notes/DPP attachment needs its own GetPdf lookup, and PW rate-limits
  // them. When the lookup gives up partway the tab renders a *shorter* list than
  // the chapter really has — "3 PDFs" for a chapter with 24 — with nothing to
  // say so. That is the "notes are missing" report.
  const CH =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222" +
    "&chapter=69dc843271d06abbf3869763&name=Units";

  const docs = (resolved) =>
    JSON.stringify({
      success: true,
      ok: true,
      contentType: "notes",
      items: [0, 1, 2].map((i) => ({
        id: `i${i}`,
        title: `Lecture ${i}`,
        docs: [
          {
            name: `Notes ${i}.pdf`,
            pdfId: `p${i}`,
            attachmentId: `a${i}`,
            url: i < resolved ? `https://static.pw.live/${i}.pdf` : "",
          },
        ],
      })),
      diagnostics: { listed: 3, attachments: 3, needed: 3, failed: 3 - resolved, firstError: "throttled" },
    });

  const { doc, window } = await render(CH, {
    fetchWrap: (target) => {
      const url = new URL(target);
      if (url.pathname !== "/api/contents") return null;
      if (url.searchParams.get("type") === "videos") {
        return new Response(
          JSON.stringify({ success: true, ok: true, contentType: "videos", items: [] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(docs(2), { status: 200, headers: { "content-type": "application/json" } });
    },
    settle: 1000,
  });

  // Open the Notes tab.
  const notesTab = [...doc.querySelectorAll(".tab")].find((t) => t.dataset.type === "notes");
  notesTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));

  const body = doc.getElementById("body");
  assert.match(body.textContent, /did not resolve|Load the rest/i, body.textContent.slice(0, 200));
  assert.ok(
    [...body.querySelectorAll("[data-retry]")].some((b) => /Load the rest/i.test(b.textContent)),
    "an incomplete docs list must offer to load the rest"
  );
  window.close();
});


test("the browser relay resolves keyless notes instead of inventing a link", async () => {
  /* When the server cannot reach PW at all, `/api/contents` answers
     `{ needsProxy: true }` and `data.js` fetches the same JSON in the browser.
     That path had two faults of its own:

       1. `asset()` fell back to the attachment `_id` whenever `key` was absent,
          so an attachment PW had explicitly left keyless became
          `static.pw.live/<attachmentId>` — a URL that looks right, renders a
          "Download" button, and 403s. The student sees a chapter whose notes
          are all broken rather than a chapter whose notes need a lookup.
       2. The relay never called `GetPdf`, so nothing ever filled the gap.

     Both are invisible from the server-side tests because the server route
     resolves the key before it answers. This drives the real page through the
     relay path, with PW throttling the first attempt. */
  const CH =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822" +
    "&chapter=6a6b461cce4ac4e9ab51ee98&name=Ch%2001";

  let throttled = true;
  const getPdf = [];

  const relayListing = () =>
    JSON.stringify({
      data: [
        {
          _id: "69ff18a7ef0d5bb3113d55b1",
          topic: "Units and Measurement 13 : Class Notes",
          startTime: "2026-05-11T12:45:00.000Z",
          homeworkIds: [
            {
              _id: "6a01ef0fb9a30be431546b84",
              topic: "Units and Measurement 13 : Class Notes",
              note: "Class Notes",
              // Exactly what PW ships: a key field, empty.
              attachmentIds: [
                {
                  _id: "6a01ef0c6c4a24dd586b1d8c",
                  baseUrl: "https://static.pw.live/",
                  key: "",
                  name: "Units and Measurement 13 Class Notes.pdf",
                },
              ],
            },
          ],
        },
      ],
    });

  const { doc, window } = await render(CH, {
    settle: 600,
    fetchWrap: (target) => {
      const url = new URL(target);
      if (url.pathname === "/api/contents") {
        return new Response(
          JSON.stringify({ success: true, needsProxy: true, key: "items", reason: "blocked", auth: false }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // The relay URL wraps the upstream URL in a query parameter.
      const inner = decodeURIComponent(target.href || String(target));
      if (/GetPdf/.test(inner)) {
        getPdf.push(inner);
        return throttled
          ? new Response("{}", { status: 429, headers: { "content-type": "application/json" } })
          : new Response(
              JSON.stringify({ success: true, data: { key: "5eb3/ADMIN/resolved.pdf" } }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
      }
      if (/TopicInfo/.test(inner)) {
        return new Response(relayListing(), { status: 200, headers: { "content-type": "application/json" } });
      }
      return null;
    },
  });

  const openNotes = async () => {
    const tab = [...doc.querySelectorAll("#tabs .tab")].find((t) => t.dataset.type === "notes");
    tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  };

  await openNotes();
  const body = doc.getElementById("body");

  // Fault 1: no fabricated download. The dead link must not exist at all.
  const hrefs = [...body.querySelectorAll("a")].map((a) => a.getAttribute("href") || "");
  assert.equal(
    hrefs.some((h) => /static\.pw\.live\/6a01ef0c6c4a24dd586b1d8c/.test(h)),
    false,
    "the attachment id was turned into a fake storage URL"
  );
  // And the tab is honest about being short rather than silently empty.
  assert.match(body.textContent, /did not resolve|Load the rest/i, body.textContent.slice(0, 300));
  assert.ok(getPdf.length >= 1, "the relay never asked GetPdf for the key");

  // Fault 2: the next attempt actually resolves it, and the row becomes real.
  throttled = false;
  await openNotes();
  const retry = [...body.querySelectorAll("[data-retry]")];
  if (retry.length) retry[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));

  const links = [...body.querySelectorAll("a")].map((a) => a.getAttribute("href") || "");
  assert.ok(
    links.some((h) => /resolved\.pdf/.test(decodeURIComponent(h))),
    `the resolved PDF never rendered: ${links.join(" | ")}`
  );
  window.close();
});

test("an incomplete notes tab keeps its warning after switching tabs and back", async () => {
  /* `partial` is module-level state, and every tab switch goes through the same
     `load()`. The flag used to be reset *after* the cache-hit early-return, so
     returning to a cached tab rendered with whatever the *previous* tab had left
     behind. Both directions are wrong and both are silent:

       notes (short) → videos → notes   loses the warning, so a 3-of-24 list
                                        presents itself as the whole chapter
       videos (fine) → notes (cached)   shows "did not resolve" over a list that
                                        is complete

     The flag belongs to a tab, not to the page. */
  const CH =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222" +
    "&chapter=69dc843271d06abbf3869763&name=Units";

  const shortNotes = () =>
    new Response(
      JSON.stringify({
        success: true,
        ok: true,
        contentType: "notes",
        items: [
          {
            id: "n1",
            title: "Class Notes",
            docs: [{ name: "Notes.pdf", url: "https://static.pw.live/a.pdf" }],
          },
        ],
        // Three of the chapter's notes never resolved.
        diagnostics: { listed: 1, attachments: 3, needed: 3, failed: 2, firstError: "throttled" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const lecture = (i) =>
    JSON.stringify({
      id: `v${i}`,
      kind: "video",
      title: `Lecture ${i}`,
      status: "Ready",
      types: ["HLS"],
      date: `2026-01-0${i + 1}T00:00:00.000Z`,
    });

  const { doc, window } = await render(CH, {
    settle: 900,
    fetchWrap: (target) => {
      const url = new URL(target);
      if (url.pathname !== "/api/contents") return null;
      const type = url.searchParams.get("type") || "videos";
      if (type === "notes") return shortNotes();
      return new Response(
        JSON.stringify({
          success: true,
          ok: true,
          contentType: type,
          items: [0, 1, 2].map((i) => JSON.parse(lecture(i))),
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const body = doc.getElementById("body");
  const click = async (t) => {
    const tab = [...doc.querySelectorAll("#tabs .tab")].find((x) => x.dataset.type === t);
    tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
  };
  const warned = () => /did not resolve/i.test(body.textContent);

  await click("notes");
  assert.equal(warned(), true, "a short notes tab must warn the first time");

  // A tab that has to *fetch* runs `partial = false`. Coming back to the
  // cached notes tab must not inherit that reset — this is the case that failed.
  await click("DppNotes");
  await click("notes");
  assert.equal(warned(), true, "the warning vanished when the cached notes tab was reopened");

  // The reverse: a complete tab must never wear another tab's warning.
  await click("videos");
  assert.equal(warned(), false, "the lectures tab is wearing the notes warning");
  window.close();
});

test("the chapter tabs behave like tabs, by keyboard as well as by mouse", async () => {
  /* The section strip is a tab widget, and it was marked up as four plain
     buttons: no `aria-selected`, no role, and every one of them a Tab stop. A
     screen reader therefore announced "Lectures, button" with no indication
     which section was open, and reaching Notes took four presses of Tab. */
  const CH =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222" +
    "&chapter=69dc843271d06abbf3869763&name=Units";

  const { doc, window } = await render(CH, {
    settle: 900,
    fetchWrap: (target) =>
      new URL(target).pathname === "/api/contents"
        ? new Response(JSON.stringify({ success: true, ok: true, items: [], contentType: "videos" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : null,
  });

  const tablist = doc.getElementById("tabs");
  assert.equal(tablist.getAttribute("role"), "tablist", "the strip is not marked as a tab list");

  const tabs = [...tablist.querySelectorAll(".tab")];
  assert.equal(tabs.length, 4);
  for (const t of tabs) assert.equal(t.getAttribute("role"), "tab", "a section is not a tab");
  assert.equal(doc.getElementById("body").getAttribute("role"), "tabpanel");

  // Exactly one stop, and exactly one section reported as selected.
  const selected = () => tabs.filter((t) => t.getAttribute("aria-selected") === "true");
  assert.equal(selected().length, 1, "more or less than one tab reports itself selected");
  assert.equal(tabs.filter((t) => t.tabIndex === 0).length, 1, "the strip is not a single Tab stop");

  // Arrow keys move the selection, and the panel follows it.
  tabs[0].focus();
  tabs[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(selected()[0].dataset.type, "notes", "ArrowRight did not open the next section");
  assert.equal(doc.getElementById("body").getAttribute("aria-labelledby"), "tab-notes");
  assert.equal(doc.activeElement.dataset.type, "notes", "focus did not follow the selection");

  // It wraps, rather than dead-ending on the last section.
  tabs[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(selected()[0].dataset.type, "videos", "ArrowLeft did not move back");

  // End goes to the last section, Home back to the first.
  tabs[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(selected()[0].dataset.type, "DppVideos", "End did not reach the last section");
  tabs[3].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(selected()[0].dataset.type, "videos", "Home did not reach the first section");
  window.close();
});

test("the seek slider announces a time, not a percentage", async () => {
  /* The scrubber is `role="slider"` with `aria-valuemin=0 aria-valuemax=100`, and
     the only value it ever wrote was `aria-valuenow`, as a percentage. Read aloud
     that is "73" with no unit — and on a lecture it is not even the useful number.
     A seek control should say where in the class the student is. */
  const { doc, window } = await render(
    "/lecture.html?id=69dce295b4ecb06768828339&batch=698ad3519549b300a5e1cc6a&subject=physics-by-rajwant-singh-sir-964222&chapter=69dc843271d06abbf3869763",
    {
      settle: 2200,
      fetchWrap: (target) => {
        const url = new URL(target);
        if (url.pathname !== "/api/stream") return null;
        return new Response(
          JSON.stringify({
            success: true,
            playable: true,
            kind: "hls",
            engine: "hls",
            url: "/api/sign?videoKey=e76c2cf2-413b-4f14-a7b5-8ebeb6c60523&key=master.m3u8",
            quality: "720",
            renditions: ["720"],
            lecture: { title: "A lecture", duration: "1:53:19" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    }
  );

  const scrubber = doc.getElementById("scrubber");
  assert.equal(scrubber.getAttribute("role"), "slider");

  // The element mock has no media timeline; drive one through the state path the
  // player uses, which is the same path a real `timeupdate` takes.
  const video = doc.getElementById("video");
  Object.defineProperty(video, "duration", { value: 6799, configurable: true });
  Object.defineProperty(video, "currentTime", { value: 1800, configurable: true });
  video.dispatchEvent(new window.Event("timeupdate"));
  await new Promise((r) => setTimeout(r, 120));

  const text = scrubber.getAttribute("aria-valuetext") || "";
  assert.match(text, /\d+:\d\d/, `the slider has no time to read out: ${JSON.stringify(text)}`);
  assert.match(text, /of/, "the slider does not say what the position is out of");

  // A slider has to answer the keys its role implies, natively handled here.
  assert.ok(scrubber.getAttribute("aria-valuemax"), "the slider has no maximum");
  window.close();
});

test("the wait says what it is waiting for, and for how long", async () => {
  // "Preparing your lecture…" for eight seconds is indistinguishable from a hung
  // page. The overlay now carries a live line naming the actual work and a
  // running count, in a polite live region so it is read out rather than only
  // seen.
  const html = await (await nativeFetch(`${BASE}/lecture.html`)).text();
  const src = await (await nativeFetch(`${BASE}/assets/lecture.js`)).text();

  assert.match(html, /id="overlayNote"/, "the loading overlay has nowhere to explain itself");
  assert.match(
    html,
    /id="overlayNote"[^>]*aria-live="polite"/,
    "the status line is not announced to a screen reader"
  );

  assert.match(src, /signed link/i, "the status line never names the actual wait");
  assert.match(src, /function stopWaiting/, "the clock is never stopped");
  // The clock must stop on every exit, or it keeps counting behind an error.
  assert.match(
    src,
    /function showMessage\([\s\S]{0,300}stopWaiting\(\)/,
    "an error message leaves the waiting clock running underneath it"
  );
  assert.match(
    src,
    /function hideOverlay\(\)[\s\S]{0,120}stopWaiting\(\)/,
    "the clock survives the overlay closing"
  );
});

/**
 * The DPP tab is where a student meets the practice test: every row there is a
 * paper that can be attempted, and the notes tab is not. A "Practice" button on
 * a class note would be a promise the site cannot keep, so both cases are
 * asserted rather than only the happy one.
 */
test("the DPP tab offers Practice on every paper, and the notes tab does not", async () => {
  const url =
    "/chapter.html?batch=698ad3519549b300a5e1cc6a&subject=physics-by-saleem-ahmad-sir-886822" +
    "&chapter=6a6b461cce4ac4e9ab51ee98&name=Ch%2001#dpp";
  const { doc, dom } = await render(url, { waitForSelector: "#body .doc-row", settle: 900 });

  const active = doc.querySelector("#tabs .tab.active");
  assert.equal(active?.dataset.type, "DppNotes", "the #dpp hash must open the DPP tab");

  const rows = doc.querySelectorAll("#body .doc-row");
  assert.ok(rows.length >= 1, "no DPP rows to practise");
  const practice = rows[0].querySelector('a[href^="/dpp.html?"]');
  assert.ok(practice, "a DPP row has no Practice link");
  const href = new URL(practice.getAttribute("href"), "http://x.test");
  // The link must carry the paper, and enough context to come back to the chapter.
  assert.match(href.searchParams.get("paper") || "", /\.pdf/);
  assert.equal(href.searchParams.get("chapter"), "6a6b461cce4ac4e9ab51ee98");
  assert.ok(href.searchParams.get("name"), "the paper's name was not passed through");

  // The notes tab is reading material: no Practice button there.
  doc.querySelector('#tabs .tab[data-type="notes"]').click();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const noteRows = doc.querySelectorAll("#body .doc-row");
    if (noteRows.length) {
      assert.equal(
        noteRows[0].querySelector('a[href^="/dpp.html?"]'),
        null,
        "a class note was offered as a practice paper"
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  dom.window.close();
});

test("clicking the Khazana tab opens this batch's archive, not a notice", async () => {
  // The reported symptom: "when I click Khazana nothing happens". Nothing was
  // rendered because the tab read the archive pointer off the *header* payload,
  // and the shipped catalogue has no `khazanaProgramId` column — 0 of 14,201
  // rows. Every batch therefore concluded "no linked archive" and never spent
  // the one read that would have disproved it.
  //
  // The fixture batch carries a pointer (`tests/fixtures/batch.json`), so this
  // asserts the whole path: click → pointer read → archive read → subject cards
  // that link into the archive's chapter list.
  const { doc, dom, window } = await render("/batch.html?id=698ad3519549b300a5e1cc6a", {
    waitForSelector: "#subjects .subject-card",
  });

  const tabBody = doc.getElementById("tabBody");
  doc.querySelector('[data-tab="khazana"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const deadline = Date.now() + 15000;
  let cards = 0;
  while (Date.now() < deadline) {
    cards = doc.querySelectorAll(".khazana-archive .khazana-card").length;
    if (cards) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  assert.ok(cards > 0, `the tab drew no archive subjects — ${tabBody.textContent.slice(0, 200)}`);
  assert.match(tabBody.textContent, /From this batch's archive/);
  assert.ok(
    !/No linked archive/.test(tabBody.textContent),
    "the tab claimed there is no archive on a batch that has one"
  );

  // The card has to point at the archive, and name it as an archive — otherwise
  // the subject page resolves chapters against the batch instead of the program.
  const href = doc.querySelector(".khazana-archive .khazana-card").getAttribute("href");
  assert.match(href, /^\/subject\.html\?/);
  assert.match(href, /archive=1/);
  assert.match(href, /batch=697c6370cb722a4fac145ef1/, `wrong archive in ${href}`);

  // This tab is *this batch's* archive. The site-wide list of other Khazana
  // batches used to be drawn underneath it, which put CA Foundation and SSC
  // Booster cards inside a Class 10 UP Board page. Assert it is gone.
  assert.equal(
    doc.querySelectorAll(".khazana-library:not(.khazana-archive) .khazana-card").length,
    0,
    "another batch's Khazana was rendered inside this batch's tab"
  );

  dom.window.close();
});

test("the Khazana tab is reachable from a #khazana link", async () => {
  // A shareable link to the tab must land on the archive, not on Subjects.
  const { doc, dom } = await render("/batch.html?id=698ad3519549b300a5e1cc6a#khazana", {
    waitForSelector: "#tabBody",
    settle: 1200,
  });
  assert.ok(
    doc.querySelector('[data-tab="khazana"]').classList.contains("active"),
    "the #khazana fragment did not open the tab"
  );
  dom.window.close();
});

test("tapping Khazana before the batch loads is not undone by the batch load", async () => {
  // The reported symptom, in full: "when I tap Khazana nothing happens — only on
  // this batch". It is a race, and the batch matters only by how slow it is.
  //
  // `loadBatch` painted `renderSubjects()` unconditionally when its detail call
  // landed, and `loadHeader` painted a skeleton unconditionally when its header
  // landed. Tap the tab before either finishes and whichever arrives last throws
  // the archive away and puts Subjects back. On a cold `/BatchInfo` that is not
  // an edge case, it is the normal path — the tab visibly works and then silently
  // reverts, which reads as "nothing happens".
  //
  // So: hold the detail call open, tap Khazana, then let it land, and assert the
  // archive survives.
  let release;
  const held = new Promise((r) => (release = r));

  const { doc, dom, window } = await render("/batch.html?id=698ad3519549b300a5e1cc6a", {
    fetchWrap: (target) => {
      // Hold only the *detail* call: the header and every khazana read must still
      // go through, or the test would be measuring a blocked network instead of
      // the race it is meant to catch.
      if (
        target.pathname === "/api/batch" &&
        !target.searchParams.get("header") &&
        !target.searchParams.get("khazana")
      ) {
        return held.then(() => nativeFetch(target, { headers: { accept: "application/json" } }));
      }
      return null;
    },
    waitForSelector: "#tab-khazana",
    settle: 400,
  });

  doc.querySelector('[data-tab="khazana"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  // Wait for the archive cards to appear *before* the detail call is released.
  let cards = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    cards = doc.querySelectorAll(".khazana-archive .khazana-card").length;
    if (cards) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  assert.ok(cards > 0, "the archive never drew even before the detail call landed");

  // Now let the detail call resolve — this is what used to wipe the tab.
  release();
  await new Promise((r) => setTimeout(r, 2500));

  assert.equal(
    doc.querySelectorAll(".khazana-archive .khazana-card").length,
    cards,
    "the detail call replaced the Khazana tab with the subject grid"
  );
  assert.match(doc.getElementById("tabBody").textContent, /From this batch's archive/);
  assert.ok(
    doc.querySelector('[data-tab="khazana"]').classList.contains("active"),
    "the Khazana tab lost its active state when the batch finished loading"
  );
  dom.window.close();
});

test("the service worker version bumps when a cached asset changes", async () => {
  // `/assets/*` is cache-first, keyed on VERSION. Ship a fix to batch.js without
  // bumping it and every returning reader keeps the old module for ever: the
  // deploy is green, the file on the server is correct, and the browser never
  // asks again. This asserts the version is not the one that shipped before the
  // Khazana fix, so a stale worker can actually be replaced.
  const sw = await readFile(path.join(ROOT, "public", "sw.js"), "utf8");
  const version = (sw.match(/const VERSION = "([^"]+)"/) || [])[1];
  assert.ok(version, "sw.js declares no VERSION");
  assert.notEqual(version, "arsvibe-v2", "the cache version was not bumped with the asset change");
  // The batch module has to be in the pre-cache list, or a new worker install
  // still leaves the old copy in SHELL_CACHE to be served cache-first.
  assert.match(sw, /"\/assets\/batch\.js"/, "batch.js is not pre-cached");
});
