/**
 * Round 12 — God Mode: opening curtain, living sidebar, cinema player.
 *
 * Pins the three new layers and their safety rails: the splash plays once
 * per session and never on home/reduced-motion, the player intro lifts on
 * the first frame, and the ambient glow is sampled from the video itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../public/${p}`, import.meta.url), "utf8");

test("the shell plays an opening curtain once per session", async () => {
  const shell = await read("assets/shell.mjs");
  assert.match(shell, /function playSplash/);
  assert.match(shell, /arsvibe\.splash/);
  assert.match(shell, /sessionStorage\.setItem\("arsvibe\.splash", "1"\)/);
  assert.match(shell, /prefers-reduced-motion/);
  assert.match(shell, /page === "home"\) return/);
  assert.match(shell, /splash-out/);
  assert.match(shell, /setTimeout\(done, 1750\)/);
});

test("the sidebar carries a greeting hero that folds away in rail mode", async () => {
  const shell = await read("assets/shell.mjs");
  const css = await read("assets/arsvibe.css");
  assert.match(shell, /side-hero/);
  assert.match(shell, /Good (morning|afternoon|evening)/);
  assert.match(shell, /daypart/);
  assert.match(css, /body\.side-rail \.side-hero\s*\{\s*display: none/);
});

test("the player opens with a cinematic intro that lifts on the first frame", async () => {
  const plus = await read("assets/player-plus.js");
  const css = await read("assets/arsvibe.css");
  assert.match(plus, /player-intro/);
  assert.match(plus, /ARS/);
  assert.match(plus, /addEventListener\("playing", liftIntro/);
  assert.match(plus, /pi-out/);
  assert.match(css, /\.player-intro\s*\{/);
  assert.match(css, /\.pi-bars i/);
  assert.match(css, /r12-eq/);
});

test("centre flash and living ambient glow are wired", async () => {
  const plus = await read("assets/player-plus.js");
  const css = await read("assets/arsvibe.css");
  assert.match(plus, /center-flash/);
  assert.match(plus, /addEventListener\("play", \(\) => flash\("play"\)\)/);
  assert.match(plus, /getImageData/);
  assert.match(plus, /--ambient/);
  assert.match(css, /\.center-flash\.on\s*\{\s*animation: r12-flash/);
  assert.match(css, /\.player-wrap\.has-ambient\s*\{[^}]*var\(--ambient/);
});

test("round 12 keeps the reduced-motion escape hatch", async () => {
  const css = await read("assets/arsvibe.css");
  assert.match(css, /ROUND 12/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.splash/);
});
