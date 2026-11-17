/**
 * Round 9: professional UI/sidebar, latency-aware healing,
 * network-aware player, build-time CSS minification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

test("the professional design: white rail, navy active pill, flat primary", async () => {
  const css = await read("public/assets/arsvibe.css");
  const r9 = css; // whole sheet: build minification strips section comments
  assert.match(r9, /\.side\s*\{[^}]*background: ?#fff/);
  assert.match(r9, /\.side-link\.active\s*\{[^}]*background: ?#1e3a8a/);
  assert.match(r9, /\.btn-primary\s*\{[^}]*background: ?#1e3a8a|\.btn-primary\s*\{[^}]*background: ?#1d4ed8/);
  assert.match(css, /--blue: ?#7c6cff/);
  assert.match(css, /--paper: ?#0a0a16/);
  assert.match(css, /--r: ?16px/);
});

test("signer trust is latency-aware: slow hosts fade, never vanish", async () => {
  const { recordSignerResult, signerWeight, rankSigners, resetSelfHeal } = await import("../lib/selfheal.mjs");
  resetSelfHeal();
  for (let i = 0; i < 5; i += 1) recordSignerResult("slow.example", true, { ms: 6000 });
  for (let i = 0; i < 5; i += 1) recordSignerResult("fast.example", true, { ms: 400 });
  const slow = signerWeight("slow.example");
  const fast = signerWeight("fast.example");
  assert.ok(slow < fast, `slow ${slow} should rank below fast ${fast}`);
  assert.ok(slow >= 0.3, "a slow host is demoted, not deleted");
  assert.equal(rankSigners(["slow.example", "fast.example"])[0], "fast.example");
  const { signerHealth } = await import("../lib/selfheal.mjs");
  assert.ok(signerHealth().find((h) => h.host === "slow.example").ewmaMs >= 4000);
  resetSelfHeal();
});

test("the player caps quality to the connection, and reports it", async () => {
  const player = await read("public/assets/player.js");
  assert.match(player, /_applyNetworkCap\(hls, levels\)/);
  assert.match(player, /navigator\.connection/);
  assert.match(player, /saveData \? 360/);
  assert.match(player, /maxAutoLevel = best/);
  assert.match(player, /networkCap: this\._networkCap/);
});

test("the build minifies the stylesheet with a sanity check", async () => {
  const build = await read("scripts/build.mjs");
  assert.match(build, /CSS minified/);
  assert.match(build, /opens !== closes/);
});
