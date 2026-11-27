import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("the home page is the NextHope-style landing: tickers, hero, Choose Platform — nothing else", async () => {
  const page = await read("public/index.html");
  // Tickers + hero, NextHope shape.
  assert.match(page, /nh-tickers/, "scrolling tickers are missing");
  assert.match(page, /FREE COURSES · NO SIGNUP/, "ticker claims are missing");
  assert.match(page, /Stop paying/, "hero headline is missing");
  assert.match(page, /India's free learning hub/, "hero eyebrow is missing");
  // The platform picker is the page's centre of gravity.
  assert.match(page, /id="platforms"/, "platform selector section is missing");
  assert.match(page, /Choose Platform/, "section heading is missing");
  assert.match(page, /href="#platforms"/, "hero must carry a Choose Platform CTA");

  // Both platforms we actually run, each a real link to its page.
  assert.match(page, /href="\/batches\.html"[^>]*data-status="live"|data-status="live"[^>]*href="\/batches\.html"/, "PW card must link live to the PW page");
  assert.match(page, /href="\/allen\.html"/, "Allen card must link to the Allen page");

  // Logos ship locally (no hotlinked third-party logos to rot).
  assert.match(page, /\/assets\/platforms\/pw\.png/, "PW logo must be a local asset");
  assert.match(page, /\/assets\/platforms\/allen\.jpg/, "Allen logo must be a local asset");
  await access(new URL("../public/assets/platforms/pw.png", import.meta.url));
  await access(new URL("../public/assets/platforms/allen.jpg", import.meta.url));

  // The old catalogue-home is gone: no study hub, no trending rail, no
  // goal grid, no continue rail, no hero search — the landing is the
  // front door to the platforms, not a second catalogue.
  for (const gone of ["hubSection", "recoSection", "trendingGrid", "goalGrid", "continueRail", "homeLiveSection", "heroSearch", "catalogGrid", "introSheet"]) {
    assert.doesNotMatch(page, new RegExp(gone), `old home section #${gone} must be removed`);
  }
  assert.doesNotMatch(page, /home\.js/, "the old home module must not load");
  assert.doesNotMatch(page, /open\.js/, "the opening-sheet module must not load on the landing");
});

test("landing content never depends on animation or JS to be visible, and counts/filter are garnish", async () => {
  const css = await read("public/assets/home-landing.css");
  assert.doesNotMatch(css, /\.platform-card[^}]*opacity:\s*0/s, "platform cards must not start hidden (white-grid lesson)");

  const js = await read("public/assets/landing.js");
  assert.match(js, /platformPwCount/, "PW count wiring is missing");
  assert.match(js, /platformAllenCount/, "Allen count wiring is missing");
  assert.match(js, /data-pfilter/, "chip filter wiring is missing");
  assert.match(js, /\/api\/allen\?view=batches/, "Allen count must come from the live catalogue");
  assert.match(js, /\/api\/batches\?facets=1/, "PW count must come from the live catalogue facets");

  const page = await read("public/index.html");
  assert.match(page, /home-landing\.css/, "landing stylesheet must be linked");
  assert.match(page, /landing\.js/, "landing module must be linked");
});
