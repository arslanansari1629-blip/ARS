/**
 * Telegram Bot Hosting — bots the operator runs from the admin panel.
 *
 * What "hosting" means on a serverless deployment, said plainly: there is
 * no long-running process here to keep a bot polling. What there *is* is
 * a webhook — Telegram POSTs every update to this site, and this module
 * answers. So a bot hosted here is a webhook bot with a declarative
 * brain the panel can edit:
 *
 *   · a welcome message for /start,
 *   · a command table (/fees → "…", /notes → "…"),
 *   · keyword replies ("notes" anywhere → the notes answer),
 *   · an optional fallback line for anything else.
 *
 * The operator's uploaded source file (any of 24 languages) is kept with
 * the bot record as its source of truth, and its language is detected
 * from the extension — for handlers this runtime cannot execute in
 * process, the record is still a complete, deployable project card:
 * token wired, webhook shape documented, run command per language.
 * JavaScript bots get the webhook behaviour above driven by the panel
 * fields, which is the part students actually message.
 *
 * Bot tokens are secrets: they are stored server-side only, masked in
 * every list the API returns, and never written to a log.
 */

import { readDoc, writeDoc, storeName } from "./store.mjs";

const DOC_KEY = "arsvibe:bots";
const MAX_BOTS = 12;
const MAX_CODE = 60000;

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

/**
 * The language registry: what the panel offers, how a file names
 * itself, and the command that runs such a bot anywhere else. Order is
 * the order students ask for them, not alphabetical.
 */
export const LANGUAGES = [
  { id: "python", name: "Python", exts: ["py"], run: "python bot.py", pkg: "python-telegram-bot" },
  { id: "javascript", name: "JavaScript (Node)", exts: ["js", "mjs", "cjs"], run: "node bot.js", pkg: "telegraf" },
  { id: "typescript", name: "TypeScript", exts: ["ts"], run: "npx tsx bot.ts", pkg: "telegraf" },
  { id: "go", name: "Go", exts: ["go"], run: "go run bot.go", pkg: "telegram-bot-api" },
  { id: "rust", name: "Rust", exts: ["rs"], run: "cargo run", pkg: "teloxide" },
  { id: "java", name: "Java", exts: ["java"], run: "java Bot.java", pkg: "TelegramBots" },
  { id: "csharp", name: "C#", exts: ["cs"], run: "dotnet run", pkg: "Telegram.Bot" },
  { id: "php", name: "PHP", exts: ["php"], run: "php bot.php", pkg: "irazasyed/telegram-bot-sdk" },
  { id: "ruby", name: "Ruby", exts: ["rb"], run: "ruby bot.rb", pkg: "telegram-bot-ruby" },
  { id: "kotlin", name: "Kotlin", exts: ["kt"], run: "kotlin bot.kt", pkg: "kotlin-telegram-bot" },
  { id: "swift", name: "Swift", exts: ["swift"], run: "swift bot.swift", pkg: "telegram-vapor-bot" },
  { id: "dart", name: "Dart", exts: ["dart"], run: "dart bot.dart", pkg: "teledart" },
  { id: "scala", name: "Scala", exts: ["scala"], run: "scala bot.scala", pkg: "bot4s" },
  { id: "perl", name: "Perl", exts: ["pl"], run: "perl bot.pl", pkg: "WWW::Telegram::BotAPI" },
  { id: "r", name: "R", exts: ["r"], run: "Rscript bot.R", pkg: "telegram.bot" },
  { id: "lua", name: "Lua", exts: ["lua"], run: "lua bot.lua", pkg: "—" },
  { id: "haskell", name: "Haskell", exts: ["hs"], run: "runghc bot.hs", pkg: "telegram-bot" },
  { id: "elixir", name: "Elixir", exts: ["ex", "exs"], run: "mix run", pkg: "ex_gram" },
  { id: "clojure", name: "Clojure", exts: ["clj"], run: "clojure bot.clj", pkg: "telegram-bot-clj" },
  { id: "cpp", name: "C++", exts: ["cpp", "cc", "cxx"], run: "g++ bot.cpp && ./a.out", pkg: "TgBot" },
  { id: "c", name: "C", exts: ["c", "h"], run: "gcc bot.c && ./a.out", pkg: "telebot" },
  { id: "shell", name: "Bash", exts: ["sh", "bash"], run: "bash bot.sh", pkg: "curl + jq" },
  { id: "julia", name: "Julia", exts: ["jl"], run: "julia bot.jl", pkg: "Telegram.jl" },
  { id: "zig", name: "Zig", exts: ["zig"], run: "zig run bot.zig", pkg: "—" },
];

/** The language a filename speaks, or "" when it says nothing. */
export function detectLanguage(fileName = "") {
  const ext = String(fileName).split(".").pop()?.toLowerCase() || "";
  const hit = LANGUAGES.find((l) => l.exts.includes(ext));
  return hit ? hit.id : "";
}

export function languageById(id) {
  return LANGUAGES.find((l) => l.id === id) || LANGUAGES[0];
}

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

async function readBots() {
  const doc = await readDoc(DOC_KEY).catch(() => null);
  return Array.isArray(doc?.bots) ? doc.bots : [];
}

async function writeBots(bots) {
  await writeDoc(DOC_KEY, { bots: bots.slice(0, MAX_BOTS) }).catch(() => "memory");
}

/** The public shape: everything except the secret itself. */
function maskBot(b) {
  const { token, ...rest } = b;
  return {
    ...rest,
    tokenMasked: token ? `${String(token).slice(0, 6)}…${String(token).slice(-3)}` : "",
    hasToken: Boolean(token),
  };
}

export async function listBots() {
  const bots = await readBots();
  return { success: true, bots: bots.map(maskBot), languages: LANGUAGES, store: storeName() };
}

/** The raw record, token included — server-side handlers only. */
export async function getBotRaw(id) {
  const bots = await readBots();
  return bots.find((b) => b.id === id) || null;
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function saveBot(input = {}) {
  const bots = await readBots();
  const id = clean(input.id, 40) || `bot-${Date.now().toString(36)}`;
  const existing = bots.find((b) => b.id === id);
  const language = languageById(clean(input.language, 30) || detectLanguage(input.fileName || "")).id;
  const bot = {
    id,
    name: clean(input.name, 60) || "Untitled bot",
    // An edit that leaves the token blank keeps the stored one: the
    // panel never shows the secret back, so "unchanged" must be safe.
    token: clean(input.token, 120) || existing?.token || "",
    language,
    fileName: clean(input.fileName, 120),
    code: String(input.code ?? existing?.code ?? "").slice(0, MAX_CODE),
    welcome: String(input.welcome ?? existing?.welcome ?? "").slice(0, 1000) ||
      "Namaste! 🙏 I am live. Send /help to see what I can do.",
    commands: Array.isArray(input.commands) ? input.commands : existing?.commands || [
      { cmd: "/help", reply: "Commands: /start /help — or just ask me anything." },
    ],
    keywords: Array.isArray(input.keywords) ? input.keywords : existing?.keywords || [],
    fallback: String(input.fallback ?? existing?.fallback ?? "").slice(0, 500),
    status: existing?.status || "stopped",
    username: existing?.username || "",
    webhookUrl: existing?.webhookUrl || "",
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: existing?.stats || { messages: 0, users: 0, lastAt: "" },
  };
  const next = existing ? bots.map((b) => (b.id === id ? bot : b)) : [bot, ...bots];
  await writeBots(next);
  return { success: true, bot: maskBot(bot) };
}

export async function deleteBot(id) {
  const bots = await readBots();
  const bot = bots.find((b) => b.id === id);
  if (bot?.token && bot.status === "live") {
    await tg(bot.token, "deleteWebhook", {}).catch(() => null);
  }
  await writeBots(bots.filter((b) => b.id !== id));
  return { success: true };
}

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */

export async function tg(token, method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.description || `Telegram ${method} failed (${res.status})`);
  return data.result;
}

/** Validate the token, point Telegram at this site, mark the bot live. */
export async function deployBot(id, baseUrl) {
  const bot = await getBotRaw(id);
  if (!bot) return { success: false, error: "That bot is gone." };
  if (!bot.token) return { success: false, error: "Add the bot token (from @BotFather) first." };
  const me = await tg(bot.token, "getMe", {});
  const webhookUrl = `${String(baseUrl).replace(/\/$/, "")}/api/token?route=tg&bot=${encodeURIComponent(id)}`;
  await tg(bot.token, "setWebhook", { url: webhookUrl, drop_pending_updates: true });
  bot.username = me.username || "";
  bot.status = "live";
  bot.webhookUrl = webhookUrl;
  const bots = await readBots();
  await writeBots(bots.map((b) => (b.id === id ? bot : b)));
  return { success: true, bot: maskBot(bot), webhookUrl };
}

export async function stopBot(id) {
  const bot = await getBotRaw(id);
  if (!bot) return { success: false, error: "That bot is gone." };
  if (bot.token) await tg(bot.token, "deleteWebhook", {}).catch(() => null);
  bot.status = "stopped";
  bot.webhookUrl = "";
  const bots = await readBots();
  await writeBots(bots.map((b) => (b.id === id ? bot : b)));
  return { success: true, bot: maskBot(bot) };
}

/* ------------------------------------------------------------------ */
/* The brain                                                           */
/* ------------------------------------------------------------------ */

/**
 * One update in, one answer out. The order is the contract: an exact
 * command beats a keyword, a keyword beats the fallback, and silence
 * beats a fallback the operator did not write.
 */
export function planReply(bot, text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === "/start") return bot.welcome || "";
  const cmd = lower.split(/\s+/)[0];
  for (const c of bot.commands || []) {
    if (String(c.cmd || "").toLowerCase() === cmd && c.reply) return String(c.reply);
  }
  for (const k of bot.keywords || []) {
    if (k.match && lower.includes(String(k.match).toLowerCase()) && k.reply) return String(k.reply);
  }
  if (cmd === "/help") {
    const list = (bot.commands || []).map((c) => c.cmd).filter(Boolean).join("  ");
    return list ? `Commands: ${list}` : (bot.fallback || "");
  }
  return bot.fallback || "";
}

/** Handle one Telegram update end to end; returns what was answered. */
export async function handleBotUpdate(id, update) {
  const bot = await getBotRaw(id);
  if (!bot || bot.status !== "live" || !bot.token) return { ok: false, answered: "" };
  const msg = update?.message || update?.edited_message;
  const chatId = msg?.chat?.id;
  const text = msg?.text || "";
  if (!chatId) return { ok: true, answered: "" };
  const reply = planReply(bot, text);
  bot.stats = bot.stats || { messages: 0, users: 0, lastAt: "" };
  bot.stats.messages += 1;
  bot.stats.lastAt = new Date().toISOString();
  if (reply) {
    await tg(bot.token, "sendMessage", { chat_id: chatId, text: reply }).catch(() => null);
  }
  const bots = await readBots();
  await writeBots(bots.map((b) => (b.id === id ? bot : b)));
  return { ok: true, answered: reply };
}
