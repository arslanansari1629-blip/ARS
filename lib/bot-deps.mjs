/**
 * "Script kabhi fail na ho" — the dependency half of that promise.
 *
 * A bot script dies in the wild for boring reasons long before its
 * logic is ever reached: `telebot` is imported but pyTelegramBotAPI
 * was never installed, `PIL` is not the package name, the host has no
 * requirements file at all. This module reads the script's imports,
 * maps every module to the package that actually provides it (60+
 * mappings — `import X` is very often not `pip install X`), and builds
 * a complete requirements.txt: what the script itself asks for, plus a
 * core pack of 50+ packages student bots reach for, so the project can
 * be lifted onto any runtime and simply run.
 *
 * The same pass doubles as a pre-flight check. The failures it can see
 * statically — a different token hardcoded in the file, no handler the
 * reader could find, brackets that never close — are reported before
 * deploy, not discovered by a student messaging a silent bot.
 */

/** Modules that ship with Python: never a pip line. */
const STDLIB = new Set([
  "os", "sys", "re", "json", "time", "datetime", "asyncio", "logging", "random",
  "math", "typing", "threading", "pathlib", "io", "collections", "functools",
  "itertools", "traceback", "string", "textwrap", "uuid", "hashlib", "hmac",
  "base64", "sqlite3", "csv", "html", "urllib", "http", "socket", "subprocess",
  "shutil", "glob", "enum", "dataclasses", "contextlib", "warnings", "inspect",
  "operator", "queue", "signal", "argparse", "configparser", "getpass", "platform",
]);

/** What a module is called on PyPI, when it is not called by its name. */
export const MODULE_TO_PACKAGE = {
  telebot: "pyTelegramBotAPI",
  telegram: "python-telegram-bot",
  aiogram: "aiogram",
  pyrogram: "pyrogram",
  hydrogram: "hydrogram",
  telethon: "telethon",
  PIL: "Pillow",
  cv2: "opencv-python",
  bs4: "beautifulsoup4",
  dotenv: "python-dotenv",
  yt_dlp: "yt-dlp",
  youtube_dl: "youtube-dl",
  sklearn: "scikit-learn",
  numpy: "numpy",
  pandas: "pandas",
  matplotlib: "matplotlib",
  gtts: "gTTS",
  googletrans: "googletrans==4.0.0rc1",
  deep_translator: "deep-translator",
  pymongo: "pymongo",
  motor: "motor",
  redis: "redis",
  sqlalchemy: "SQLAlchemy",
  psycopg2: "psycopg2-binary",
  mysql: "mysql-connector-python",
  aiosqlite: "aiosqlite",
  requests: "requests",
  aiohttp: "aiohttp",
  httpx: "httpx",
  flask: "Flask",
  fastapi: "fastapi",
  uvicorn: "uvicorn",
  pydantic: "pydantic",
  qrcode: "qrcode",
  barcode: "python-barcode",
  fpdf: "fpdf2",
  reportlab: "reportlab",
  docx: "python-docx",
  pptx: "python-pptx",
  openpyxl: "openpyxl",
  PyPDF2: "PyPDF2",
  pdfplumber: "pdfplumber",
  moviepy: "moviepy",
  pydub: "pydub",
  speech_recognition: "SpeechRecognition",
  wikipedia: "wikipedia",
  pyjokes: "pyjokes",
  emoji: "emoji",
  dateutil: "python-dateutil",
  pytz: "pytz",
  schedule: "schedule",
  apscheduler: "APScheduler",
  celery: "celery",
  cryptography: "cryptography",
  jwt: "PyJWT",
  bcrypt: "bcrypt",
  firebase_admin: "firebase-admin",
  supabase: "supabase",
  boto3: "boto3",
  googleapiclient: "google-api-python-client",
  tweepy: "tweepy",
  instaloader: "instaloader",
  spotipy: "spotipy",
  groq: "groq",
  openai: "openai",
  google: "google-generativeai",
  anthropic: "anthropic",
  tgcrypto: "TgCrypto",
  pysocks: "PySocks",
  dns: "dnspython",
};

/**
 * The core pack: the 50+ packages a student bot reaches for sooner or
 * later, pinned at floors (not exact versions) so the file installs
 * cleanly on a current Python instead of arguing with it.
 */
export const CORE_PACKAGES = [
  "python-telegram-bot>=21.0", "pyTelegramBotAPI>=4.0", "aiogram>=3.0",
  "pyrogram>=2.0", "telethon>=1.34", "requests>=2.31", "aiohttp>=3.9",
  "httpx>=0.27", "python-dotenv>=1.0", "Flask>=3.0", "fastapi>=0.110",
  "uvicorn>=0.29", "pydantic>=2.6", "pymongo>=4.6", "motor>=3.4",
  "redis>=5.0", "SQLAlchemy>=2.0", "aiosqlite>=0.20", "psycopg2-binary>=2.9",
  "beautifulsoup4>=4.12", "lxml>=5.0", "Pillow>=10.0", "numpy>=1.26",
  "pandas>=2.2", "matplotlib>=3.8", "yt-dlp>=2024.0", "gTTS>=2.5",
  "deep-translator>=1.11", "qrcode>=7.4", "fpdf2>=2.7", "reportlab>=4.0",
  "python-docx>=1.1", "openpyxl>=3.1", "PyPDF2>=3.0", "pdfplumber>=0.11",
  "moviepy>=1.0", "pydub>=0.25", "SpeechRecognition>=3.10", "wikipedia>=1.4",
  "emoji>=2.10", "python-dateutil>=2.9", "pytz>=2024.1", "APScheduler>=3.10",
  "cryptography>=42.0", "PyJWT>=2.8", "firebase-admin>=6.4", "supabase>=2.4",
  "boto3>=1.34", "openai>=1.0", "groq>=0.5", "google-generativeai>=0.5",
  "TgCrypto>=1.2", "PySocks>=1.7", "dnspython>=2.6",
];

/** Top-level modules a Python source imports, in first-seen order. */
export function scanImports(code = "") {
  const found = [];
  const re = /^\s*(?:import\s+([\w.]+(?:\s*,\s*[\w.]+)*)|from\s+([\w.]+)\s+import)/gm;
  let m;
  while ((m = re.exec(String(code)))) {
    const parts = (m[1] ? m[1].split(",") : [m[2]]).map((s) => s.trim().split(".")[0]).filter(Boolean);
    for (const p of parts) if (!found.includes(p)) found.push(p);
  }
  return found;
}

/**
 * The requirements.txt for this script: its own imports resolved to
 * packages first (the lines that decide whether it starts at all),
 * then the core pack, each package once.
 */
export function buildRequirements(code = "") {
  const modules = scanImports(code);
  const detected = [];
  const unknown = [];
  for (const mod of modules) {
    if (STDLIB.has(mod)) continue;
    const pkg = MODULE_TO_PACKAGE[mod];
    if (pkg) detected.push({ module: mod, package: pkg });
    else unknown.push(mod);
  }
  const lines = [];
  const seen = new Set();
  const add = (line) => {
    const key = line.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seen.has(key)) { seen.add(key); lines.push(line); }
  };
  for (const d of detected) add(d.package.includes("=") || d.package.includes(">") ? d.package : `${d.package}>=0`);
  for (const u of unknown) add(u); // best guess: module name is the package name
  for (const core of CORE_PACKAGES) add(core);
  // A ">=0" floor reads as sloppy; plain names install latest-clean.
  const text = lines.map((l) => l.replace(/>=0$/, "")).join("\n") + "\n";
  return { text, detected, unknown, total: lines.length };
}

const TOKEN_IN_CODE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;

/**
 * What would make this script fail or stay silent, said before deploy.
 * `{ level, text }` — a warning is a real risk, a note is a fact the
 * operator should know (polling lines are ignored on a webhook, the
 * panel token wins over a hardcoded one). At most six, worst first.
 */
export function checkScript(code = "", { token = "", scriptRules = null } = {}) {
  const src = String(code || "");
  const out = [];
  const warn = (text) => out.push({ level: "warn", text });
  const note = (text) => out.push({ level: "note", text });

  if (src.trim()) {
    const inCode = src.match(TOKEN_IN_CODE)?.[0];
    if (inCode && token && inCode !== token) {
      warn("Script me dusra bot token likha hai — chalega panel wala token, file wala ignore hoga.");
    } else if (inCode && !token) {
      note("Token script me likha hai; panel me bhi wahi token daal do, deploy usi se hoga.");
    }
    if (/\bTOKEN\s*=\s*["'][^"']{0,4}["']|["']YOUR[_ ]?TOKEN["']|["']YOUR BOT TOKEN["']/i.test(src)) {
      note("Script me token placeholder hai — koi baat nahi, panel wala token chalega.");
    }
    if (scriptRules && !scriptRules.commands?.length && !scriptRules.keywords?.length) {
      warn("Script me koi command ya keyword reply nahi mila — bot panel ke answers se jawab dega. Handler ka reply seedha text likha hai na, ye check kar lo.");
    }
    // Brackets that never close are the number-one paste error.
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      const o = src.split(open).length - 1;
      const c = src.split(close).length - 1;
      if (o !== c) { warn(`Brackets gadbad lag rahe hain: '${open}' ${o} baar, '${close}' ${c} baar — file dobara check karo.`); break; }
    }
    if (/\b(?:infinity_)?polling\s*\(|bot\.launch\s*\(|executor\.start_polling/.test(src)) {
      note("Script polling mode ki hai — hosting webhook par chalti hai, polling wali line yahan ignore hogi (bot fir bhi chalega).");
    }
    const unknown = buildRequirements(src).unknown;
    if (unknown.length) {
      note(`Ye imports standard mapping me nahi mile: ${unknown.slice(0, 5).join(", ")} — requirements me naam se jod diye hain.`);
    }
  }
  return out.slice(0, 6);
}
