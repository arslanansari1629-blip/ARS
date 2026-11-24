/**
 * The uploaded script is the bot's brain.
 *
 * Each sample below is a script a student would actually write —
 * telebot, python-telegram-bot, aiogram, Telegraf — and the promise
 * under test is the same in every dialect: the replies written in the
 * file are the replies the bot gives, the sender's name fills the
 * placeholder the author left, and the panel's tables only answer
 * where the script is silent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractScriptRules, fillPlaceholders } from "../lib/bot-script.mjs";
import { planReply, saveBot, listBots } from "../lib/bot-host.mjs";
import { resetStore } from "../lib/store.mjs";

const HELP_PY = `
import telebot
bot = telebot.TeleBot(TOKEN)

@bot.message_handler(commands=['start'])
def start(message):
    bot.reply_to(message, f"Namaste {first_name}! Main ARS bot hoon.")

@bot.message_handler(commands=['help'])
def help_cmd(message):
    bot.send_message(message.chat.id, "Help: /notes bhejo, notes milenge.")

@bot.message_handler(func=lambda m: 'fees' in m.text.lower())
def fees(message):
    bot.reply_to(message, "Fees ki details batch page par hai.")

bot.polling()
`;

const PTB_PY = `
from telegram.ext import CommandHandler

async def notes(update, context):
    await update.message.reply_text("Notes yahan hain: batch page kholo.")

app.add_handler(CommandHandler("notes", notes))
`;

const AIOGRAM_PY = `
@dp.message(Command("dpp"))
async def dpp(message):
    await message.answer("DPP aaj ka chapter page par hai.")

@router.message(CommandStart())
async def go(message):
    await message.answer("Swagat hai!")
`;

const TELEGRAF_JS = `
bot.start((ctx) => ctx.reply("Welcome to ARS bot!"));
bot.command("notes", (ctx) => ctx.reply("Notes: batch page -> Notes tab"));
bot.hears("fees", (ctx) => ctx.reply("Fees batch page par likhi hai."));
bot.launch();
`;

test("a telebot help.py gives up its commands, keyword and welcome", () => {
  const rules = extractScriptRules(HELP_PY, "python");
  assert.deepEqual(rules.commands.map((c) => c.cmd), ["/start", "/help"]);
  assert.deepEqual(rules.keywords.map((k) => k.match), ["fees"]);
  assert.match(rules.welcome, /Namaste/);
});

test("python-telegram-bot and aiogram registrations are read too", () => {
  const ptb = extractScriptRules(PTB_PY, "python");
  assert.equal(ptb.commands[0].cmd, "/notes");
  assert.match(ptb.commands[0].reply, /Notes yahan hain/);
  const aio = extractScriptRules(AIOGRAM_PY, "python");
  assert.deepEqual(aio.commands.map((c) => c.cmd).sort(), ["/dpp", "/start"]);
});

test("a Telegraf script answers in JS the same way", () => {
  const rules = extractScriptRules(TELEGRAF_JS, "javascript");
  assert.deepEqual(rules.commands.map((c) => c.cmd), ["/start", "/notes"]);
  assert.deepEqual(rules.keywords.map((k) => k.match), ["fees"]);
});

test("the bot answers from the file, and the panel only fills gaps", () => {
  const bot = {
    language: "python",
    code: HELP_PY,
    welcome: "PANEL WELCOME",
    commands: [{ cmd: "/help", reply: "PANEL HELP" }, { cmd: "/call", reply: "Call: 9999" }],
    keywords: [],
    fallback: "",
  };
  // The script's /start and /help win over the panel's versions.
  assert.match(planReply(bot, "/start", "Aman"), /Namaste Aman!/);
  assert.match(planReply(bot, "/help"), /Help: \/notes/);
  // A keyword straight out of the file answers mid-sentence.
  assert.match(planReply(bot, "bhai fees kitni hai?"), /batch page/);
  // The script is silent on /call: the panel's table answers instead.
  assert.equal(planReply(bot, "/call"), "Call: 9999");
});

test("runtime placeholders are filled, never leaked raw", () => {
  assert.equal(fillPlaceholders("Hi {first_name}!", "Aman"), "Hi Aman!");
  assert.equal(fillPlaceholders("Hi ${ctx.from.first_name}", "Aman"), "Hi Aman");
  assert.equal(fillPlaceholders("Total {amount} due", "Aman"), "Total due");
});

test("saving a bot stores the script's rules with the record", async () => {
  resetStore();
  const saved = await saveBot({
    name: "Help Bot",
    token: "111:TEST",
    fileName: "help.py",
    code: HELP_PY,
  });
  assert.equal(saved.bot.script.commands.length, 2);
  assert.equal(saved.bot.script.keywords.length, 1);
  const list = await listBots();
  assert.equal(list.bots[0].script.commands.length, 2, "the panel cannot see the script's rules");
});

test("a language the reader does not know leaves the panel in charge", () => {
  const rules = extractScriptRules("package main\nfunc main() {}", "go");
  assert.deepEqual(rules.commands, []);
  const bot = { language: "go", code: "package main", welcome: "Panel hi bolega", commands: [], keywords: [], fallback: "" };
  assert.equal(planReply(bot, "/start"), "Panel hi bolega");
});
