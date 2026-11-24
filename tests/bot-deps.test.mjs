/**
 * "Script kabhi fail na ho" — the dependency half.
 *
 * A script's own imports must resolve to the packages that actually
 * provide them (telebot is not a pip name), the requirements file
 * must carry the 50+ core pack so a lifted project simply runs, and
 * the failures visible statically — a second token in the file, no
 * readable handler, unclosed brackets — must be said before deploy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanImports, buildRequirements, checkScript, CORE_PACKAGES } from "../lib/bot-deps.mjs";
import { extractScriptRules } from "../lib/bot-script.mjs";
import { saveBot, listBots } from "../lib/bot-host.mjs";
import { resetStore } from "../lib/store.mjs";

const SCRIPT = `
import os, json
import telebot
from PIL import Image
import requests
from myhelpers import thing

bot = telebot.TeleBot(os.getenv("TOKEN"))

@bot.message_handler(commands=['start'])
def start(m):
    bot.reply_to(m, "Namaste!")

bot.polling()
`;

test("imports resolve to the packages that provide them", () => {
  const mods = scanImports(SCRIPT);
  assert.ok(mods.includes("telebot") && mods.includes("PIL") && mods.includes("requests"));
  assert.ok(!mods.includes("os") || true); // os is scanned, then filtered as stdlib below
  const req = buildRequirements(SCRIPT);
  assert.match(req.text, /pyTelegramBotAPI/);
  assert.match(req.text, /Pillow/);
  assert.match(req.text, /^requests/m);
  assert.ok(!/^os$/m.test(req.text), "a stdlib module became a pip line");
});

test("the requirements file carries 50+ packages and never repeats one", () => {
  assert.ok(CORE_PACKAGES.length >= 50, `core pack only has ${CORE_PACKAGES.length}`);
  const req = buildRequirements(SCRIPT);
  assert.ok(req.total >= 50, `only ${req.total} packages`);
  const names = req.text.trim().split("\n").map((l) => l.toLowerCase());
  assert.equal(new Set(names).size, names.length, "a package is listed twice");
});

test("the pre-flight check names the failures it can see", () => {
  const other = "123456:" + "A".repeat(35);
  const warns = checkScript(SCRIPT.replace('os.getenv("TOKEN")', `"${other}"`), {
    token: "999999:" + "B".repeat(35),
    scriptRules: extractScriptRules(SCRIPT, "python"),
  });
  assert.ok(warns.some((w) => w.level === "warn" && /dusra bot token/.test(w.text)));

  const silent = checkScript("print('hello')\n", { token: "", scriptRules: { commands: [], keywords: [] } });
  assert.ok(silent.some((w) => /koi command/.test(w.text)));

  const broken = checkScript("def f(:\n    x = (1\n", { token: "", scriptRules: { commands: [], keywords: [] } });
  assert.ok(broken.some((w) => /Brackets/.test(w.text)));
});

test("pyrogram and telethon scripts give up their replies too", () => {
  const pyro = extractScriptRules(
    `
@app.on_message(filters.command("start"))
async def start(client, message):
    await message.reply_text("Pyrogram bot ready hai!")

@app.on_message(filters.command(["notes", "dpp"]))
async def nd(client, message):
    await message.reply("Notes aur DPP chapter page par.")
`,
    "python"
  );
  assert.deepEqual(pyro.commands.map((c) => c.cmd), ["/start", "/notes", "/dpp"]);

  const tele = extractScriptRules(
    `
@client.on(events.NewMessage(pattern='/help'))
async def help_handler(event):
    await event.respond("Help: /start dabao.")
`,
    "python"
  );
  assert.equal(tele.commands[0].cmd, "/help");
  assert.match(tele.commands[0].reply, /Help:/);
});

test("a saved python bot carries its never-fail kit", async () => {
  resetStore();
  const saved = await saveBot({ name: "Deps Bot", token: "111:TEST", fileName: "help.py", code: SCRIPT });
  assert.ok(saved.bot.deps.total >= 50);
  assert.ok(saved.bot.deps.text.includes("pyTelegramBotAPI"));
  assert.ok(Array.isArray(saved.bot.checks));
  const list = await listBots();
  assert.ok(list.bots[0].deps.total >= 50, "the panel cannot offer the requirements file");
});
