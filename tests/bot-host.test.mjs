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
} from "../lib/bot-host.mjs";
import { resetStore } from "../lib/store.mjs";

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
});
