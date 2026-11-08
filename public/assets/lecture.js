/* Lecture page — resolves the PW stream, drives the pro player, persists progress */

import {
  api,
  mountChrome,
  SITE,
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
import { ProPlayer, fmtTime } from "./player.js";

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
const sourceLink = $("sourceLink");
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
const speedBox = $("speed");
const qualitySelect = $("quality");
const loopBtn = $("loopBtn");
const statsBtn = $("statsBtn");
const settingsBtn = $("settingsBtn");
const playerMenu = $("playerMenu");
const menuSpeed = $("menuSpeed");
const statsPane = $("playerStats");
const healthChip = $("streamHealth");
const healthBadge = $("healthBadge");
const healthText = $("healthText");
const checkLink = $("checkLink");

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
checkLink.href = checkUrl();

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
    docsEl.innerHTML = `<div class="tiny dim">No attachments could be loaded for this lecture.</div>`;
    docCount.textContent = "0";
  }

  // The player may already be running; this only waits for it to finish.
  await stream;
}

function renderDocs(docs) {
  if (!docs.length) {
    docsEl.innerHTML = `<div class="tiny dim">No notes or DPPs attached to this lecture.</div>`;
    docCount.textContent = "0";
    return;
  }
  docCount.textContent = `${docs.length} file${docs.length === 1 ? "" : "s"}`;
  docsEl.innerHTML = docs
    .map(
      (d) => `
      <div class="doc-row">
        <span class="pdf">PDF</span>
        <span class="grow">
          <span class="name">${esc(d.name)}</span>
          <span class="meta">${esc(d.note || d.topic || "Document")}</span>
        </span>
        <a class="btn btn-ghost btn-sm" href="/viewer.html?url=${encodeURIComponent(d.url)}&name=${encodeURIComponent(d.name)}" target="_blank" rel="noopener">Open</a>
      </div>`
    )
    .join("");
}

/** Resolve a plan from the server, honouring the attempt counter. */
async function resolvePlan(n) {
  let plan = await api(
    `/api/stream?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
      subjectSlug
    )}&id=${encodeURIComponent(lectureId)}${n ? `&attempt=${n}` : ""}`
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

async function startStream() {
  showLoading("Preparing your lecture…", "Fetching stream details from Physics Wallah.");

  let plan = null;
  try {
    plan = await resolvePlan(attempt);
  } catch (err) {
    healthBadge.textContent = "offline";
    return showMessage(
      "Stream unavailable",
      err.message || "The stream service did not respond.",
      true,
      `<button class="btn btn-primary" id="retryStreamBtn">Try again</button>
       <a class="btn btn-ghost" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Watch on source</a>`
    );
  }

  // Upstream signing is intermittently rate-limited; a short retry is cheaper
  // than showing the student an error they cannot act on.
  if (plan && !plan.playable && plan.retryAfter && attempt < 2) {
    attempt += 1;
    showLoading("Reconnecting…", "The stream service is catching up. Trying again.");
    await new Promise((r) => setTimeout(r, plan.retryAfter * 1000));
    return startStream();
  }

  if (!plan || !plan.playable || !plan.url) {
    if (plan && plan.external) {
      return showMessage(
        "Watch on the original host",
        plan.reason,
        false,
        `<a class="btn btn-primary" href="${plan.external}" target="_blank" rel="noopener">Open the video</a>
         <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>`
      );
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
    $("retryBtn")?.addEventListener("click", () => {
      attempt += 1;
      startStream();
    });
    runServerHealth();
    return;
  }

  currentPlan = plan;
  attachPlayer(plan);
  runServerHealth();
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
         <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>
         <a class="btn btn-ghost" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Source player</a>`
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
    if (sourceLink && plan.url) sourceLink.href = plan.url;
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
        `<button class="btn btn-primary" id="retryStreamBtn3">Retry</button>
         <a class="btn btn-ghost" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Open source player</a>`
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

function seekFromPointer(clientX) {
  const rect = scrubber.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
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
      // hover preview
      const rect = scrubber.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const dur = Number(video.duration) || 0;
      if (scrubberTip && dur > 0) {
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

/* ------------------------------ transport UI ------------------------------ */

function seekBy(delta) {
  const player = pro;
  if (!player) return;
  player.seekBy(delta);
  flash(`${delta > 0 ? "+" : "−"}${Math.abs(delta)}s`);
}

function flash(text) {
  if (!gestureFlash) return;
  gestureFlash.textContent = text;
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
surface?.addEventListener("click", (e) => {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    toggleFullscreen();
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    if (!pro) return;
    hideOverlay();
    pro.toggle();
  }, 220);
});

positionLabel?.addEventListener("click", () => {
  durations.elapsed = !durations.elapsed;
  paintTime({ currentTime: video.currentTime, duration: video.duration });
});

muteBtn?.addEventListener("click", () => pro?.toggleMute());
volumeSlider?.addEventListener("input", () => pro?.setVolume(volumeSlider.value));

speedBox?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-speed]");
  if (!btn) return;
  pro?.setRate(btn.dataset.speed);
  markSpeed(Number(btn.dataset.speed));
});

function markSpeed(rate) {
  for (const group of [speedBox, menuSpeed]) {
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

/* --------------------------- server-side health -------------------------- */

/**
 * Show the server's own verdict for this lecture.
 *
 * The player can fail for client-only reasons (a blocked CDN, no MSE). Having
 * the server say "this stream plays, here is the rendition" separates a real
 * upstream problem from a local one, in one line, without opening a report.
 */
async function runServerHealth() {
  try {
    const out = await fetch(checkUrl(), { headers: { Accept: "application/json" } }).then((r) =>
      r.json()
    );
    if (out && out.result === "plays") {
      healthBadge.textContent = "playable";
      healthBadge.className = "pill pill-accent";
      healthText.textContent = `Server verified: ${out.quality || "720"}p HLS, AES key and media segments all resolve.`;
    } else if (out && out.success === false) {
      healthBadge.textContent = "check failed";
      healthBadge.className = "pill";
      healthText.textContent = out.explain || out.error || "The self-test could not complete.";
    } else {
      healthBadge.textContent = out.result || "unknown";
      healthBadge.className = "pill";
      healthText.textContent = out.explain || "The self-test returned no verdict.";
    }
  } catch {
    healthBadge.textContent = "unavailable";
    healthBadge.className = "pill";
    healthText.textContent = "The self-test endpoint did not answer.";
  }
}

/* ------------------------------- bootstrapping --------------------------- */

video.playbackRate = Number(getPrefs().speed || 1);
markSpeed(video.playbackRate);
if (getPrefs().muted === true) video.muted = true;
paintVolume({ muted: video.muted });
video.addEventListener("volumechange", () => paintVolume());
video.addEventListener("timeupdate", () => paintTime(pro?._state || {}));
video.addEventListener("progress", paintProgress);
video.addEventListener("seeked", paintProgress);
video.addEventListener("loadedmetadata", paintProgress);

sourceLink.href = SITE.fallbackPlayer;
sourceLink.textContent = "Open in vidcloud";

