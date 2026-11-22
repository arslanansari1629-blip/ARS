/**
 * Upgrade-round pins.
 *
 * The sidebar refresh, the player's playback tools and the admin
 * student-side health strip are all progressive enhancements: remove
 * any one of them and the site still renders, which is exactly why
 * each is asserted here against the shipped source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("sidebar: Practice group links DPP, live and leaderboard", () => {
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /key: "practice"/);
  assert.match(shell, /href: "\/dpp\.html", label: "DPP tests", icon: "target"/);
  assert.match(shell, /href: "\/live\.html", label: "Live now", icon: "live"/);
  assert.match(shell, /href: "\/leaderboard\.html", label: "Leaderboard", icon: "trophy"/);
});

test("sidebar: live links carry the pulse dot, icons exist", () => {
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /side-live-dot/);
  assert.match(shell, /target: '<circle/);
  assert.match(shell, /live: '<circle/);
});

test("shell css: rail tooltips, aurora active row, live pulse", () => {
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /body\.side-rail \.side-link::after/);
  assert.match(css, /content: attr\(data-label\)/);
  assert.match(css, /@keyframes side-live-pulse/);
  assert.match(css, /\.player-stats/);
});

test("player: stats overlay and snapshot button ship in player-plus", () => {
  const plus = read("public/assets/player-plus.js");
  assert.match(plus, /id = "statsBtn"/);
  assert.match(plus, /id = "snapBtn"/);
  assert.match(plus, /getVideoPlaybackQuality/);
  assert.match(plus, /ars-frame-/);
});

test("admin: student-side health strip polls /api/token", () => {
  const html = read("public/admin.html");
  const js = read("public/assets/admin.js");
  assert.match(html, /id="publicHealth"/);
  assert.match(html, /id="phSigner"/);
  assert.match(html, /id="phPlayback"/);
  assert.match(js, /paintPublicHealth/);
  assert.match(js, /lectureSigning/);
});
