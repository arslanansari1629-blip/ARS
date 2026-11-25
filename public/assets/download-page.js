/* =========================================================================
   Lecture download page — one lecture, one job, no dead ends.
   -------------------------------------------------------------------------
   Opened in a new tab from the player's Download button with the
   lecture's coordinates in the query. It resolves the stream, walks
   the quality ladder until one answers, then downloads with live
   progress. Every failure mode the old in-player flow could hit —
   signer asleep, a quality that refuses, a network blink, a partial
   lecture — is answered here with an automatic retry before a human
   is ever asked to tap anything.
   ========================================================================= */

import { mountChrome, esc, qs, toast } from "./app.js";
import { folderOf } from "./player.js";

mountChrome("downloads");

const $ = (id) => document.getElementById(id);
const titleEl = $("dlTitle"), phaseEl = $("dlPhase"), barEl = $("dlBar"), barWrap = $("dlBarWrap");
const pctEl = $("dlPct"), partsEl = $("dlParts"), sizeEl = $("dlSize"), speedEl = $("dlSpeed"), etaEl = $("dlEta");
const noteEl = $("dlNote"), qualityEl = $("dlQuality"), subEl = $("dlSub");

const batch = qs("batch") || "";
const subject = qs("subject") || "";
const id = qs("id") || "";
const title = (qs("title") || "Lecture").trim();

titleEl.textContent = title;
document.title = `Downloading: ${title} — ArsVibe PW`;

let controller = null;
let cancelled = false;
let lastBytes = 0, lastAt = Date.now(), speedBps = 0;

function setPhase(text) { phaseEl.textContent = text; }
function note(text) { noteEl.textContent = text || ""; }
function paint(p) {
  const pct = p.total ? Math.min(100, Math.round((p.segments / p.total) * 100)) : 0;
  barEl.style.width = `${pct}%`;
  barWrap.setAttribute("aria-valuenow", String(pct));
  pctEl.textContent = `${pct}%`;
  partsEl.textContent = p.total ? `${p.segments} of ${p.total} parts` : `${p.segments} parts`;
  if (Number.isFinite(p.bytes)) sizeEl.textContent = `${(p.bytes / 1048576).toFixed(1)} MB`;
  const now = Date.now();
  if (Number.isFinite(p.bytes) && now > lastAt) {
    const inst = ((p.bytes - lastBytes) * 1000) / (now - lastAt);
    if (inst >= 0) speedBps = speedBps ? speedBps * 0.6 + inst * 0.4 : inst;
    lastBytes = p.bytes; lastAt = now;
    if (speedBps > 1024) {
      speedEl.textContent = `${(speedBps / 1048576).toFixed(1)} MB/s`;
      if (p.total && p.segments < p.total && p.bytes > 0) {
        const totalBytes = (p.bytes / Math.max(1, p.segments)) * p.total;
        const left = Math.max(0, (totalBytes - p.bytes) / speedBps);
        etaEl.textContent = left > 90 ? `~${Math.round(left / 60)} min left` : left > 5 ? `~${Math.round(left)}s left` : "finishing…";
      }
    }
  }
}

async function getJson(url, tries = 1) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller?.signal });
      const data = await res.json().catch(() => null);
      if (data) return data;
      lastErr = new Error(`Empty answer (${res.status})`);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 900 * (i + 1)));
  }
  throw lastErr || new Error("The server did not answer");
}

const QUALITY_LADDER = ["720", "480", "360", "240"];

async function resolveFolder(attempt) {
  const data = await getJson(
    `/api/stream?batch=${encodeURIComponent(batch)}&subject=${encodeURIComponent(subject)}&id=${encodeURIComponent(id)}&attempt=${attempt}`
  );
  if (data?.playable && data.url) return { folder: folderOf(data.url), plan: data };
  return { folder: "", plan: data };
}

async function run() {
  cancelled = false;
  controller = new AbortController();
  $("dlRetry").hidden = true;
  $("dlCancel").hidden = false;

  if (!batch || !subject || !id) {
    setPhase("This link is missing its lecture");
    note("Open the lecture and tap Download this video again — this page needs the batch, subject and lecture id.");
    return;
  }

  /* 1 · resolve the stream; a sleeping signer gets time, not an error.
   * This loop used to stop after six attempts and hand the student a
   * Resume button — which reads as "download failed" even though the
   * lecture was fine and only the signing relays were down. A download
   * page's whole job is patience: it now waits indefinitely (backoff
   * capped at a minute), because a signer lane coming back at minute
   * nine should finish the download, not meet a page that gave up at
   * minute three. Cancel is always there for a human who disagrees. */
  setPhase("Resolving the stream…");
  let folder = "";
  let plan = null;
  for (let attempt = 0; !folder; attempt++) {
    if (cancelled) return;
    try {
      const out = await resolveFolder(attempt);
      folder = out.folder; plan = out.plan;
    } catch { /* counted below as another sleep cycle */ }
    if (!folder) {
      if (plan && plan.playable === false && plan.reason && !plan.signerDown && attempt >= 2) {
        // A permanent answer (not published / not a video) is not a
        // sleeping signer; waiting would never change it.
        setPhase("The stream could not be resolved");
        note(plan.reason);
        $("dlRetry").hidden = false;
        $("dlCancel").hidden = true;
        return;
      }
      const wait = Math.min(60, 8 + attempt * 4);
      note(`The signing relays are not answering right now — your lecture is safe. Retrying on its own in ${wait}s (attempt ${attempt + 1}). Keep this tab open; nothing for you to do.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  /* 2 · walk the quality ladder until one can be listed — patiently,
   * for the same reason: a listing refused during a signer outage is
   * weather, not a verdict on the lecture. */
  setPhase("Preparing the download…");
  let info = null;
  const preferred = [String((plan.renditions && plan.renditions[0]) || plan.quality || "720"), ...QUALITY_LADDER];
  for (let round = 0; !info; round++) {
    for (const q of [...new Set(preferred)]) {
      if (cancelled) return;
      try {
        const data = await getJson(`/api/download?mode=list&folder=${encodeURIComponent(folder)}&quality=${encodeURIComponent(q)}`, 2);
        if (data?.playable) { info = data; break; }
      } catch { /* next rung */ }
    }
    if (!info) {
      const wait = Math.min(60, 10 + round * 5);
      note(`Every quality refused the listing — the signing relays are still waking up. Retrying on its own in ${wait}s. Keep this tab open.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  qualityEl.hidden = false;
  qualityEl.textContent = `${info.quality || ""}p`.replace(/^p$/, "Auto");

  /* 3 · download, with one full automatic restart if it dies mid-way. */
  const { downloadLecture } = await import("./downloader.js");
  setPhase("Downloading…");
  subEl.textContent = "Keep this tab open — progress saves to this device as it lands.";
  let result = null;
  for (let round = 0; round < 2 && !cancelled; round++) {
    if (round > 0) note("The download stopped mid-way — restarting it on its own…");
    try {
      result = await downloadLecture({
        id,
        folder,
        quality: info.quality,
        title,
        format: info.encrypted ? "plain" : "playlist",
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "retry") note(`A slice did not answer — retrying it (attempt ${p.attempt}). The rest is safe.`);
          else if (p.phase === "downloading") note("");
          paint(p);
        },
      });
    } catch (err) {
      if (cancelled || err?.name === "AbortError") return;
      result = null;
      note(err.message || "The download hit a problem — restarting…");
    }
    if (result?.ok) break;
  }

  if (cancelled) return;
  $("dlCancel").hidden = true;
  if (result?.ok) {
    setPhase("Download complete 🎉");
    barEl.style.width = "100%";
    pctEl.textContent = "100%";
    etaEl.textContent = "";
    speedEl.textContent = "";
    note(result.skipped
      ? `Saved — ${result.skipped} moment${result.skipped === 1 ? "" : "s"} could not be fetched and were left out.`
      : "Saved on this device. It plays with no network at all, any time, from Downloads.");
    $("dlPlay").hidden = false;
    $("dlSaveFile").hidden = false;
    toast(`"${title}" downloaded`);
  } else {
    setPhase("Download paused");
    note("Part of the lecture is saved on this device. Resume and it continues; nothing already fetched is wasted on the Downloads page.");
    $("dlRetry").hidden = false;
  }
}

$("dlCancel")?.addEventListener("click", () => {
  cancelled = true;
  controller?.abort();
  setPhase("Download cancelled");
  note("What already arrived stays saved on this device — resume any time, or finish it from the Downloads page.");
  $("dlCancel").hidden = true;
  $("dlRetry").hidden = false;
});
$("dlRetry")?.addEventListener("click", run);
$("dlPlay")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const { playSaved } = await import("./offline-player.js");
  const ok = await playSaved(id, { trigger: $("dlPlay") }).catch(() => false);
  if (!ok) window.location.assign("/downloads.html");
});
$("dlSaveFile")?.addEventListener("click", async () => {
  try {
    const { savedLecture, offlineFile } = await import("./downloader.js");
    const record = await savedLecture(id);
    if (!record) throw new Error("saved copy not found");
    const { blob, name } = offlineFile(record);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name || `${title}.ts`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  } catch {
    toast("The file could not be assembled — the offline copy still plays from Downloads", "bad");
  }
});

run();
