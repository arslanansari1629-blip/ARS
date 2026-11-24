/**
 * Reading a bot script the way the panel promises: the uploaded file
 * is not decoration, it is the bot's brain.
 *
 * A serverless webhook cannot *run* an arbitrary Python or Go process,
 * so this module reads the script the way a reviewer would — it finds
 * the handlers the common frameworks declare and lifts out the replies
 * written in them:
 *
 *   Python (telebot / python-telegram-bot / aiogram)
 *     @bot.message_handler(commands=['start'])   → /start's reply
 *     @bot.message_handler(func=lambda m: 'fees' in m.text) → keyword
 *     CommandHandler("notes", notes_fn)          → /notes' reply
 *     @dp.message(Command("fees"))              → /fees' reply
 *     if 'notes' in message.text: …              → keyword reply
 *   JavaScript / TypeScript (Telegraf / grammY / node-telegram-bot-api)
 *     bot.command('start', ctx => ctx.reply('…'))
 *     bot.hears('fees', ctx => ctx.reply('…'))
 *     bot.onText(/\/notes/, … sendMessage('…'))
 *
 * Only literal replies can be lifted this way — a reply computed from
 * a database or an API stays behind in the source, and the panel's own
 * fields remain the fallback for anything the script does not answer.
 * Placeholders the frameworks would fill at runtime ({first_name} in a
 * Python f-string, ${…} in a JS template) are handled at answer time:
 * the sender's name goes in, anything else is dropped rather than
 * leaked to a student as raw braces.
 */

const MAX_RULES = 40;

/** Unescape the few sequences a bot author actually writes. */
const unesc = (s) =>
  String(s)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'\\])/g, "$1")
    .trim();

/** Every string literal in a snippet, in order (Python flavour). */
function pyStrings(snippet) {
  const out = [];
  const re = /f?"""([\s\S]*?)"""|f?'''([\s\S]*?)'''|f?"([^"\n]*)"|f?'([^'\n]*)'/g;
  let m;
  while ((m = re.exec(snippet)) && out.length < 12) {
    const v = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    if (v) out.push(unesc(v));
  }
  return out;
}

/** Every string literal in a snippet, in order (JS flavour). */
function jsStrings(snippet) {
  const out = [];
  const re = /`([^`]*)`|"([^"\n]*)"|'([^'\n]*)'/g;
  let m;
  while ((m = re.exec(snippet)) && out.length < 12) {
    const v = m[1] ?? m[2] ?? m[3] ?? "";
    if (v) out.push(unesc(v));
  }
  return out;
}

/**
 * The reply a handler body sends: the first string literal inside a
 * reply/send/answer call. Call names differ per framework; the shape
 * (a call, then the text) does not.
 */
function replyIn(block, strings) {
  const call = block.match(/(?:reply_text|reply_to|send_message|sendMessage|\.answer|\.reply|ctx\.reply)\s*\(([\s\S]{0,900}?)\)/);
  const scope = call ? call[1] : block.slice(0, 900);
  const found = strings(scope).filter((s) => s.length >= 2 && (!/^[\w./-]+$/.test(s) || s.includes(" ")));
  return found[0] || "";
}

/** Split a Python source into handler blocks: decorator → its body. */
function pyBlocks(code) {
  const blocks = [];
  const re = /@[\w.]+\.message_handler\(([^)]*)\)|@[\w.]+\.message\(([^)]*)\)/g;
  let m;
  const starts = [];
  while ((m = re.exec(code))) starts.push({ at: m.index, args: m[1] ?? m[2] ?? "", end: re.lastIndex });
  for (let i = 0; i < starts.length; i += 1) {
    const stop = i + 1 < starts.length ? starts[i + 1].at : code.length;
    blocks.push({ args: starts[i].args, body: code.slice(starts[i].end, Math.min(stop, starts[i].end + 2200)) });
  }
  return blocks;
}

function fromPython(code) {
  const commands = [];
  const keywords = [];
  const pushCmd = (cmd, reply) => {
    cmd = String(cmd || "").replace(/^\//, "").toLowerCase();
    if (cmd && reply && !commands.some((c) => c.cmd === `/${cmd}`) && commands.length < MAX_RULES) {
      commands.push({ cmd: `/${cmd}`, reply });
    }
  };
  const pushKw = (match, reply) => {
    match = String(match || "").trim().toLowerCase();
    if (match && reply && !keywords.some((k) => k.match === match) && keywords.length < MAX_RULES) {
      keywords.push({ match, reply });
    }
  };

  for (const { args, body } of pyBlocks(code)) {
    const reply = replyIn(body, pyStrings);
    if (!reply) continue;
    const list = args.match(/commands\s*=\s*\[([^\]]+)\]/);
    if (list) for (const s of pyStrings(list[1])) pushCmd(s, reply);
    const single = args.match(/Command\(\s*["'](\w+)["']/) || args.match(/commands\s*=\s*["'](\w+)["']/);
    if (single) pushCmd(single[1], reply);
    if (/CommandStart\s*\(/.test(args)) pushCmd("start", reply);
    const kw = args.match(/["']([^"']+)["']\s+in\s+[\w.]*text/) || args.match(/F\.text[^\n]*?["']([^"']+)["']/);
    if (kw) pushKw(kw[1], reply);
  }

  // CommandHandler("notes", notes_fn) + def notes_fn(...): join the two.
  const defs = new Map();
  const defRe = /(?:async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->\s*[^:\n]*)?:([\s\S]*?)(?=\n(?:@|def |async def |class |$))/g;
  let d;
  while ((d = defRe.exec(code))) defs.set(d[1], d[2]);
  const regRe = /CommandHandler\(\s*["'](\w+)["']\s*,\s*(\w+)/g;
  let r;
  while ((r = regRe.exec(code))) {
    const body = defs.get(r[2]);
    if (body) pushCmd(r[1], replyIn(body, pyStrings));
  }

  // Bare keyword conditionals: if 'fees' in message.text.lower():
  const ifRe = /if\s+["']([^"']+)["']\s+in\s+[\w.]*text[\w.]*\s*:/g;
  let f;
  while ((f = ifRe.exec(code))) {
    pushKw(f[1], replyIn(code.slice(f.index, f.index + 700), pyStrings));
  }
  return { commands, keywords };
}

function fromJs(code) {
  const commands = [];
  const keywords = [];
  const pushCmd = (cmd, reply, at = 0) => {
    cmd = String(cmd || "").replace(/^\//, "").toLowerCase();
    if (cmd && reply && !commands.some((c) => c.cmd === `/${cmd}`) && commands.length < MAX_RULES) {
      commands.push({ cmd: `/${cmd}`, reply, _at: at });
    }
  };
  const pushKw = (match, reply, at = 0) => {
    match = String(match || "").trim().toLowerCase();
    if (match && reply && !keywords.some((k) => k.match === match) && keywords.length < MAX_RULES) {
      keywords.push({ match, reply, _at: at });
    }
  };
  const after = (at) => replyIn(code.slice(at, at + 900), jsStrings);

  let m;
  const cmdRe = /\.command\(\s*["'](\w+)["']/g;
  while ((m = cmdRe.exec(code))) pushCmd(m[1], after(m.index), m.index);
  const startRe = /\.start\(\s*(?:async\s*)?(?:\(|[\w])/g;
  while ((m = startRe.exec(code))) pushCmd("start", after(m.index), m.index);
  const hearsRe = /\.hears\(\s*["']([^"']+)["']/g;
  while ((m = hearsRe.exec(code))) pushKw(m[1], after(m.index), m.index);
  const onTextRe = /\.onText\(\s*\/\\\/(\w+)[^/]*\//g;
  while ((m = onTextRe.exec(code))) pushCmd(m[1], after(m.index), m.index);
  const onMsgRe = /on\(\s*["']message["'][\s\S]{0,200}?["'](\w+)["']\s*===?\s*text|text\s*===?\s*["']([^"']+)["']/g;
  while ((m = onMsgRe.exec(code))) { /* equality on raw text is a keyword by shape */
    const word = m[1] || m[2];
    if (word) pushKw(word, after(m.index), m.index);
  }
  // Handlers answer in the order the author wrote them, not the order
  // this reader happened to scan for them.
  const byAt = (a, b) => a._at - b._at;
  const strip = ({ _at, ...rest }) => rest;
  return { commands: commands.sort(byAt).map(strip), keywords: keywords.sort(byAt).map(strip) };
}

/**
 * The rules a script declares, shaped like the panel's own tables.
 * Languages this reader does not know get empty rules — the panel's
 * fields then drive the bot, which the record says out loud.
 */
export function extractScriptRules(code = "", language = "") {
  const src = String(code || "").slice(0, 60000);
  if (!src.trim()) return { commands: [], keywords: [], welcome: "" };
  let out = { commands: [], keywords: [] };
  if (language === "python") out = fromPython(src);
  else if (["javascript", "typescript"].includes(language)) out = fromJs(src);
  const welcome = out.commands.find((c) => c.cmd === "/start")?.reply || "";
  return { commands: out.commands, keywords: out.keywords, welcome };
}

/**
 * Fill the placeholders a script leaves for runtime: the sender's name
 * where the author wrote {first_name} / ${name}, and nothing (rather
 * than raw braces) anywhere else.
 */
export function fillPlaceholders(text, senderName = "") {
  return String(text || "")
    .replace(/\$\{\s*[^}]*\}/g, (whole) => (/name|user/i.test(whole) ? senderName || "dost" : ""))
    .replace(/\{\s*(?:first_name|name|user|username)\s*\}/gi, senderName || "dost")
    .replace(/\{\s*[\w.]+\s*\}/g, "")
    .replace(/[ \t]{2,}/g, " ");
}
