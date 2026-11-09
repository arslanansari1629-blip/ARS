/* Lecture page — resolves the PW stream, drives the pro player, persists progress */

import {
  api,
  mountChrome,
  esc,
  qs,
  toast,
  fmtDate,
  getPrefs,
  setPref,
} from "./app.js";
import { trackLecture } from "./library.js";
import { loadLecture, loadContents } from "./data.js";
import { upstream as upstreamJson } from "./client-api.js";
import { ProPlayer, fmtTime, folderOf } from "./player.js";

mountChrome("batches");

const batchId = qs("batch");
const subjectSlug = qs("subject");
const lectureId = qs("id");
const titleParam = qs("title");

const $ = (id) => document.getElementById(id);

const video = $("video");
const embed = $("embed");
const stage = $("playerStage");
const root = $("playerRoot");
const surface = $("playerSurface");
const veil = $("playerVeil");
const veilText = $("veilText");
const veilBuffer = $("veilBuffer");
const stoppedPane = $("playerStopped");
const stoppedTitle = $("stoppedTitle");
const bigPlayBtn = $("bigPlayBtn");
const gestureFlash = $("gestureFlash");
const scrubberTrack = document.querySelector("#scrubber .scrubber-track");

const overlay = $("overlay");
const overlayTitle = $("overlayTitle");
const overlayText = $("overlayText");
const overlayActions = $("overlayActions");
const spinner = $("spinner");

const titleEl = $("lectureTitle");
const metaEl = $("lectureMeta");
const docsEl = $("docs");
const docCount = $("docCount");
const crumbs = $("crumbs");
const aboutText = $("aboutText");
const positionLabel = $("positionLabel");
const queueNav = $("queueNav");

const playBtn = $("playBtn");
const prevBtn = $("prevBtn");
const nextBtn = $("nextBtn");
const pipBtn = $("pipBtn");
const fullscreenBtn = $("fullscreenBtn");
const skipBackBtn = $("skipBackBtn");
const skipFwdBtn = $("skipFwdBtn");
const restartBtn = $("restartBtn");
const muteBtn = $("muteBtn");
const volumeSlider = $("volume");
const speedStep = $("speedStep");
const speedDown = $("speedDown");
const speedUp = $("speedUp");
const speedRate = $("speedRate");
const speedRateText = $("speedRateText");
const nowState = $("nowState");
const nowTitle = $("nowTitle");
const nowProgress = $("nowProgress");
const nowPosition = $("nowPosition");
const nowDuration = $("nowDuration");
const nowPlay = $("nowPlay");
const nowBack = $("nowBack");
const nowFwd = $("nowFwd");
const qualitySelect = $("quality");
const loopBtn = $("loopBtn");
const statsBtn = $("statsBtn");
const settingsBtn = $("settingsBtn");
const playerMenu = $("playerMenu");
const menuSpeed = $("menuSpeed");
const statsPane = $("playerStats");
const healthChip = $("streamHealth");

const scrubber = $("scrubber");
const scrubberTip = $("scrubberTip");
const playedBar = $("playedBar");
const bufferedBar = $("bufferedBar");
const scrubberKnob = $("scrubberKnob");

const positionKey = `pos:${lectureId}`;
/** Where this lecture sits in its chapter, so "next" means the next class. */
let queue = { ids: [], index: -1 };
/** Stream resolution attempts; each one bypasses the resolver's cache. */
let attempt = 0;
let currentPlan = null;
let pro = null;
let durations = { elapsed: true };
let statsVisible = false;

/* ------------------------------ page chrome ------------------------------ */

if (titleParam) {
  titleEl.textContent = titleParam;
  document.title = `${titleParam} — ArsVibe PW`;
}
crumbs.innerHTML = `<a href="/">Home</a> <span>/</span>
  <a href="/batch.html?id=${encodeURIComponent(batchId)}">Batch</a> <span>/</span>
  <a href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subjectSlug)}">Subject</a> <span>/</span>
  <span class="truncate">${esc(titleParam || "Lecture")}</span>`;

function checkUrl() {
  return `/api/check?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
    subjectSlug
  )}&id=${encodeURIComponent(lectureId)}`;
}

function showMessage(title, text, error = false, actions = "") {
  overlay.style.display = "grid";
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  spinner.style.display = "none";
  overlayActions.innerHTML = actions;
  overlay.style.background = error
    ? "radial-gradient(circle at 50% 40%, rgba(255,93,115,.18), rgba(5,6,12,.96))"
    : "radial-gradient(circle at 50% 40%, rgba(108,92,231,.28), rgba(5,6,12,.94))";
}

function showLoading(title, text) {
  overlay.style.display = "grid";
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  spinner.style.display = "block";
  overlayActions.innerHTML = "";
}

function hideOverlay() {
  overlay.style.display = "none";
}

if (!batchId || !subjectSlug || !lectureId) {
  showMessage("Missing lecture", "Open a lecture from a chapter list.", true);
} else {
  boot();
}

/* ------------------------------- boot / data ------------------------------ */

async function boot() {
  showLoading("Preparing your lecture…", "Fetching stream details from Physics Wallah.");

  // Start resolving the stream *before* the metadata call, and await it after.
  // The schedule endpoint can take several seconds on a cold function; making
  // the player wait for a title it does not need was most of the time to the
  // first frame.
  const stream = startStream();

  let detail = null;
  try {
    detail = await loadLecture(batchId, subjectSlug, lectureId);
  } catch {
    // Lecture metadata is optional — the schedule endpoint may rate-limit.
    detail = null;
  }

  if (detail && detail.lecture) {
    const l = detail.lecture;
    titleEl.textContent = l.title || titleParam || "Lecture";
    document.title = `${l.title} — ArsVibe PW`;
    metaEl.textContent = [l.date ? fmtDate(l.date) : "", l.duration, l.topicInfo]
      .filter(Boolean)
      .join(" · ");
    aboutText.textContent =
      l.description || l.topicInfo || "No description published for this lecture.";
    if (l.thumbnail) video.poster = l.thumbnail;
    trackLecture({
      id: lectureId,
      title: l.title || titleParam,
      batch: batchId,
      subject: subjectSlug,
      thumbnail: l.thumbnail || "",
      chapter: (l.tags && l.tags[0]) || titleParam || "",
    });
    renderDocs(detail.docs || []);
    loadQueue((l.tags && l.tags[0]) || "");
  } else {
    metaEl.textContent = "Lecture details are loading from the chapter list.";
    docsEl.innerHTML = `<div class="attach-empty">No attachments could be loaded for this lecture.</div>`;
    docCount.textContent = "0";
  }

  // The player may already be running; this only waits for it to finish.
  await stream;
}

/**
 * Attachments: one fixed grid per file (badge / name / actions), so a long
 * name truncates inside its track instead of widening the player column.
 * The kind is inferred from the file, because "PDF" on a video is a lie.
 */
function docIcon(name) {
  const ext = String((name || "").split(".").pop() || "").toLowerCase();
  return { png: "IMG", jpg: "IMG", jpeg: "IMG", zip: "ZIP", mp4: "VID" }[ext] || "PDF";
}

function renderDocs(docs) {
  if (!docs.length) {
    docsEl.innerHTML = `<div class="attach-empty">No notes or DPPs attached to this lecture.</div>`;
    docCount.textContent = "0";
    return;
  }
  docCount.textContent = `${docs.length} file${docs.length === 1 ? "" : "s"}`;
  docsEl.innerHTML = docs
    .map((d) => {
      const kind = docIcon(d.name);
      const viewer = `/viewer.html?url=${encodeURIComponent(d.url)}&name=${encodeURIComponent(d.name)}`;
      const meta = d.note || d.topic || "Document";
      return `
      <div class="attach-row">
        <span class="pdf${kind === "VID" ? " video" : ""}">${kind}</span>
        <span class="attach-text">
          <span class="attach-name" title="${esc(d.name)}">${esc(d.name)}</span>
          <span class="attach-meta" title="${esc(meta)}">${esc(meta)}</span>
        </span>
        <span class="attach-actions">
          <a class="btn btn-ghost" href="${viewer}" target="_blank" rel="noopener" title="Open in the reader" aria-label="Open ${esc(d.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>
          </a>
          <a class="btn btn-ghost" href="/api/media?url=${encodeURIComponent(d.url)}" download title="Download" aria-label="Download ${esc(d.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M4.5 19h15"/></svg>
          </a>
        </span>
      </div>`;
    })
    .join("");
}

/** Resolve a plan from the server, honouring the attempt counter. */
async function resolvePlan(n) {
  let plan = await api(
    `/api/stream?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
      subjectSlug
    )}&id=${encodeURIComponent(lectureId)}${n ? `&attempt=${n}` : ""}${
      n ? `&cb=${Date.now().toString(36)}` : ""
    }`
  );

  // Server could not reach upstream: resolve the video URL in the browser.
  if (plan && plan.needsClientResolve) {
    const schedule = await upstreamJson(
      `/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
        subjectSlug
      )}&ContentId=${encodeURIComponent(lectureId)}`
    );
    const d = (schedule && schedule.data) || {};
    const rawUrl = (d.videoDetails && d.videoDetails.videoUrl) || d.url || "";
    if (!rawUrl) {
      return { playable: false, reason: "This class has no released video yet, or the streaming pipeline for it is not ready yet." };
    }
    plan = await api(`/api/stream?url=${encodeURIComponent(rawUrl)}`);
  }
  return plan;
}

/**
 * How many times this page has healed itself without saying so.
 *
 * The first few seconds of a lecture load are the worst place to show an error:
 * a rate-limited signer or an expired signature fixes itself in one or two
 * seconds, and the student is still watching a spinner. Up to this many silent
 * attempts are made before anything is drawn, and the visible Retry buttons
 * remain the last resort rather than the first.
 */
let silent = 0;
const SILENT_ATTEMPTS = 3;

/** Short, widening pause between silent attempts. */
const pause = (n) => new Promise((r) => setTimeout(r, Math.min(4000, 700 * n)));

async function startStream() {
  showLoading("Preparing your lecture…", "Fetching stream details from Physics Wallah.");

  // One retry helper for every "try again" in this file. It bumps the attempt
  // (so the resolver bypasses its cache) and re-enters the bootstrap, which is
  // what these buttons always claimed to do and, on the first one, never did.
  const retry = (btnId) =>
    $(btnId)?.addEventListener("click", () => {
      attempt += 1;
      hideOverlay();
      startStream();
    });

  let plan = null;
  try {
    plan = await resolvePlan(attempt);
  } catch (err) {
    // Heal first, ask questions later.
    if (silent < SILENT_ATTEMPTS) {
      silent += 1;
      attempt += 1;
      showLoading("Connecting…", "Getting a fresh link for this lecture.");
      await pause(silent);
      return startStream();
    }
    showMessage(
      "Stream unavailable",
      err.message || "The stream service did not respond.",
      true,
      `<button class="btn btn-primary" id="retryStreamBtn">Try again</button>`
    );
    retry("retryStreamBtn");
    return;
  }

  // Upstream signing is intermittently rate-limited; a short retry is cheaper
  // than showing the student an error they cannot act on.
  if (plan && !plan.playable && plan.retryAfter && silent < SILENT_ATTEMPTS) {
    silent += 1;
    attempt += 1;
    showLoading("Reconnecting…", "The stream service is catching up. Trying again.");
    await new Promise((r) => setTimeout(r, plan.retryAfter * 1000));
    return startStream();
  }

  if (!plan || !plan.playable || !plan.url) {
    if (plan && plan.external) {
      // The upstream declined to sign this video. Say so and offer Retry; the
      // site does not hand the reader off to a third-party host.
      showMessage(
        "This video is not available right now",
        plan.reason || "The source did not sign this lecture. Retry in a moment.",
        true,
        `<button class="btn btn-primary" id="retryExtBtn">Retry</button>
         <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>`
      );
      retry("retryExtBtn");
      return;
    }
    if (silent < SILENT_ATTEMPTS) {
      silent += 1;
      attempt += 1;
      showLoading("Connecting…", "Getting a fresh link for this lecture.");
      await pause(silent);
      return startStream();
    }
    const reason =
      (plan && plan.reason) || "PW has not published a playable stream for this lecture yet.";
    showMessage(
      "This class has no video yet",
      reason,
      false,
      `<a class="btn btn-primary" href="${checkUrl()}" target="_blank" rel="noopener">Run playback check</a>
       <button class="btn btn-ghost" id="retryBtn">Retry</button>`
    );
    retry("retryBtn");
    return;
  }

  currentPlan = plan;
  silent = 0;
  attachPlayer(plan);
}

/* -------------------------------- player --------------------------------- */

function createPlayer() {
  if (pro) return pro;
  pro = new ProPlayer({
    video,
    root,
    resolve: resolvePlan,
    prefs: { get: getPrefs, set: setPref },
    onState: renderState,
    onError: (title, text) => {
      showMessage(
        title,
        text,
        true,
        `<button class="btn btn-primary" id="retryStreamBtn2">Retry stream</button>
         <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>`
      );
      $("retryStreamBtn2")?.addEventListener("click", () => {
        hideOverlay();
        pro.retry({ reason: "manual" });
      });
    },
    onEnded: () => {
      // Auto-advance: a two-hour lecture that ends should offer the next class,
      // not a frozen last frame.
      if (queue.index >= 0 && queue.index < queue.ids.length - 1) {
        toast("Lecture finished — opening the next one");
        setTimeout(() => goToLecture(1), 1800);
      } else {
        toast("Lecture finished");
      }
    },
  });
  window.__player = pro;
  return pro;
}

function attachPlayer(plan) {
  const player = createPlayer();
  player.attempt = attempt;

  if (plan.engine === "embed" || plan.kind === "youtube" || plan.kind === "vimeo") {
    if (embed) {
      embed.style.display = "";
      embed.src = plan.embed || "";
      video.style.display = "none";
    }
    hideOverlay();
    return;
  }

  if (embed && embed.style.display !== "none") {
    embed.src = "about:blank";
    embed.style.display = "none";
    video.style.display = "";
  }

  showLoading("Stream ready", "Starting playback…");

  // Show the picker from the plan immediately: the control should not sit empty
  // (or hidden) while the manifest is still being parsed.
  paintQuality((plan.renditions || []).map((h) => ({ height: Number(h) })), "auto");

  const saved = Number(localStorage.getItem(positionKey) || 0);

  player
    .load(plan, { autoplay: true })
    .then(() => {
      const resumeAt = () => {
        if (saved > 12) {
          player.seek(saved);
          chip(`From ${fmtTime(saved)} · start over`, () => {
            player.seek(0);
            localStorage.removeItem(positionKey);
            hideChip();
            player.play();
          });
        }
        video.removeEventListener("loadedmetadata", resumeAt);
      };
      if (video.readyState >= 1) resumeAt();
      else video.addEventListener("loadedmetadata", resumeAt);
      hideOverlay();
    })
    .catch((err) => {
      showMessage(
        "Playback not supported",
        err.message || "This browser could not start the player.",
        true,
        `<button class="btn btn-primary" id="retryStreamBtn3">Retry</button>`
      );
      $("retryStreamBtn3")?.addEventListener("click", () => {
        hideOverlay();
        player.retry({ reason: "manual" });
      });
    });
}

/* -------------------------------- rendering ------------------------------- */

function renderState(s) {
  const overlayOn = overlay && overlay.style.display !== "none";
  // transport buttons
  if (playBtn) {
    const playing = !s.paused && !s.ended;
    playBtn.querySelector(".i-play").style.display = playing ? "none" : "";
    playBtn.querySelector(".i-pause").style.display = playing ? "" : "none";
    playBtn.title = playing ? "Pause (k)" : "Play (k)";
  }

  // buffering veil: never under the loading/error overlay, which already says
  // more than "Buffering…" at that point.
  if (veil) {
    const show = Boolean(s.buffering) && !s.error && !overlayOn;
    veil.classList.toggle("on", show);
    if (show && s.note) veilText.textContent = s.note;
  }

  // stopped / paused pane — the "stopped and it will not play again" fix
  if (stoppedPane) {
    // Never cover a video that is actually playing: `stopped`/`error` describe
    // the last failure, and a stale one must not sit on top of a live stream.
    const running = !video.paused && !video.ended;
    const dim = Boolean(s.stopped || s.error);
    const showStopped = Boolean((dim || s.paused) && !running && !overlayOn);
    stoppedPane.hidden = !showStopped;
    // A plain pause shows only the glyph; a stop or an error dims and explains.
    stoppedPane.classList.toggle("paused", !dim);
    if (showStopped) {
      stoppedTitle.textContent = s.error ? s.errorTitle || "Playback error" : "Paused";
      stoppedPane.querySelector(".tiny").textContent = s.error
        ? s.error
        : `Paused at ${fmtTime(video.currentTime || 0)} — press play to continue`;
    }
  }

  // progress + time
  paintProgress();
  paintTime(s);

  // volume
  paintVolume(s);

  // quality list
  if (s.qualityLevels) paintQuality(s.qualityLevels, s.quality);

  // status chip: buffering / reconnecting / reconnected
  if (healthChip) {
    const text = s.error ? "" : s.note || (s.buffering ? "Buffering…" : "");
    if (text) {
      healthChip.textContent = text;
      healthChip.style.display = "";
    } else if (!chipHeld) {
      healthChip.style.display = "none";
    }
  }

  // the right column's transport
  paintNow(s);

  // stats
  paintStats(s);
}

function paintTime(s) {
  const cur = Number.isFinite(s.currentTime) ? s.currentTime : video.currentTime || 0;
  const dur = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : video.duration || 0;
  if (positionLabel) {
    positionLabel.textContent = durations.elapsed
      ? `${fmtTime(cur)} / ${fmtTime(dur)}`
      : `-${fmtTime(Math.max(0, dur - cur))} / ${fmtTime(dur)}`;
  }
}

function paintVolume(s) {
  if (!muteBtn) return;
  const muted = s ? Boolean(s.muted) : video.muted;
  const wave = $("volWave");
  const cross = $("volMute");
  if (wave) wave.style.display = muted ? "none" : "";
  if (cross) cross.style.display = muted ? "" : "none";
  muteBtn.title = muted ? "Unmute (m)" : "Mute (m)";
  if (volumeSlider && document.activeElement !== volumeSlider) {
    volumeSlider.value = String(muted ? 0 : video.volume);
  }
  const readout = $("volumeReadout");
  if (readout) readout.textContent = muted ? "0" : String(Math.round(video.volume * 100));
}

function paintQuality(levels, current) {
  if (!qualitySelect) return;
  const heights = [...new Set((levels || []).map((l) => l.height).filter(Boolean))].sort(
    (a, b) => b - a
  );
  if (!heights.length) {
    qualitySelect.innerHTML = `<option value="-1">Auto</option>`;
    qualitySelect.dataset.empty = "1";
    return;
  }
  qualitySelect.dataset.empty = "";
  const selected = current === "auto" || current === undefined ? -1 : Number(current);
  qualitySelect.innerHTML =
    `<option value="-1">Auto</option>` +
    heights.map((h) => `<option value="${h}"${selected === h ? " selected" : ""}>${h}p</option>`).join("");
}

/** Buffered band + watched fill, from the range that contains the playhead. */
function paintProgress() {
  const dur = Number(video.duration);
  if (!Number.isFinite(dur) || dur <= 0) {
    if (playedBar) playedBar.style.width = "0%";
    if (bufferedBar) bufferedBar.style.width = "0%";
    return;
  }
  const pct = (t) => Math.min(100, Math.max(0, (t / dur) * 100));
  if (playedBar) playedBar.style.width = `${pct(video.currentTime)}%`;
  paintResumeMark();
  if (scrubberKnob) scrubberKnob.style.left = `${pct(video.currentTime)}%`;

  if (bufferedBar && video.buffered && video.buffered.length) {
    let end = 0;
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
        end = video.buffered.end(i);
        break;
      }
      end = Math.max(end, video.buffered.end(i));
    }
    bufferedBar.style.width = `${pct(end)}%`;
    if (veilBuffer) veilBuffer.style.width = `${pct(end)}%`;
  }
  if (scrubber) scrubber.setAttribute("aria-valuenow", String(Math.round(pct(video.currentTime))));
}

function paintStats(s) {
  if (!statsVisible) return;
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  set("statEngine", s.engine || pro?.engine || "—");
  set("statQuality", s.quality === "auto" ? "Auto" : s.quality ? `${s.quality}p` : "—");
  const ahead = bufferAhead();
  set("statBuffer", `${ahead.toFixed(1)}s`);
  set(
    "statBitrate",
    pro && pro.hls && pro.hls.currentLevel >= 0
      ? `${Math.round(((pro.hls.levels[pro.hls.currentLevel] || {}).bitrate || 0) / 1000)} kbps`
      : "—"
  );
  set("statStalls", String(pro ? pro.recovery : 0));
  set("statRetries", String(pro ? pro.attempt : 0));
}

function bufferAhead() {
  if (!video || !video.buffered || !video.buffered.length) return 0;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
      return Math.max(0, video.buffered.end(i) - video.currentTime);
    }
  }
  return 0;
}

/* ------------------------------ status chip ------------------------------- */

let chipHeld = false;
function chip(text, onClick) {
  if (!healthChip) return;
  healthChip.textContent = text;
  healthChip.style.display = "";
  healthChip.classList.add("chip-action");
  chipHeld = true;
  if (onClick) healthChip.onclick = onClick;
}
function hideChip() {
  if (!healthChip) return;
  healthChip.style.display = "none";
  healthChip.classList.remove("chip-action");
  healthChip.onclick = null;
  chipHeld = false;
}

/* -------------------------------- scrubbing ------------------------------- */

/** The rail, not the padded scrubber box: a click at the very edge must mean
 *  0 s or the end, not 2% off. */
function ratioFromPointer(clientX) {
  const rect = (scrubberTrack || scrubber).getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function seekFromPointer(clientX) {
  const ratio = ratioFromPointer(clientX);
  const dur = Number(video.duration);
  if (!Number.isFinite(dur) || dur <= 0) return;
  video.currentTime = ratio * dur;
  if (scrubberTip) {
    scrubberTip.textContent = fmtTime(ratio * dur);
    scrubberTip.style.left = `${ratio * 100}%`;
    scrubberTip.classList.add("on");
  }
}

let scrubbing = false;
if (scrubber) {
  scrubber.addEventListener("pointerdown", (e) => {
    scrubbing = true;
    scrubber.setPointerCapture?.(e.pointerId);
    seekFromPointer(e.clientX);
  });
  scrubber.addEventListener("pointermove", (e) => {
    if (!scrubbing) {
      // Hover preview, measured off the same rail the seek uses so the number
      // under the cursor is the number a click would land on.
      const dur = Number(video.duration) || 0;
      if (scrubberTip && dur > 0) {
        const ratio = ratioFromPointer(e.clientX);
        scrubberTip.textContent = fmtTime(ratio * dur);
        scrubberTip.style.left = `${ratio * 100}%`;
        scrubberTip.classList.add("on");
      }
      return;
    }
    seekFromPointer(e.clientX);
  });
  const end = () => {
    scrubbing = false;
    if (scrubberTip) scrubberTip.classList.remove("on");
  };
  scrubber.addEventListener("pointerup", end);
  scrubber.addEventListener("pointercancel", end);
  scrubber.addEventListener("pointerleave", () => {
    if (!scrubbing && scrubberTip) scrubberTip.classList.remove("on");
  });
  scrubber.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") seekBy(10);
    if (e.key === "ArrowLeft") seekBy(-10);
  });
}

/**
 * Now playing: the right column's own transport.
 *
 * It reads the same player state the tray does, so the two cannot disagree,
 * and it exists because on a wide screen the notes column is where the eye
 * lands first — it should say what is on and offer play before it offers PDFs.
 */
function paintNow(s = {}) {
  const cur = Number.isFinite(s.currentTime) ? s.currentTime : video.currentTime || 0;
  const dur = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : video.duration || 0;

  if (nowTitle && nowTitle.dataset.static !== "1") {
    nowTitle.textContent = (titleEl.textContent || "Lecture").trim();
  }
  if (nowProgress) {
    nowProgress.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
  }
  if (nowPosition) nowPosition.textContent = fmtTime(cur);
  if (nowDuration) nowDuration.textContent = fmtTime(dur);

  if (nowPlay) {
    const playing = !video.paused && !video.ended;
    nowPlay.textContent = playing ? "Pause" : "Play";
    nowPlay.disabled = !pro;
  }

  if (nowState) {
    const state = video.ended
      ? "finished"
      : s.buffering
        ? "buffering"
        : video.paused
          ? "paused"
          : "playing";
    nowState.textContent = state;
    nowState.className = `pill now-state now-state-${state}`;
  }
}

nowPlay?.addEventListener("click", () => {
  if (!pro) return;
  hideOverlay();
  pro.toggle();
});
nowBack?.addEventListener("click", () => seekBy(-10));
nowFwd?.addEventListener("click", () => seekBy(10));

/* ------------------------------ transport UI ------------------------------ */

/**
 * Where you left off, drawn on the rail.
 *
 * A two-hour lecture has no chapters in the stream, and inventing evenly
 * spaced ticks would be a lie about the content. What the player does know
 * exactly is the position it saved last time, so that is what the rail shows:
 * one hairline marker, which disappears once you have played past it.
 */
function paintResumeMark() {
  const track = scrubberTrack;
  if (!track) return;
  const dur = Number(video.duration);
  const saved = Number(localStorage.getItem(positionKey) || 0);
  const existing = track.querySelector(".scrubber-resume");
  if (!Number.isFinite(dur) || dur <= 0 || !saved || saved < 12 || saved >= dur - 5) {
    existing?.remove();
    return;
  }
  const mark = existing || document.createElement("i");
  mark.className = "scrubber-resume";
  mark.style.left = `${(saved / dur) * 100}%`;
  mark.title = `Last watched · ${fmtTime(saved)}`;
  mark.dataset.at = String(saved);
  if (!existing) track.appendChild(mark);
  // Once the marker is behind the playhead it has done its job.
  mark.hidden = video.currentTime > saved + 2;
}

function seekBy(delta) {
  const player = pro;
  if (!player) return;
  player.seekBy(delta);
  flash(`${delta > 0 ? "+" : "−"}${Math.abs(delta)}s`, delta > 0 ? "fwd" : "back");
}

function flash(text, dir = "") {
  if (!gestureFlash) return;
  gestureFlash.textContent = text;
  gestureFlash.dataset.dir = dir;
  gestureFlash.classList.remove("on");
  void gestureFlash.offsetWidth;
  gestureFlash.classList.add("on");
}

playBtn?.addEventListener("click", () => {
  if (!pro) return;
  if (pro._state && pro._state.error) return pro.retry({ reason: "manual" });
  pro.toggle();
  hideChip();
});

bigPlayBtn?.addEventListener("click", () => {
  if (!pro) return;
  hideOverlay();
  if (pro._state && pro._state.error) return pro.retry({ reason: "manual" });
  if (!pro._hasSource()) return pro.restart();
  pro.play();
});

restartBtn?.addEventListener("click", () => {
  pro?.seek(0);
  pro?.play();
});

skipBackBtn?.addEventListener("click", () => seekBy(-10));
skipFwdBtn?.addEventListener("click", () => seekBy(10));
prevBtn?.addEventListener("click", () => goToLecture(-1));
nextBtn?.addEventListener("click", () => goToLecture(1));

// Click the picture to play/pause, double-click to fullscreen. Deliberately not
// on the scrubbing rail or the bar, where a click means something else.
let clickTimer = null;
/**
 * The picture is a transport too.
 *
 * Left third = back 10 s, right third = forward 10 s, middle = play/pause, and
 * a double tap anywhere is fullscreen. The zone is decided from the pointer's
 * position inside the stage, and the feedback is drawn *at the tap*, so the
 * tap reads as one gesture instead of a button press somewhere else.
 */
function stageZone(clientX) {
  const rect = stage?.getBoundingClientRect();
  if (!rect || !rect.width) return "mid";
  const x = (clientX - rect.left) / rect.width;
  if (x < 0.3) return "back";
  if (x > 0.7) return "fwd";
  return "mid";
}

/** A short ring at the tap point, on the film, not over the controls. */
function ripple(clientX, clientY, dir) {
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const ring = document.createElement("span");
  ring.className = `tap-ripple tap-ripple-${dir}`;
  ring.style.left = `${Math.round(clientX - rect.left)}px`;
  ring.style.top = `${Math.round(clientY - rect.top)}px`;
  // Two quick taps should show two rings, so these clean themselves up.
  ring.addEventListener("animationend", () => ring.remove());
  setTimeout(() => ring.remove(), 900);
  stage.appendChild(ring);
}

surface?.addEventListener("click", (e) => {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    toggleFullscreen();
    return;
  }
  const zone = stageZone(e.clientX);
  const dir = zone === "mid" ? "mid" : zone;
  clickTimer = setTimeout(() => {
    clickTimer = null;
    if (!pro) return;
    hideOverlay();
    if (zone === "back") return seekBy(-10), ripple(e.clientX, e.clientY, "back");
    if (zone === "fwd") return seekBy(10), ripple(e.clientX, e.clientY, "fwd");
    pro.toggle();
    ripple(e.clientX, e.clientY, "mid");
  }, 220);
});

positionLabel?.addEventListener("click", () => {
  durations.elapsed = !durations.elapsed;
  paintTime({ currentTime: video.currentTime, duration: video.duration });
});

muteBtn?.addEventListener("click", () => pro?.toggleMute());
volumeSlider?.addEventListener("input", () => pro?.setVolume(volumeSlider.value));

/**
 * Speed: one control, three affordances.
 *
 * − and + step the rate through the same list the popover offers, the middle
 * reads the current rate and resets it to 1× when tapped, and `c` still cycles
 * for keyboard users. Stepping is clamped, not wrapped: holding "faster" at 2×
 * should sit still rather than snap back to 0.75×.
 */
function stepSpeed(delta) {
  const current = Number(video.playbackRate) || 1;
  const i = SPEEDS.indexOf(current);
  const from = i >= 0 ? i : 1;
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, from + delta))];
  if (next == null) return;
  pro?.setRate(next);
  markSpeed(next);
  markSpeedStep(next);
  flash(`${next}×`);
}

function markSpeedStep(rate) {
  if (!speedRateText) return;
  speedRateText.textContent = `${Number(rate)}×`;
  speedRate?.classList.toggle("off-standard", Number(rate) !== 1);
}

speedDown?.addEventListener("click", () => stepSpeed(-1));
speedUp?.addEventListener("click", () => stepSpeed(1));
speedRate?.addEventListener("click", () => {
  pro?.setRate(1);
  markSpeed(1);
  markSpeedStep(1);
  flash("1×");
});

function markSpeed(rate) {
  markSpeedStep(rate);
  for (const group of [menuSpeed]) {
    group?.querySelectorAll("button[data-speed]").forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.speed) === Number(rate));
    });
  }
}

qualitySelect?.addEventListener("change", () => {
  const value = qualitySelect.value;
  pro?.setQuality(value === "-1" ? "auto" : Number(value));
  toast(value === "-1" ? "Quality: Auto" : `Quality locked to ${value}p`);
});


/**
 * Playback settings popover.
 *
 * Speed and quality used to sit permanently in the bar, which made the bar a
 * wall of controls. They live here now; the bar keeps the transport that gets
 * used mid-lecture (play, skip, volume, fullscreen).
 */
function setMenu(open) {
  if (!playerMenu) return;
  playerMenu.hidden = !open;
  settingsBtn?.setAttribute("aria-expanded", open ? "true" : "false");
  settingsBtn?.classList.toggle("active", open);
  if (open) {
    // Reflect the live values every time it opens; the state may have changed
    // through a keyboard shortcut while it was closed.
    if (video) {
      menuSpeed?.querySelectorAll("button[data-speed]").forEach((b) => {
        b.classList.toggle("active", Number(b.dataset.speed) === Number(video.playbackRate));
      });
    }
  }
}

settingsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(playerMenu ? playerMenu.hidden : false);
});

playerMenu?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => setMenu(false));

menuSpeed?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-speed]");
  if (!btn) return;
  pro?.setRate(btn.dataset.speed);
  markSpeed(Number(btn.dataset.speed));
});

/** ±N seconds, from the popover's skip row. */
playerMenu?.addEventListener("click", (e) => {
  const fwd = e.target.closest("button[data-forward]");
  const back = e.target.closest("button[data-back]");
  if (fwd) seekBy(Number(fwd.dataset.forward));
  if (back) seekBy(-Number(back.dataset.back));
});

$("menuStats")?.addEventListener("click", () => {
  setMenu(false);
  toggleStats();
});

/**
 * "Save for offline" from the player.
 *
 * The downloads page is the place to *browse* a batch, but the moment someone
 * decides to keep a lecture is while watching it — sending them to another page
 * to re-find the same class would be the whole feature failing at its easiest
 * step. The plan is already resolved here, so the folder, quality and title all
 * come from what is on screen.
 */
$("menuSave")?.addEventListener("click", async () => {
  setMenu(false);
  if (!currentPlan || !currentPlan.playable) {
    toast("This lecture has no stream to save yet", "bad");
    return;
  }
  const folder = folderOf(currentPlan.url);
  if (!folder) {
    toast("This lecture cannot be saved for offline playback", "bad");
    return;
  }
  const label = $("menuSave");
  const title = (currentPlan.title || titleParam || nowTitle?.textContent || "Lecture").trim();
  label.textContent = "Preparing…";
  try {
    const info = await api(
      `/api/download?mode=list&folder=${encodeURIComponent(folder)}&quality=${encodeURIComponent(
        (currentPlan.renditions && currentPlan.renditions[0]) || currentPlan.quality || "720"
      )}`
    );
    if (!info.playable) {
      toast(info.error || "This lecture cannot be downloaded right now", "bad");
      label.textContent = "Save for offline";
      return;
    }
    const { downloadLecture } = await import("./downloader.js");
    toast(`Saving “${title}” — ${info.segments} parts. Keep this page open.`);
    label.textContent = "Saving…";
    const result = await downloadLecture({
      id: lectureId,
      folder,
      quality: info.quality,
      title,
      format: info.encrypted ? "plain" : "playlist",
      onProgress: (p) => {
        const pct = p.total ? Math.round((p.segments / p.total) * 100) : 0;
        label.textContent = `Saving ${pct}%`;
      },
    });
    label.textContent = result.ok ? "Saved for offline" : "Save for offline";
    toast(
      result.ok
        ? `“${title}” is saved — open it any time from Downloads`
        : "Saved part of this lecture — finish it on the Downloads page",
      result.ok ? "" : "bad"
    );
    // Offer the offline copy right where it was made. Sending someone to another
    // page to watch something they just saved reads as "it left the site"; this
    // shows it playing from the device instead.
    if (result.ok) {
      showSavedAction(title);
      setTimeout(() => (label.textContent = "Save for offline"), 4000);
    }
  } catch (err) {
    label.textContent = "Save for offline";
    toast(err.message || "The download failed", "bad");
  }
});


/**
 * Download this video, straight from the player.
 *
 * The player is where the decision is actually made, so the download lives there
 * too — and it is behind the same key gate as the downloads page, because a
 * button that skipped the gate would be the gate's first hole. The menu offers to
 * generate the key inline, then saves the lecture it is already showing.
 */
$("menuDownload")?.addEventListener("click", async () => {
  setMenu(false);
  if (!currentPlan || !currentPlan.playable) {
    toast("This lecture has no stream to download yet", "bad");
    return;
  }
  const folder = folderOf(currentPlan.url);
  if (!folder) {
    toast("This lecture cannot be downloaded", "bad");
    return;
  }

  const button = $("menuDownload");
  const title = (currentPlan.title || titleParam || nowTitle?.textContent || "Lecture").trim();
  const restore = () => {
    if (button) button.textContent = "⬇ Download this video";
  };

  try {
    if (button) button.textContent = "Preparing download…";
    const info = await api(
      `/api/download?mode=list&folder=${encodeURIComponent(folder)}&quality=${encodeURIComponent(
        (currentPlan.renditions && currentPlan.renditions[0]) || currentPlan.quality || "720"
      )}`
    );
    if (!info.playable) {
      toast(info.error || "This lecture cannot be downloaded right now", "bad");
      restore();
      return;
    }
    const { downloadLecture } = await import("./downloader.js");
    const result = await downloadLecture({
      id: lectureId,
      folder,
      quality: info.quality,
      title,
      format: info.encrypted ? "plain" : "playlist",
      onProgress: (p) => {
        const pct = p.total ? Math.round((p.segments / p.total) * 100) : 0;
        if (button) button.textContent = `Downloading ${pct}%`;
      },
    });
    restore();
    if (result.ok) {
      toast(
        result.skipped
          ? `“${title}” downloaded — ${result.skipped} moment${result.skipped === 1 ? "" : "s"} could not be fetched`
          : `“${title}” downloaded — play it offline any time`,
        ""
      );
      showSavedAction(title);
    } else {
      toast("Downloaded part of this lecture — finish it on the Downloads page", "bad");
    }
  } catch (err) {
    restore();
    toast(err.message || "The download failed", "bad");
  }
});

/** A one-line offer to watch the copy that was just saved, next to the video. */
function showSavedAction(title) {
  const host = document.getElementById("offlineOffer");
  if (!host) return;
  host.hidden = false;
  host.innerHTML =
    `<span class="tiny">Saved on this device.</span>` +
    `<button class="btn btn-primary btn-sm" id="offlinePlay">Play offline copy</button>` +
    `<a class="btn btn-ghost btn-sm" href="/downloads.html">Downloads</a>`;
  document.getElementById("offlinePlay")?.addEventListener("click", async () => {
    const { playSaved } = await import("./offline-player.js");
    const ok = await playSaved(lectureId, { trigger: document.getElementById("offlinePlay") });
    if (!ok) toast("That lecture could not be opened from this device", "bad");
  });
}

loopBtn?.addEventListener("click", () => {
  video.loop = !video.loop;
  loopBtn.classList.toggle("active", video.loop);
  toast(video.loop ? "Looping this lecture" : "Loop off");
});

/** Toggle the stream inspector. Reachable from the popover and the `i` key. */
function toggleStats(force) {
  statsVisible = typeof force === "boolean" ? force : !statsVisible;
  if (statsPane) statsPane.hidden = !statsVisible;
  statsBtn?.classList.toggle("active", statsVisible);
  settingsBtn?.classList.toggle("stats-on", statsVisible);
  setStatsTimer();
}

statsBtn?.addEventListener("click", () => toggleStats());

/**
 * Refresh the stats panel while it is open.
 *
 * Deliberately a *conditional* timer: an unconditional 1 s interval keeps the
 * page (and any headless run of this module) doing work forever, and a stats
 * readout is the only thing that needs a clock.
 */
let statsTimer = null;
function setStatsTimer() {
  clearInterval(statsTimer);
  statsTimer = null;
  if (statsVisible) {
    paintStats(pro ? pro._state || {} : {});
    statsTimer = setInterval(() => paintStats(pro ? pro._state || {} : {}), 1000);
  }
}

$("shortcutsBtn")?.addEventListener("click", () => {
  const sheet = $("shortcutSheet");
  if (sheet) sheet.hidden = false;
});
$("sheetClose")?.addEventListener("click", () => {
  const sheet = $("shortcutSheet");
  if (sheet) sheet.hidden = true;
});
$("shortcutSheet")?.addEventListener("click", (e) => {
  if (e.target.id === "shortcutSheet") e.target.hidden = true;
});

// Only offer picture-in-picture where the browser implements it.
if (pipBtn && document.pictureInPictureEnabled && video.requestPictureInPicture) {
  pipBtn.style.display = "";
  pipBtn.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      toast("Picture in picture is unavailable for this video");
    }
  });
}

async function toggleFullscreen() {
  const target = stage || video;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (target.requestFullscreen) await target.requestFullscreen();
    else throw new Error("no api");
  } catch {
    if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else toast("Fullscreen is not available here");
  }
}
fullscreenBtn?.addEventListener("click", toggleFullscreen);

/**
 * Fullscreen: get out of the way.
 *
 * A lecture is watched, not stared at. When the player is fullscreen and the
 * pointer has been still for 2.6 s, the transport fades out; any movement,
 * tap, key or pause brings it back. Nothing is removed from the DOM, so
 * keyboard users keep every control, and the state is driven by one class.
 */
let idleTimer = null;

function wakeControls() {
  if (!root) return;
  root.classList.remove("controls-idle");
  root.classList.add("controls-awake");
  clearTimeout(idleTimer);
  if (!document.fullscreenElement) return;
  idleTimer = setTimeout(() => {
    // Never hide the bar while paused, buffering, or mid-settings: the user
    // is looking at it for a reason.
    const busy =
      video.paused ||
      !video.readyState ||
      (playerMenu && !playerMenu.hidden) ||
      document.activeElement?.closest?.(".player-bar, .player-menu");
    if (busy) return;
    root.classList.add("controls-idle");
  }, 2600);
}

for (const evt of ["pointermove", "pointerdown", "focusin", "keydown"]) {
  root?.addEventListener(evt, wakeControls, { passive: true });
}
document.addEventListener("fullscreenchange", () => {
  wakeControls();
  if (!document.fullscreenElement) {
    clearTimeout(idleTimer);
    root?.classList.remove("controls-idle");
  }
});
video?.addEventListener("pause", wakeControls);

/* ------------------------------- keyboard -------------------------------- */

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
  if (video.style.display === "none") return; // an embed owns the screen
  if (!pro) return;

  const key = e.key;
  const lower = typeof key === "string" ? key.toLowerCase() : "";

  // digits jump to a fraction of the lecture, as on every pro player
  if (/^[0-9]$/.test(key)) {
    const dur = Number(video.duration);
    if (Number.isFinite(dur) && dur > 0) {
      const ratio = Number(key) / 10;
      pro.seek(ratio * dur);
      flash(`${key}0%`);
      e.preventDefault();
    }
    return;
  }

  const actions = {
    " ": () => pro.toggle(),
    k: () => pro.toggle(),
    s: () => {
      pro.stop();
      hideChip();
      hideOverlay();
      flash("Stopped");
    },
    ArrowRight: () => seekBy(10),
    ArrowLeft: () => seekBy(-10),
    l: () => seekBy(10),
    j: () => seekBy(-10),
    ArrowUp: () => {
      pro.setVolume(Math.min(1, video.volume + 0.1));
      flash(`Volume ${Math.round(video.volume * 100)}%`);
    },
    ArrowDown: () => {
      pro.setVolume(Math.max(0, video.volume - 0.1));
      flash(`Volume ${Math.round(video.volume * 100)}%`);
    },
    m: () => {
      pro.toggleMute();
      flash(video.muted ? "Muted" : "Unmuted");
    },
    f: () => toggleFullscreen(),
    o: () => pipBtn && pipBtn.click(),
    c: () => {
      const i = SPEEDS.indexOf(Number(video.playbackRate));
      const next = SPEEDS[(i + 1) % SPEEDS.length] || 1;
      pro.setRate(next);
      markSpeed(next);
      flash(`${next}×`);
    },
    i: () => toggleStats(),
    r: () => {
      pro.seek(0);
      pro.play();
      flash("Restart");
    },
    n: () => goToLecture(1),
    p: () => goToLecture(-1),
  };

  const action = actions[key] || actions[lower];
  if (!action) return;
  // Space is the page's scroll key when nothing is focused; here it is play.
  e.preventDefault();
  action();
});

/* ------------------------------- position -------------------------------- */

function savePositionNow() {
  if (Number.isFinite(video.currentTime) && video.currentTime > 5) {
    localStorage.setItem(positionKey, String(Math.floor(video.currentTime)));
  }
}
window.addEventListener("pagehide", savePositionNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePositionNow();
});
let lastSave = 0;
video.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (now - lastSave > 4000) {
    lastSave = now;
    savePositionNow();
  }
});

/* --------------------------------- queue --------------------------------- */

async function loadQueue(chapter) {
  if (!chapter) return queue;
  try {
    const all = await loadContents(batchId, subjectSlug, chapter, "videos");
    const list = (all && all.items) || [];
    const ids = list.map((l) => l.id).filter(Boolean);
    queue = { ids, index: ids.indexOf(lectureId) };
  } catch {
    queue = { ids: [], index: -1 };
  }
  const hasPrev = queue.index > 0;
  const hasNext = queue.index >= 0 && queue.index < queue.ids.length - 1;
  if (prevBtn) prevBtn.style.display = hasPrev ? "" : "none";
  if (nextBtn) nextBtn.style.display = hasNext ? "" : "none";
  if (queueNav) {
    queueNav.innerHTML =
      queue.index >= 0
        ? `<span class="pill">${queue.index + 1} of ${queue.ids.length}</span>`
        : "";
  }
  return queue;
}

function goToLecture(offset) {
  const target = queue.index + offset;
  if (queue.index < 0 || target < 0 || target >= queue.ids.length) return;
  const url = new URL(window.location.href);
  url.searchParams.set("id", queue.ids[target]);
  url.searchParams.delete("title");
  window.location.assign(url.toString());
}

/* ------------------------------- bootstrapping --------------------------- */

video.playbackRate = Number(getPrefs().speed || 1);
markSpeed(video.playbackRate);
if (getPrefs().muted === true) video.muted = true;
paintVolume({ muted: video.muted });
video.addEventListener("volumechange", () => paintVolume());
video.addEventListener("timeupdate", () => {
  paintTime(pro?._state || {});
  paintNow(pro?._state || {});
});
for (const evt of ["play", "pause", "ended", "waiting", "playing", "canplay"]) {
  video.addEventListener(evt, () => paintNow(pro?._state || {}));
}
video.addEventListener("progress", paintProgress);
video.addEventListener("seeked", paintProgress);
video.addEventListener("loadedmetadata", paintProgress);

