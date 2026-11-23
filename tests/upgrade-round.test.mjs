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

test("notifications: bell, badge and mark-all-read ship in the shell", () => {
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /buildNotifications/);
  assert.match(shell, /id="notifBtn"/);
  assert.match(shell, /Mark all read/);
  assert.match(shell, /announcements=1/);
});

test("player: audio-only screen-off mode ships in player-plus", () => {
  const plus = read("public/assets/player-plus.js");
  assert.match(plus, /id = "audioBtn"/);
  assert.match(plus, /audio-only/);
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /\.player-wrap\.audio-only video/);
  assert.match(css, /\.notif-panel/);
});

test("advanced round: dark theme tokens and toggle ship", () => {
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /color-scheme: dark/);
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /buildThemeToggle/);
  assert.match(shell, /setPref\("theme"/);
});

test("advanced round: shortcuts sheet, scroll progress, net pill, install door", () => {
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /keysSheet/);
  assert.match(shell, /scrollProgress/);
  assert.match(shell, /netPill/);
  assert.match(shell, /beforeinstallprompt/);
});

test("advanced round: home live strip and player frame-step ship", () => {
  const home = read("public/assets/home.js");
  assert.match(home, /homeLive/);
  assert.match(home, /today=1/);
  assert.match(read("public/index.html"), /homeLiveSection/);
  const plus = read("public/assets/player-plus.js");
  assert.match(plus, /1 \/ 30/);
});

test("pro player: media session, auto-pip, percent seek, stats v2 ship", () => {
  const plus = read("public/assets/player-plus.js");
  assert.match(plus, /mediaSession/);
  assert.match(plus, /MediaMetadata/);
  assert.match(plus, /setActionHandler\("seekto"/);
  assert.match(plus, /id = "autopipBtn"/);
  assert.match(plus, /requestPictureInPicture/);
  assert.match(plus, /navigator\.connection/);
  assert.match(plus, /Buffer health/);
});

test("site engineering: resume chip ships in the shell", () => {
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /resumeChip/);
  assert.match(shell, /arsvibe\.library/);
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /\.resume-chip/);
  assert.match(css, /content-visibility: auto/);
});

test("never-buffer: refill threshold and cooldown scale with playback rate", () => {
  const player = read("public/assets/player.js");
  assert.match(player, /ahead < 10 \* rate/);
  assert.match(player, /8000 \/ rate/);
  assert.match(player, /rate < 1\.5/);
  assert.match(player, /stableBufferTime: Math\.min\(180/);
});

test("download page: dedicated page, ladder, auto-retry, new-tab entry", () => {
  const page = read("public/assets/download-page.js");
  assert.match(page, /QUALITY_LADDER/);
  assert.match(page, /mode=list/);
  assert.match(page, /downloadLecture/);
  assert.match(page, /dlSaveFile/);
  const html = read("public/download.html");
  assert.match(html, /dlBar/);
  const lecture = read("public/assets/lecture.js");
  assert.match(lecture, /window\.open\(url, "_blank"/);
  assert.match(lecture, /\/download\.html\?batch=/);
});
