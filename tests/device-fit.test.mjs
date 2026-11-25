/**
 * Device Auto-Fit + Player Fit.
 *
 * The site must fit the screen it is opened on — a phone gets a phone
 * layout, a laptop a laptop layout, automatically — and the player's
 * Fit button must keep every button on screen in every mode. The
 * classifier is pure and tested as such; the wiring (which files carry
 * it, which CSS keys off it) is pinned so a tidy-up cannot quietly
 * unplug the system.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyDevice } from "../public/assets/device.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the classifier names the screen it is given", () => {
  assert.equal(classifyDevice({ width: 390, height: 844, coarse: true }), "phone");
  assert.equal(classifyDevice({ width: 844, height: 390, coarse: true }), "phone", "a landscape phone is still a phone");
  assert.equal(classifyDevice({ width: 820, height: 1180, coarse: true }), "tablet");
  assert.equal(classifyDevice({ width: 1440, height: 900 }), "laptop");
  assert.equal(classifyDevice({ width: 2560, height: 1440 }), "desktop");
});

test("every page family loads the device system", () => {
  assert.match(read("public/assets/shell.mjs"), /import "\.\/device\.js"/, "shell pages lost Auto-Fit");
  for (const page of ["public/admin.html", "public/login.html", "public/open.html"]) {
    assert.match(read(page), /assets\/device\.js/, `${page} lost Auto-Fit`);
  }
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /data-device="phone"/);
  assert.match(css, /data-device="desktop"/);
  assert.match(css, /--app-height/);
});

test("the player has a Fit button and every mode keeps the buttons", () => {
  const html = read("public/watch.html");
  assert.match(html, /id="fitBtn"/);
  const lecture = read("public/assets/lecture.js");
  assert.match(lecture, /cycleFit/);
  assert.match(lecture, /arsvibe\.player\.fit/, "the fit choice is not remembered");
  assert.match(lecture, /const target = root \|\| stage \|\| video/, "fullscreen must take the buttons with it");
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /\[data-fit="fill"\] video \{ object-fit: cover/);
  assert.match(css, /\[data-fit="stretch"\] video \{ object-fit: fill/);
  assert.match(css, /#playerRoot:fullscreen/);
  assert.match(css, /\.player-bar \{ flex-wrap: wrap/, "the bar can still hide buttons off its edge");
});

test("buffer-free sizing follows the device", () => {
  const player = read("public/assets/player.js");
  assert.match(player, /onPhone \? 240 : 600/, "read-ahead no longer reaches ten minutes on a big screen");
  assert.match(player, /dataset\.device/, "buffer sizing ignores the device classification");
});
