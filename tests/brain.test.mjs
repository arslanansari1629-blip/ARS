/**
 * The Site Brain.
 *
 * One overseer over the organs that already exist — scanner, healer,
 * browser fault log, bot watchdog. Under test: the map it watches is
 * the whole site (every contracted page, every API), the mood follows
 * evidence, the heartbeat heals and writes its diary, automation is a
 * switch with a memory, and every surface the operator and the student
 * see (admin section, on-page widget, endpoints) is wired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SITE_MAP,
  brainMood,
  brainReport,
  brainPublic,
  brainHeartbeat,
  setBrainAutomation,
} from "../lib/brain.mjs";
import { resetStore } from "../lib/store.mjs";
import { PAGE_CONTRACT } from "../lib/scanner.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the Brain's map is the whole site, with its skills", () => {
  assert.equal(SITE_MAP.pages.length, Object.keys(PAGE_CONTRACT).length);
  assert.ok(SITE_MAP.pages.includes("watch.html") && SITE_MAP.pages.includes("admin.html"));
  assert.ok(SITE_MAP.apis.includes("/api/batches"));
  assert.ok(SITE_MAP.skills.length >= 24, "the bot languages are not in the Brain's skills");
  assert.ok(SITE_MAP.skills.includes("Python"));
});

test("the mood follows evidence, never vibes", () => {
  assert.equal(brainMood({ automation: false }), "sleeping");
  assert.equal(brainMood({ healer: { counts: { failed: 1 } } }), "worried");
  assert.equal(brainMood({ verdict: { level: "bad" } }), "worried");
  assert.equal(brainMood({ healer: { counts: { degraded: 1 } } }), "fixing");
  assert.equal(brainMood({ canaryBad: true }), "worried", "lectures down but the Brain smiled");
  assert.equal(brainMood({}), "happy");
});

test("the report aggregates every organ and the diary persists", async () => {
  resetStore();
  const before = await brainReport();
  assert.equal(before.mood, "happy");
  assert.ok(Array.isArray(before.log) && Array.isArray(before.bots));

  await setBrainAutomation(false);
  const off = await brainPublic();
  assert.equal(off.mood, "sleeping", "automation off but the public face is awake");
  assert.equal(off.automation, false);

  await setBrainAutomation(true);
  const hb = await brainHeartbeat();
  assert.equal(hb.success, true);
  const after = await brainReport();
  assert.ok(after.lastTick, "the heartbeat left no trace");
  assert.ok(after.log.some((l) => /Automation on/.test(l.text)), "the diary forgot the switch");
});

test("every surface is wired: admin section, widget, endpoints, cron", async () => {
  const html = read("public/admin.html");
  assert.match(html, /id="brainBlock"/);
  assert.match(html, /id="brainRun"/);
  assert.match(html, /id="brainAuto"/);
  const admin = read("api/admin.mjs");
  assert.match(admin, /action === "brain"/);
  assert.match(admin, /action === "brain-run"/);
  assert.match(admin, /action === "brain-auto"/);
  const token = read("api/token.mjs");
  assert.match(token, /route === "brain"/);
  const shell = read("public/assets/shell.mjs");
  assert.match(shell, /brain-widget\.js/, "the shell no longer carries the Brain's face");
  const widget = read("public/assets/brain-widget.js");
  assert.match(widget, /brainWidget/);
  assert.match(widget, /route=brain/);
  assert.match(widget, /brain-tag/, "the Brain lost its name tag");
  for (const page of ["public/admin.html", "public/login.html", "public/open.html"]) {
    assert.match(read(page), /brain-widget\.js/, `${page} has no Brain`);
  }
  const pub = await brainPublic();
  assert.ok(pub.bots && typeof pub.openErrors === "number", "the public hello lost its numbers");
  const worker = read("cloudflare/worker.js");
  assert.match(worker, /brainHeartbeat/);
  const css = read("public/assets/arsvibe.css");
  assert.match(css, /\.brain-widget/);
  assert.match(css, /mood-fixing/);
  assert.match(css, /\.brain-avatar/);
});
