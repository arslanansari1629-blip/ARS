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
import { signerHealth, warmSignerHealth } from "./selfheal.mjs";

const DOC_KEY = "arsvibe:brain";
const LOG_MAX = 40;

/** The site's map: everything the Brain is responsible for. */
export const SITE_MAP = {
  pages: Object.keys(PAGE_CONTRACT),
  apis: [...new Set(API_CONTRACT.map((a) => a.path.split("?")[0]))],
  skills: [
    ...new Set([
      "JavaScript", "HTML", "CSS", "Node.js", "Cloudflare Workers", "HLS streaming",
      // The programming the Brain has been taught since: it reads a
      // signer's failure the way an engineer reads a log line —
      // status first (401 credential, 402 quota, 403 wall, 429 rate
      // limit, 5xx illness), then the walk, then the repair — and it
      // remembers the lesson across isolates in the shared store.
      "HTTP status diagnosis", "HLS/DASH playback debugging", "signer ladder repair",
      "quota & rate-limit triage", "cross-isolate health memory", "root-cause classification",
      // The Ultra round: the Brain no longer only reacts — it scores
      // the site's health, remembers every incident by fingerprint,
      // escalates what keeps coming back, and keeps a predictive
      // watch on the organs that are drifting toward failure.
      "health scoring & grading", "incident fingerprint memory", "recurrence escalation",
      "predictive failure watch", "pattern recognition",
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
    incidents: doc?.incidents && typeof doc.incidents === "object" ? doc.incidents : {},
    lastHealth: doc?.lastHealth || null,
  };
}

async function writeBrainDoc(doc) {
  await writeDoc(DOC_KEY, doc).catch(() => "memory");
}

function logLine(doc, kind, text) {
  doc.log = [{ at: new Date().toISOString(), kind, text }, ...doc.log].slice(0, LOG_MAX);
}

/* --------------------- Ultra: health score ---------------------- */

/**
 * One number for the whole site, computed from evidence only. Every
 * deduction is named in `factors`, so the score can always answer
 * "why not 100?" — a score that cannot explain itself is a vibe.
 */
export function brainHealthScore({ healer = null, scannerCounts = null, openFindings = 0, verdict = null, canaryBad = false, botsLive = 0, botsTotal = 0, doctor = null } = {}) {
  const factors = [];
  let score = 100;
  const deduct = (points, label) => {
    if (points <= 0) return;
    score -= points;
    factors.push({ label, points: -points });
  };
  if (canaryBad) deduct(40, "Lecture playback down (canary)");
  const counts = healer?.counts || {};
  deduct(Math.min(30, (counts.failed || 0) * 15), `${counts.failed || 0} healer probe(s) failed`);
  deduct(Math.min(18, (counts.degraded || 0) * 6), `${counts.degraded || 0} probe(s) degraded`);
  deduct(Math.min(12, (counts.escalated || 0) * 6), `${counts.escalated || 0} probe(s) escalated`);
  const sc = scannerCounts || {};
  const high = sc.high ?? openFindings;
  deduct(Math.min(24, (high || 0) * 8), `${high || 0} high-severity finding(s) open`);
  deduct(Math.min(9, (sc.medium || 0) * 3), `${sc.medium || 0} medium finding(s) open`);
  if (verdict?.level === "bad") deduct(20, "Browser error storm");
  else if (verdict?.level === "warn") deduct(8, "Browser errors rising");
  if (botsTotal > 0 && botsLive < botsTotal) deduct(Math.min(20, (botsTotal - botsLive) * 10), `${botsTotal - botsLive} bot(s) not live`);
  const quarantined = doctor?.quarantined?.length || 0;
  deduct(Math.min(15, quarantined * 5), `${quarantined} signer host(s) quarantined`);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 90 ? "S" : score >= 75 ? "A" : score >= 55 ? "B" : score >= 35 ? "C" : "D";
  return { score, grade, factors };
}

/* ------------------- Ultra: incident memory --------------------- */

const INCIDENT_MAX = 60;
export const RECURRENCE_THRESHOLD = 3;

/** A stable fingerprint for anything that can go wrong twice. */
export function incidentFingerprint(item) {
  if (!item || typeof item !== "object") return "";
  const raw = item.key || `${item.area || item.kind || "site"}:${item.where || item.page || ""}:${item.symptom || item.what || item.message || ""}`;
  return String(raw).toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

/**
 * Remember incidents across heartbeats/travels (persisted in the
 * Brain doc, so the memory survives isolates). Returns what is new
 * and what has now crossed the recurrence threshold — the things a
 * merely-reactive overseer would keep "fixing" forever without ever
 * noticing they are the same thing.
 */
export function recordIncidents(doc, items) {
  if (!doc.incidents || typeof doc.incidents !== "object") doc.incidents = {};
  const now = new Date().toISOString();
  const fresh = [];
  const recurring = [];
  for (const item of Array.isArray(items) ? items : []) {
    const fp = incidentFingerprint(item);
    if (!fp) continue;
    const prev = doc.incidents[fp];
    const entry = {
      count: (prev?.count || 0) + 1,
      firstAt: prev?.firstAt || now,
      lastAt: now,
      label: String(item.what || item.symptom || item.message || fp).slice(0, 140),
      severity: item.severity || "",
    };
    doc.incidents[fp] = entry;
    if (!prev) fresh.push(entry);
    if (entry.count === RECURRENCE_THRESHOLD) recurring.push(entry);
  }
  const keys = Object.keys(doc.incidents);
  if (keys.length > INCIDENT_MAX) {
    keys
      .sort((a, b) => Date.parse(doc.incidents[a].lastAt) - Date.parse(doc.incidents[b].lastAt))
      .slice(0, keys.length - INCIDENT_MAX)
      .forEach((k) => delete doc.incidents[k]);
  }
  return { fresh, recurring };
}

/** Incidents seen again within the last hour at/over the threshold. */
export function activeRecurring(doc, withinMs = 3600000) {
  const now = Date.now();
  return Object.values(doc?.incidents || {})
    .filter((e) => e.count >= RECURRENCE_THRESHOLD && now - Date.parse(e.lastAt) < withinMs)
    .sort((a, b) => b.count - a.count);
}

/* ------------------- Ultra: predictive watch -------------------- */

/**
 * The watch list: organs drifting toward failure, named before they
 * fall. Pure pattern-reading over the evidence the Brain already
 * collects — quarantined signers, recurring incidents, degraded
 * probes, bots that answer but are not healthy.
 */
export function brainPredictions({ doctor = null, bots = [], incidents = {}, healer = null } = {}) {
  const watch = [];
  for (const host of doctor?.quarantined || []) {
    watch.push({ level: "high", text: `Signer ${host} quarantine me hai — agar baaki lanes bhi giren to playback ruk sakta hai.` });
  }
  const refusing = (doctor?.hosts || []).filter((h) => /answered (401|402|403|429)/.test(h.reason || "") && !h.quarantined);
  for (const h of refusing.slice(0, 3)) {
    watch.push({ level: "medium", text: `Signer ${h.host} refusal de raha hai (${h.reason}) — quota/credential ki taraf badh raha hai.` });
  }
  for (const e of Object.values(incidents || {})) {
    if (e.count >= RECURRENCE_THRESHOLD) {
      watch.push({ level: "high", text: `Recurring (${e.count}×): ${e.label} — ye khud theek nahi hoga, root cause dekhna hoga.` });
    } else if (e.count === RECURRENCE_THRESHOLD - 1) {
      watch.push({ level: "low", text: `Repeat ho raha hai (2×): ${e.label} — ek aur baar aaya to escalation lagega.` });
    }
  }
  const counts = healer?.counts || {};
  if ((counts.degraded || 0) >= 2) watch.push({ level: "medium", text: `${counts.degraded} probes degraded hain — pattern fail ki taraf ja raha hai.` });
  for (const b of bots || []) {
    if (b.status === "live" && b.health && b.health !== "ok" && b.health !== "healthy") {
      watch.push({ level: "medium", text: `Bot ${b.name} live hai par health "${b.health}" hai — girne se pehle nazar rakho.` });
    }
  }
  return watch.slice(0, 8);
}

/** Mood from evidence, never from vibes. */
export function brainMood({ automation = true, healer = null, verdict = null, lastFixAt = "", canaryBad = false, escalated = false } = {}) {
  if (!automation) return "sleeping";
  // The playback canary is the site's raison d'être failing out loud:
  // lectures cannot be signed right now. A Brain that says "happy"
  // through that is lying with a smile.
  if (canaryBad) return "worried";
  // A recurring incident is a failure the site keeps having: that is
  // a worried Brain even while each single instance looks "degraded".
  if (escalated) return "worried";
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

/** When the canary itself is down, the line names the actual problem. */
const CANARY_LINE =
  "Lectures abhi play nahi ho rahe — PW ke signing relays jawab nahi de rahe. Main har kuch minute me dobara try kar raha hoon; relay wapas aate hi lectures khud chal padenge 🔧";

/**
 * Is lecture playback down — across isolates? The healer's canary lives
 * in whichever isolate ran the sweep; the shared `arsvibe:playback` doc
 * (written by every real signer probe, see lib/api-data.mjs) is the
 * verdict any isolate can read. Fresh (<30 min) failure wins; a stale
 * doc is silence, not evidence.
 */
export async function playbackDown() {
  const canary = healerReport().autopilot?.canary || null;
  if (canary && !canary.skipped) {
    return canary.ok ? null : { detail: canary.detail || "", via: "canary" };
  }
  try {
    const p = await readDoc("arsvibe:playback");
    if (p && p.ok === false && Date.now() - Date.parse(p.at) < 30 * 60 * 1000) {
      return { detail: p.detail || "", via: "probe", at: p.at };
    }
  } catch { /* an unreadable store is not evidence of anything */ }
  return null;
}

/**
 * The playback doctor: what the Brain has learned about the signer
 * ladder, in one diagnosis a human can act on. It reads the learned
 * per-host health (warmed from the shared store, so a fresh isolate
 * still knows yesterday's lesson) and names the pattern: a 402 is a
 * quota wall, a wall of 403s is an egress block, silence is illness.
 * This is the "programming" the Brain was taught — classify by
 * evidence, recommend the repair that matches the class.
 */
export async function playbackDoctor() {
  await warmSignerHealth().catch(() => {});
  const hosts = signerHealth();
  const quarantined = hosts.filter((h) => h.quarantined);
  const refusing = hosts.filter((h) => /answered (401|402|403|429)/.test(h.reason || ""));
  const quota = hosts.filter((h) => /answered 402/.test(h.reason || ""));
  const healthy = hosts.filter((h) => h.weight >= 0.75 && h.samples > 0);
  let diagnosis = "Signer ladder par abhi koi saboot-wali gadbad nahi hai.";
  let action = "Kuch karne ki zaroorat nahi — ladder apne aap ranked hai.";
  if (quota.length) {
    diagnosis = `${quota.map((h) => h.host).join(", ")} 402 (quota/payment wall) de raha hai — woh lane paisa/quota maang rahi hai, lecture kharab nahi hai.`;
    action = "Us lane ko ladder me neeche rakh diya hai; baaki lanes se signing chalti rahegi. Quota renew hote hi lane khud wapas upar aa jayegi.";
  } else if (quarantined.length && !healthy.length) {
    diagnosis = "Saare known signer hosts quarantine me hain — signing poori tarah down hai.";
    action = "Quarantine 5 minute me khud expire hoti hai; Brain har probe par dobara koshish karta hai. Agar ye ghante bhar rahe, to naya signer (ARS_SIGNER_URL) lagana padega.";
  } else if (refusing.length) {
    diagnosis = `${refusing.length} signer host credential/quota refusal de rahe hain; ${healthy.length} healthy hain.`;
    action = "Healthy lanes ko pehle ranked kiya hai; refusing lanes demote/quarantine me hain aur khud recover hongi.";
  }
  return {
    hosts,
    quarantined: quarantined.map((h) => h.host),
    healthy: healthy.map((h) => h.host),
    diagnosis,
    action,
  };
}

/** Everything the Brain knows, for the admin panel. */
export async function brainReport() {
  const doc = await readBrainDoc();
  const healer = healerReport();
  const scanner = scannerReport();
  const faults = clientFaults();
  const verdict = clientFaultVerdict(faults);
  const bots = await listBots().catch(() => ({ bots: [] }));
  const open = findings().open || [];
  const canary = healer.autopilot?.canary || null;
  const down = await playbackDown();
  const canaryBad = Boolean(down);
  const doctor = await playbackDoctor().catch(() => null);
  const botRows = (bots.bots || []).map((b) => ({
    name: b.name,
    status: b.status,
    health: b.stats?.health || null,
    messages: b.stats?.messages || 0,
  }));
  const recurringNow = activeRecurring(doc);
  const health = brainHealthScore({
    healer,
    scannerCounts: scanner.counts,
    verdict,
    canaryBad,
    botsLive: botRows.filter((b) => b.status === "live").length,
    botsTotal: botRows.length,
    doctor,
  });
  const mood = brainMood({ automation: doc.automation, healer, verdict, lastFixAt: doc.log.find((l) => l.kind === "fix")?.at || "", canaryBad, escalated: recurringNow.length > 0 });
  return {
    success: true,
    mood,
    line: canaryBad ? CANARY_LINE : MOOD_LINES[mood],
    health,
    predictions: brainPredictions({ doctor, bots: botRows, incidents: doc.incidents, healer }),
    memory: {
      incidents: Object.values(doc.incidents).sort((a, b) => b.count - a.count).slice(0, 10),
      recurring: recurringNow,
    },
    playback: { canary, down },
    automation: doc.automation,
    lastTick: doc.lastTick,
    lastTravel: doc.lastTravel,
    travel: doc.travel,
    fixedTotal: doc.fixedTotal,
    seenTotal: doc.seenTotal,
    log: doc.log,
    site: { pages: SITE_MAP.pages.length, apis: SITE_MAP.apis.length, skills: SITE_MAP.skills, pageList: SITE_MAP.pages },
    doctor,
    healer: { counts: healer.counts, swept: healer.swept, probeAt: healer.probeAt, autopilot: healer.autopilot },
    scanner: { open: Array.isArray(open) ? open.slice(0, 12) : [], counts: scanner.counts, progress: scanner.progress },
    browserErrors: { verdict, recent: faults.open?.slice(0, 8) || [], counts: faults.counts },
    bots: botRows,
    store: storeName(),
  };
}

/** The one-line hello the little on-page brain speaks. Public-safe. */
export async function brainPublic() {
  const doc = await readBrainDoc();
  const verdict = clientFaultVerdict();
  const healer = healerReport();
  const down = await playbackDown();
  const canaryBad = Boolean(down);
  const mood = brainMood({ automation: doc.automation, healer, verdict, lastFixAt: doc.log.find((l) => l.kind === "fix")?.at || "", canaryBad });
  const bots = await listBots().catch(() => ({ bots: [] }));
  return {
    success: true,
    mood,
    line: canaryBad ? CANARY_LINE : MOOD_LINES[mood],
    playbackDown: canaryBad,
    fixed: doc.fixedTotal,
    lastTick: doc.lastTick,
    automation: doc.automation,
    pages: SITE_MAP.pages.length,
    bots: {
      live: (bots.bots || []).filter((b) => b.status === "live").length,
      total: (bots.bots || []).length,
    },
    openErrors: (findings().open || []).length + (verdict.level === "ok" ? 0 : 1),
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

  const down = await playbackDown();
  if (down) {
    const already = doc.log[0]?.kind === "alert" && /Lecture playback/.test(doc.log[0].text) && Date.now() - Date.parse(doc.log[0].at) < 3600000;
    if (!already) {
      doc.seenTotal += 1;
      logLine(doc, "alert", `Lecture playback down: ${down.detail || "signing relays jawab nahi de rahe"} — lectures auto-retry par hain, relay wapas aate hi chal padenge.`);
    }
  }
  const verdict = clientFaultVerdict();
  if (verdict.level === "bad") {
    const already = doc.log[0]?.kind === "alert" && Date.now() - Date.parse(doc.log[0].at) < 3600000;
    if (!already) {
      doc.seenTotal += 1;
      logLine(doc, "alert", `Browser errors badh rahe hain: ${verdict.summary} — admin panel me details hain.`);
    }
  }
  // Ultra memory: fingerprint whatever the scanner is currently
  // holding open, and escalate the ones that keep coming back
  // instead of greeting them as strangers every five minutes.
  try {
    const { recurring } = recordIncidents(doc, findings().open || []);
    const escalated = recurring.filter((e) => Date.now() - Date.parse(e.lastAt) < 3600000);
    if (escalated.length) {
      const already = doc.log[0]?.kind === "alert" && /Recurring/.test(doc.log[0].text) && Date.now() - Date.parse(doc.log[0].at) < 3600000;
      if (!already) {
        doc.seenTotal += escalated.length;
        logLine(doc, "alert", `Recurring problem pakda: ${escalated[0].label} (${escalated[0].count}× ho chuka hai) — ye khud theek nahi hoga, root cause chahiye.`);
      }
    }
  } catch { /* memory is an enhancement, never a heartbeat dependency */ }
  doc.lastHealth = brainHealthScore({
    healer: healerReport(),
    scannerCounts: scannerReport().counts,
    verdict,
    canaryBad: Boolean(down),
  });
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

  // Ultra memory, travel edition: findings + repair actions are
  // fingerprinted too, so a symptom the healer "fixes" every day is
  // recognised as one recurring incident, not thirty surprises.
  try {
    const seen = [...(scan?.findings || findings().open || []), ...actions];
    const { recurring } = recordIncidents(doc, seen);
    for (const e of recurring.slice(0, 3)) {
      logLine(doc, "alert", `Recurring (${e.count}×): ${e.label} — baar-baar aa raha hai, root cause ki zaroorat hai.`);
    }
  } catch { /* memory must never sink a travel */ }

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
