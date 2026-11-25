/**
 * Telegram Bot Hosting tests.
 *
 * The panel's promises are three, and each is tested where it lives:
 * 24 languages really are registered and detected from file names;
 * the bot brain answers in the order it promises (command > keyword >
 * fallback, silence when nothing matches); and the record round-trip
 * through the store never hands the token back to a list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGES,
  detectLanguage,
  languageById,
  planReply,
  saveBot,
  listBots,
  deleteBot,
  watchdogBots,
} from "../lib/bot-host.mjs";
import { resetStore, readDoc, writeDoc, setKvBinding, storeName, persistent } from "../lib/store.mjs";

test("24 languages are registered, named and runnable", () => {
  assert.ok(LANGUAGES.length >= 24, `only ${LANGUAGES.length} languages`);
  const ids = new Set(LANGUAGES.map((l) => l.id));
  assert.equal(ids.size, LANGUAGES.length, "duplicate language ids");
  for (const id of ["python", "javascript", "typescript", "go", "rust", "java", "php", "ruby", "cpp"]) {
    assert.ok(ids.has(id), `${id} missing`);
  }
  for (const l of LANGUAGES) {
    assert.ok(l.name && l.run && l.exts.length, `${l.id} is incomplete`);
  }
});

test("a file names its language", () => {
  assert.equal(detectLanguage("doubt_bot.py"), "python");
  assert.equal(detectLanguage("bot.JS"), "javascript");
  assert.equal(detectLanguage("main.go"), "go");
  assert.equal(detectLanguage("Bot.java"), "java");
  assert.equal(detectLanguage("notes.txt"), "");
  assert.equal(languageById("python").name, "Python");
});

test("the brain answers in order: start, command, keyword, fallback, silence", () => {
  const bot = {
    welcome: "Namaste!",
    commands: [{ cmd: "/notes", reply: "Notes are in the batch." }],
    keywords: [{ match: "fees", reply: "Fees are on the batch page." }],
    fallback: "",
  };
  assert.equal(planReply(bot, "/start"), "Namaste!");
  assert.equal(planReply(bot, "/notes please"), "Notes are in the batch.");
  assert.equal(planReply(bot, "what are the FEES?"), "Fees are on the batch page.");
  assert.equal(planReply(bot, "random"), "", "no fallback written means silence, not noise");
  assert.equal(planReply({ ...bot, fallback: "Use /help" }, "random"), "Use /help");
  assert.match(planReply(bot, "/help"), /\/notes/);
});

test("bots save, list without their token, and delete", async () => {
  resetStore();
  const saved = await saveBot({
    name: "Doubt Bot",
    token: "123456:SECRET-TOKEN",
    fileName: "doubt_bot.py",
    code: "print('hi')",
    commands: [{ cmd: "/hi", reply: "hello" }],
  });
  assert.equal(saved.success, true);
  assert.equal(saved.bot.language, "python", "language was not detected from the file");
  assert.equal(saved.bot.hasToken, true);
  assert.ok(!("token" in saved.bot), "the list shape leaked the token");
  assert.ok(saved.bot.tokenMasked.includes("…"));

  const list = await listBots();
  assert.equal(list.bots.length, 1);
  assert.ok(!JSON.stringify(list).includes("SECRET-TOKEN"), "the list leaked the token");

  // An edit that leaves the token blank keeps the stored secret.
  const edited = await saveBot({ id: saved.bot.id, name: "Doubt Bot 2", token: "" });
  assert.equal(edited.bot.hasToken, true, "a blank-token edit dropped the secret");

  await deleteBot(saved.bot.id);
  const after = await listBots();
  assert.equal(after.bots.length, 0);
});

test("a Cloudflare KV binding makes documents survive the memory tier", async () => {
  const data = new Map();
  setKvBinding({
    get: async (k) => (data.has(k) ? data.get(k) : null),
    put: async (k, v) => { data.set(k, v); },
  });
  await writeDoc("test:doc", { hello: "world" });
  assert.equal(storeName(), "cloudflare-kv");
  assert.equal(persistent(), true, "KV attached but the store denies it is permanent");
  resetStore(); // memory forgotten — the document must still be there
  assert.deepEqual(await readDoc("test:doc"), { hello: "world" });
});

test("the watchdog heals a drifted webhook and reports health", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").pop();
    calls.push(method);
    const result =
      method === "getWebhookInfo"
        ? { url: "https://someone-else.example/hook", pending_update_count: 0 }
        : true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  try {
    const saved = await saveBot({
      name: "Watchdog Bot",
      token: "999:TEST",
      fileName: "bot.py",
      code: "print(1)",
    });
    // Mark it live the way deploy would, then let the webhook drift.
    const { getBotRaw } = await import("../lib/bot-host.mjs");
    const bots = [await getBotRaw(saved.bot.id)];
    bots[0].status = "live";
    bots[0].webhookUrl = "https://ars.example/api/token?route=tg&bot=" + saved.bot.id;
    await writeDoc("arsvibe:bots", { bots });

    const out = await watchdogBots(Date.now());
    assert.equal(out.checked, 1);
    assert.equal(out.healed, 1, "a drifted webhook was not re-registered");
    assert.ok(calls.includes("setWebhook"));
    const after = await getBotRaw(saved.bot.id);
    assert.equal(after.stats.health.ok, true);
    assert.equal(after.stats.health.healed, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("admin panel and routes carry the hosting surface", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const html = read("public/admin.html");
  assert.match(html, /id="botsBlock"/);
  assert.match(html, /id="botDrop"/);
  assert.match(html, /id="botList"/);
  const js = read("public/assets/admin.js");
  assert.match(js, /bot-deploy/);
  assert.match(js, /readBotFile/);
  const api = read("api/admin.mjs");
  assert.match(api, /action === "bots"/);
  assert.match(api, /action === "bot-save"/);
  const token = read("api/token.mjs");
  assert.match(token, /route === "tg"/);
  // The 24×7 machinery: a KV binding for the records, a watchdog on a
  // five-minute clock, and a Worker that runs it.
  const toml = read("wrangler.toml");
  assert.match(toml, /binding = "ARS_KV"/);
  assert.match(toml, /\*\/5 \* \* \* \*/);
  const worker = read("cloudflare/worker.js");
  assert.match(worker, /brainHeartbeat/, "the cron heartbeat left the worker");
  assert.match(worker, /ARS_KV/);
  const store = read("lib/store.mjs");
  assert.match(store, /cloudflare-kv/);
});
