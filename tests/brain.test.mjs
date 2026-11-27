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
import { playbackDoctor, brainHealthScore, incidentFingerprint, recordIncidents, activeRecurring, brainPredictions, RECURRENCE_THRESHOLD } from "../lib/brain.mjs";
import { recordSignerResult } from "../lib/selfheal.mjs";
import { PAGE_CONTRACT } from "../lib/scanner.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the Brain's map is the whole site, with its skills", () => {
  assert.equal(SITE_MAP.pages.length, Object.keys(PAGE_CONTRACT).length);
  assert.ok(SITE_MAP.pages.includes("watch.html") && SITE_MAP.pages.includes("admin.html"));
  assert.ok(SITE_MAP.apis.includes("/api/batches"));
  assert.ok(SITE_MAP.skills.length >= 24, "the bot languages are not in the Brain's skills");
  assert.ok(SITE_MAP.skills.includes("Python"));
});

test("the Brain's playback doctor classifies a 402 quota wall by evidence", async () => {
  // Taught, not born: the doctor reads learned signer health and
  // names the class — 402 is a quota wall with a matching repair,
  // not a mystery outage. Three failures also quarantine the host,
  // which the doctor must be able to see in its own report.
  const host = "https://quota-wall.example/api/v1/videos/get-hls-key";
  recordSignerResult(host, false, { status: 402 });
  recordSignerResult(host, false, { status: 402 });
  recordSignerResult(host, false, { status: 402 });
  const doctor = await playbackDoctor();
  assert.match(doctor.diagnosis, /402/, "a quota wall must be named as one");
  assert.ok(doctor.quarantined.some((h) => h.includes("quota-wall.example")), "the walled host must be quarantined out of the ladder's front");
  assert.ok(doctor.action.length > 10, "a diagnosis without a matching action is just a label");
  assert.ok(SITE_MAP.skills.includes("quota & rate-limit triage"), "the new skill is not on the Brain's map");
});

test("the mood follows evidence, never vibes", () => {
  assert.equal(brainMood({ automation: false }), "sleeping");
  assert.equal(brainMood({ healer: { counts: { failed: 1 } } }), "worried");
  assert.equal(brainMood({ verdict: { level: "bad" } }), "worried");
  assert.equal(brainMood({ healer: { counts: { degraded: 1 } } }), "fixing");
  assert.equal(brainMood({ canaryBad: true }), "worried", "lectures down but the Brain smiled");
  assert.equal(brainMood({}), "happy");
});

test("Ultra: the health score explains itself and grades the site", () => {
  const perfect = brainHealthScore({});
  assert.equal(perfect.score, 100);
  assert.equal(perfect.grade, "S");
  const hurt = brainHealthScore({ canaryBad: true, healer: { counts: { failed: 1, degraded: 1 } }, verdict: { level: "warn" } });
  assert.ok(hurt.score < 40 && hurt.grade === "D", `playback down + failures must tank the score, got ${hurt.score}`);
  assert.ok(hurt.factors.length >= 3 && hurt.factors.every((f) => f.points < 0), "every deduction must be named");
});

test("Ultra: incident memory recognises a recurring problem and escalates it", () => {
  const doc = { incidents: {} };
  const item = { key: "page:/watch:contract", severity: "high", what: "watch page contract broken" };
  assert.equal(incidentFingerprint(item), incidentFingerprint({ ...item }), "fingerprints must be stable");
  let out = recordIncidents(doc, [item]);
  assert.equal(out.fresh.length, 1);
  for (let i = 1; i < RECURRENCE_THRESHOLD; i++) out = recordIncidents(doc, [item]);
  assert.equal(out.recurring.length, 1, "crossing the threshold must be reported exactly once");
  assert.equal(activeRecurring(doc).length, 1);
  assert.equal(brainMood({ escalated: true }), "worried", "a recurring incident must worry the Brain");
  assert.equal(brainMood({ healer: { counts: { degraded: 1 } }, escalated: false }), "fixing");
});

test("Ultra: the predictive watch names drift before failure", () => {
  const watch = brainPredictions({
    doctor: { quarantined: ["signer.example"], hosts: [{ host: "weak.example", reason: "answered 402", quarantined: false }] },
    incidents: { a: { count: 3, label: "same crash", lastAt: new Date().toISOString() } },
    healer: { counts: { degraded: 2 } },
    bots: [{ name: "PW Bot", status: "live", health: "degraded" }],
  });
  assert.ok(watch.length >= 4, `watch list too thin: ${watch.length}`);
  assert.ok(watch.some((w) => /Recurring/.test(w.text)));
  assert.ok(watch.some((w) => /402/.test(w.text)));
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
  // A fresh shared playback-failure doc must turn the public face
  // worried in ANY isolate (regression: lectures down, Brain "happy").
  const { writeDoc: writeStoreDoc } = await import("../lib/store.mjs");
  await writeStoreDoc("arsvibe:playback", { ok: false, at: new Date().toISOString(), detail: "signers refused:3" });
  const downPub = await brainPublic();
  assert.equal(downPub.mood, "worried", "playback down but the public Brain smiled");
  assert.equal(downPub.playbackDown, true);
  assert.match(downPub.line, /play nahi ho rahe/);
  await writeStoreDoc("arsvibe:playback", { ok: true, at: new Date().toISOString(), detail: "" });

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
