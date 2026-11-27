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

test("Next Toppers is a third LIVE platform card once its platform shipped", async () => {
  const page = await read("public/index.html");
  assert.match(page, /data-platform="next-toppers"/, "Next Toppers card is missing");
  assert.match(page, /href="\/nexttopper"[^>]*data-status="live"|data-status="live"[^>]*href="\/nexttopper"/, "NT card must link live to /nexttopper");
  assert.match(page, /\/assets\/platforms\/next-toppers\.jpg/, "Next Toppers logo must be a local asset");
  await access(new URL("../public/assets/platforms/next-toppers.jpg", import.meta.url));
  // A live platform must not keep wearing a coming-soon badge: the
  // section may exist (Vidyakul waits there), but NT's own card is live.
  const ntCard = page.match(/<a class="platform-card"[^>]*data-platform="next-toppers"[^>]*>/)?.[0] || "";
  assert.doesNotMatch(ntCard, /is-soon|Coming Soon/, "the live NT card must not wear a coming-soon badge");
  const js = await read("public/assets/landing.js");
  assert.match(js, /platformNtCount/, "NT count wiring is missing");
  assert.match(js, /\/api\/nexttopper\?view=batches/, "NT count must come from its live catalogue");
});

test("the sidebar lives on the PW platform page, not the front door, and the NT logo is square", async () => {
  const shell = await read("public/assets/shell.mjs");
  assert.match(shell, /page !== "home"/, "the shell must skip the sidebar on the home page");
  assert.match(shell, /no-shell/, "home must be marked sidebar-free");
  const pw = await read("public/batches.html");
  assert.match(pw, /data-page="batches"/, "PW page identity missing");
  assert.match(pw, /\/assets\/shell\.mjs/, "PW platform page must load the shell (and its sidebar)");
  // The NT logo asset is a square canvas (the wide banner used to be
  // centre-cropped into the square platform slot and lose its edges).
  const logo = await readFile(new URL("../public/assets/platforms/next-toppers.jpg", import.meta.url));
  let w = 0, h = 0;
  for (let i = 2; i < logo.length - 9; i++) {
    if (logo[i] === 0xff && (logo[i + 1] === 0xc0 || logo[i + 1] === 0xc2)) {
      h = logo.readUInt16BE(i + 5);
      w = logo.readUInt16BE(i + 7);
      break;
    }
  }
  assert.ok(w > 0 && w === h, `NT logo must be square, got ${w}x${h}`);
});

test("Vidyakul waits in Coming Soon with its real logo and no live promises", async () => {
  const page = await read("public/index.html");
  const section = page.match(/<section class="section coming-soon-section" id="coming-soon">[\s\S]*?<\/section>/)?.[0] || "";
  assert.ok(section, "the coming-soon section is missing");
  assert.match(section, /data-platform="vidyakul"/, "Vidyakul card is missing from Coming Soon");
  assert.match(section, /data-status="soon"/, "Vidyakul must be marked soon, not live");
  assert.match(section, /\/assets\/platforms\/vidyakul\.jpg/, "Vidyakul logo must be a local asset");
  assert.match(section, /Coming Soon/, "the coming-soon badge is missing");
  // A soon card must not be a dead link or claim to be openable.
  assert.doesNotMatch(section, /<a[^>]*data-platform="vidyakul"/, "Vidyakul must not be an anchor yet");
  assert.doesNotMatch(section, /data-status="live"/, "Vidyakul must not claim LIVE");
  await access(new URL("../public/assets/platforms/vidyakul.jpg", import.meta.url));
  // The three live platforms stay in the live grid, untouched.
  const grid = page.match(/<div class="platforms-grid" id="platformsGrid">[\s\S]*?<\/div>/)?.[0] || "";
  assert.doesNotMatch(grid, /vidyakul/i, "Vidyakul belongs in Coming Soon, not the live grid");
  const css = await read("public/assets/home-landing.css");
  assert.match(css, /data-platform="vidyakul"/, "Vidyakul accent styling is missing");
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
