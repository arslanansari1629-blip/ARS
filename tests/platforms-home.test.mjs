import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("the home page opens with a Choose Platform selector: two live platforms, logo first", async () => {
  const page = await read("public/index.html");
  assert.match(page, /id="platforms"/, "platform selector section is missing");
  assert.match(page, /Choose Platform/, "section heading is missing");

  // Both platforms we actually run, each a real link to its page.
  assert.match(page, /href="\/batches\.html"[^>]*data-status="live"|data-status="live"[^>]*href="\/batches\.html"/, "PW card must link live to the PW page");
  assert.match(page, /href="\/allen\.html"/, "Allen card must link to the Allen page");

  // Logos ship locally (no hotlinked third-party logos to rot).
  assert.match(page, /\/assets\/platforms\/pw\.png/, "PW logo must be a local asset");
  assert.match(page, /\/assets\/platforms\/allen\.jpg/, "Allen logo must be a local asset");
  await access(new URL("../public/assets/platforms/pw.png", import.meta.url));
  await access(new URL("../public/assets/platforms/allen.jpg", import.meta.url));

  // The selector sits above the personalised sections — it is the
  // front door, not a footer link.
  assert.ok(page.indexOf('id="platforms"') < page.indexOf('id="trending"'), "platform picker must precede trending");
  // And the hero routes to it.
  assert.match(page, /href="#platforms"/, "hero must carry a Choose Platform CTA");
});

test("platform cards never depend on animation or JS to be visible, and counts/filter are garnish", async () => {
  const css = await read("public/assets/arsvibe.css");
  const block = css.slice(css.indexOf("Choose Platform (home)"));
  assert.ok(block.length > 200, "platform styles are missing");
  assert.doesNotMatch(block, /opacity:\s*0/, "platform cards must not start hidden (white-grid lesson)");
  assert.doesNotMatch(block, /animation:/, "platform cards must not gate visibility on an animation");

  const js = await read("public/assets/home.js");
  assert.match(js, /platformPwCount/, "PW count wiring is missing");
  assert.match(js, /platformAllenCount/, "Allen count wiring is missing");
  assert.match(js, /data-pfilter/, "chip filter wiring is missing");
  assert.match(js, /\/api\/allen\?view=batches/, "Allen count must come from the live catalogue");
});
