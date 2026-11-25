/**
 * The Site Brain — one cute overseer for the whole site.
 *
 * The site already had organs: a scanner that travels the pages, a
 * healer with probes and repairs, a fault log where browsers report
 * their own script errors, a watchdog that keeps Telegram bots alive.
 * What it did not have was the thing a student (and the operator) can
 * point at and ask "is everything okay?" — so this module is that
 * thing. The Brain:
 *
 *   · holds the whole site's map — every page in the scanner's
 *     contract, every API route, every bot — its "source", the thing
 *     it watches over;
 *   · travels: a full pass runs the scanner over the pages and APIs,
 *     sweeps the healer's probes, and checks every bot's webhook;
 *   · automates: with automation on, a sweep applies the healer's
 *     repairs the moment a probe fails, drifted bot webhooks are
 *     re-registered, and every action is written to the Brain's log;
 *   · reports: one mood (happy / fixing / worried / sleeping), what it
 *     saw, what it fixed, and what still needs a human — on the admin
 *     panel, and as a one-line hello from the little brain that rides
 *     along on every page.
 *
 * It is an overseer, not a second engine: fixing is the healer's job,
 * travelling is the scanner's, answering bots is the watchdog's. The
 * Brain watches them all, starts them, and keeps the diary.
 */

import { readDoc, writeDoc, storeName } from "./store.mjs";
import { PAGE_CONTRACT, API_CONTRACT, scanPass, scannerReport, findings } from "./scanner.mjs";
import { healerReport, sweep } from "./healer.mjs";
import { clientFaults, clientFaultVerdict } from "./client-errors.mjs";
import { listBots, watchdogBots, LANGUAGES } from "./bot-host.mjs";

const DOC_KEY = "arsvibe:brain";
const LOG_MAX = 40;

/** The site's map: everything the Brain is responsible for. */
export const SITE_MAP = {
  pages: Object.keys(PAGE_CONTRACT),
  apis: [...new Set(API_CONTRACT.map((a) => a.path.split("?")[0]))],
  skills: [
    ...new Set([
      "JavaScript", "HTML", "CSS", "Node.js", "Cloudflare Workers", "HLS streaming",
      ...LANGUAGES.map((l) => l.name),
    ]),
  ],
};

async function readBrainDoc() {
  const doc = await readDoc(DOC_KEY).catch(() => null);
  return {
    automation: doc?.automation !== false,
    lastTick: doc?.lastTick || "",
    lastTravel: doc?.lastTravel || "",
    fixedTotal: doc?.fixedTotal || 0,
    seenTotal: doc?.seenTotal || 0,
    travel: doc?.travel || null,
    log: Array.isArray(doc?.log) ? doc.log : [],
  };
}

async function writeBrainDoc(doc) {
  await writeDoc(DOC_KEY, doc).catch(() => "memory");
}

function logLine(doc, kind, text) {
  doc.log = [{ at: new Date().toISOString(), kind, text }, ...doc.log].slice(0, LOG_MAX);
}

/** Mood from evidence, never from vibes. */
export function brainMood({ automation = true, healer = null, verdict = null, lastFixAt = "" } = {}) {
  if (!automation) return "sleeping";
  const counts = healer?.counts || {};
  if ((counts.failed || 0) > 0 || verdict?.level === "bad") return "worried";
  if ((counts.degraded || 0) > 0 || (counts.repairing || 0) > 0 || verdict?.level === "warn") return "fixing";
  if (lastFixAt && Date.now() - Date.parse(lastFixAt) < 15 * 60000) return "fixing";
  return "happy";
}

const MOOD_LINES = {
  happy: "Sab theek hai 💚 Main poori site par nazar rakhe hoon.",
  fixing: "Ek gadbad mili thi — fix kar raha hoon 🛠️",
  worried: "Kuch errors dikhe hain jo mujhse fix nahi hue — admin panel me bata diya hai ⚠️",
  sleeping: "Main so raha hoon 😴 Automation off hai — admin se jagaa sakte ho.",
};

/** Everything the Brain knows, for the admin panel. */
export async function brainReport() {
  const doc = await readBrainDoc();
  const healer = healerReport();
  const scanner = scannerReport();
  const faults = clientFaults();
  const verdict = clientFaultVerdict(faults);
  const bots = await listBots().catch(() => ({ bots: [] }));
  const open = findings().open || [];
  const mood = brainMood({ automation: doc.automation, healer, verdict, lastFixAt: doc.log.find((l) => l.kind === "fix")?.at || "" });
  return {
    success: true,
    mood,
    line: MOOD_LINES[mood],
    automation: doc.automation,
    lastTick: doc.lastTick,
    lastTravel: doc.lastTravel,
    travel: doc.travel,
    fixedTotal: doc.fixedTotal,
    seenTotal: doc.seenTotal,
    log: doc.log,
    site: { pages: SITE_MAP.pages.length, apis: SITE_MAP.apis.length, skills: SITE_MAP.skills, pageList: SITE_MAP.pages },
    healer: { counts: healer.counts, swept: healer.swept, probeAt: healer.probeAt, autopilot: healer.autopilot },
    scanner: { open: Array.isArray(open) ? open.slice(0, 12) : [], counts: scanner.counts, progress: scanner.progress },
    browserErrors: { verdict, recent: faults.open?.slice(0, 8) || [], counts: faults.counts },
    bots: (bots.bots || []).map((b) => ({
      name: b.name,
      status: b.status,
      health: b.stats?.health || null,
      messages: b.stats?.messages || 0,
    })),
    store: storeName(),
  };
}

/** The one-line hello the little on-page brain speaks. Public-safe. */
export async function brainPublic() {
  const doc = await readBrainDoc();
  const verdict = clientFaultVerdict();
  const healer = healerReport();
  const mood = brainMood({ automation: doc.automation, healer, verdict, lastFixAt: doc.log.find((l) => l.kind === "fix")?.at || "" });
  return {
    success: true,
    mood,
    line: MOOD_LINES[mood],
    fixed: doc.fixedTotal,
    lastTick: doc.lastTick,
    automation: doc.automation,
    pages: SITE_MAP.pages.length,
  };
}

export async function setBrainAutomation(on) {
  const doc = await readBrainDoc();
  doc.automation = Boolean(on);
  logLine(doc, "note", doc.automation ? "Automation on — ab errors khud fix honge." : "Automation off — Brain sirf dekhega, fix nahi karega.");
  await writeBrainDoc(doc);
  return { success: true, automation: doc.automation };
}

/**
 * The heartbeat (cron, every few minutes): cheap and constant. Bots
 * are checked and healed, the mood is recomputed from the organs'
 * own reports, and anything new is written in the diary. The heavy
 * travel is `brainTravel` — the daily scan and the panel's button.
 */
export async function brainHeartbeat() {
  const doc = await readBrainDoc();
  doc.lastTick = new Date().toISOString();
  let healed = 0;
  try {
    const wd = await watchdogBots();
    healed = wd.healed || 0;
    if (healed) {
      doc.fixedTotal += healed;
      logLine(doc, "fix", `${healed} bot ka webhook drift hua tha — khud dobara laga diya.`);
    }
  } catch { /* a bot check that could not run is not evidence of anything */ }

  const verdict = clientFaultVerdict();
  if (verdict.level === "bad") {
    const already = doc.log[0]?.kind === "alert" && Date.now() - Date.parse(doc.log[0].at) < 3600000;
    if (!already) {
      doc.seenTotal += 1;
      logLine(doc, "alert", `Browser errors badh rahe hain: ${verdict.summary} — admin panel me details hain.`);
    }
  }
  await writeBrainDoc(doc);
  return { success: true, healed };
}

/**
 * A full travel of the site: scanner over pages and APIs, healer
 * sweep (repairs applied when automation is on), bot watchdog. What
 * was seen and what was fixed lands in the diary either way.
 */
export async function brainTravel(base, { batches = [] } = {}) {
  const doc = await readBrainDoc();
  const started = Date.now();
  const automation = doc.automation;
  logLine(doc, "travel", `Site travel shuru — ${SITE_MAP.pages.length} pages, ${SITE_MAP.apis.length} APIs, bots aur probes.`);

  let actions = [];
  try {
    const sw = await sweep({ apply: automation });
    actions = sw.actions || [];
  } catch { /* probes that cannot run say so in their own report */ }

  let scan = null;
  if (base) {
    scan = await scanPass({ base, batches }).catch(() => null);
  }
  let healed = 0;
  try {
    healed = (await watchdogBots()).healed || 0;
  } catch { /* same as the heartbeat: silence is not evidence */ }

  const fixedNow = actions.filter((a) => a && a.ran !== false).length + healed;
  doc.fixedTotal += fixedNow;
  doc.seenTotal += actions.length;
  doc.lastTravel = new Date().toISOString();
  doc.lastTick = doc.lastTravel;
  doc.travel = {
    at: doc.lastTravel,
    ms: Date.now() - started,
    checks: scan?.checks || 0,
    findings: scan?.findings?.length ?? (findings().open || []).length,
    repairs: actions.length,
    botsHealed: healed,
    automation,
  };
  if (actions.length) {
    for (const a of actions.slice(0, 5)) {
      logLine(doc, automation ? "fix" : "alert", `Probe fail: ${a.symptom || "symptom"} — ${automation ? "repair chala diya." : "automation off hai, admin ko bataya."}`);
    }
  }
  if (healed) logLine(doc, "fix", `${healed} bot webhook heal hue travel me.`);
  if (!actions.length && !healed) logLine(doc, "ok", "Travel poora — koi gadbad nahi mili. Sab theek 💚");
  await writeBrainDoc(doc);
  return brainReport();
}
