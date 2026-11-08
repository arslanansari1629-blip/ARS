/* Lecture page — resolves the PW stream and plays it through our relay */

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
  emptyState,
} from "./app.js";
import { trackLecture } from "./library.js";
import { loadLecture } from "./data.js";
import { upstream as upstreamJson } from "./client-api.js";

mountChrome("batches");

const batchId = qs("batch");
const subjectSlug = qs("subject");
const lectureId = qs("id");
const titleParam = qs("title");

const video = document.getElementById("video");
const embed = document.getElementById("embed");
const playerBar = document.querySelector(".player-bar");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlayTitle");
const overlayText = document.getElementById("overlayText");
const overlayActions = document.getElementById("overlayActions");
const spinner = document.getElementById("spinner");
const titleEl = document.getElementById("lectureTitle");
const metaEl = document.getElementById("lectureMeta");
const docsEl = document.getElementById("docs");
const docCount = document.getElementById("docCount");
const crumbs = document.getElementById("crumbs");
const aboutText = document.getElementById("aboutText");
const positionLabel = document.getElementById("positionLabel");
const sourceLink = document.getElementById("sourceLink");

const positionKey = `pos:${lectureId}`;

/** Automatic retries left for a transient stream failure (rate limiting). */
let retriesLeft = 2;

if (titleParam) {
  titleEl.textContent = titleParam;
  document.title = `${titleParam} — EduVibe PW`;
}
crumbs.innerHTML = `<a href="/">Home</a> <span>/</span>
  <a href="/batch.html?id=${encodeURIComponent(batchId)}">Batch</a> <span>/</span>
  <a href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subjectSlug)}">Subject</a> <span>/</span>
  <span class="truncate">${esc(titleParam || "Lecture")}</span>`;

if (!batchId || !subjectSlug || !lectureId) {
  showMessage("Missing lecture", "Open a lecture from a chapter list.", true);
} else {
  boot();
}

function showMessage(title, text, error = false, actions = "") {
  overlay.style.display = "grid";
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  spinner.style.display = "none";
  overlayActions.innerHTML = actions;
  if (error) overlay.style.background = "radial-gradient(circle at 50% 40%, rgba(255,93,115,.18), rgba(5,6,12,.96))";
}

function showLoading(title, text) {
  overlay.style.display = "grid";
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  spinner.style.display = "block";
  overlayActions.innerHTML = "";
}

/** Can this browser decode an HLS manifest without hls.js? (Safari/iOS can.) */
function canPlayHlsNatively() {
  return Boolean(video.canPlayType && video.canPlayType("application/vnd.apple.mpegurl"));
}

/**
 * hls.js could not be loaded *and* the browser has no native HLS.
 *
 * This is a client-side limitation, not a broken lecture, and saying so matters:
 * the server-side check will happily report the same lecture as playing.
 */
function hlsUnsupported(plan) {
  showMessage(
    "This browser cannot play this video",
    "The video is fine — this browser has no HLS support and the player script could not be loaded (an extension or a network filter may be blocking it). Try Safari, or open the video directly.",
    true,
    `<a class="btn btn-primary" href="${plan && plan.url ? plan.url : checkUrl()}" target="_blank" rel="noopener">Open the video file</a>
     <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>`
  );
}

/** Deep link to the server-side playback self-test for this lecture. */
function checkUrl() {
  return `/api/check?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
    subjectSlug
  )}&id=${encodeURIComponent(lectureId)}`;
}

/* ------------------------------- loaders -------------------------------- */

async function boot() {
  showLoading("Preparing your lecture…", "Fetching stream details from Physics Wallah.");

  let detail = null;
  try {
    detail = await loadLecture(batchId, subjectSlug, lectureId);
  } catch (err) {
    // Lecture metadata is optional — the schedule endpoint may rate-limit.
    detail = null;
  }

  if (detail && detail.lecture) {
    const l = detail.lecture;
    titleEl.textContent = l.title || titleParam || "Lecture";
    document.title = `${l.title} — EduVibe PW`;
    metaEl.textContent = [l.date ? fmtDate(l.date) : "", l.duration, l.topicInfo]
      .filter(Boolean)
      .join(" · ");
    aboutText.textContent = l.description || l.topicInfo || "No description published for this lecture.";
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
  } else {
    metaEl.textContent = "Lecture details are loading from the chapter list.";
    docsEl.innerHTML = `<div class="tiny dim">No attachments could be loaded for this lecture.</div>`;
    docCount.textContent = "0";
  }

  await startStream();
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

async function startStream() {
  let plan = null;
  try {
    plan = await api(
      `/api/stream?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
        subjectSlug
      )}&id=${encodeURIComponent(lectureId)}`
    );

    // Server could not reach upstream: resolve the video URL in the browser.
    if (plan && plan.needsClientResolve) {
      showLoading("Resolving stream…", "Fetching the signed stream link.");
      const schedule = await upstreamJson(
        `/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(
          subjectSlug
        )}&ContentId=${encodeURIComponent(lectureId)}`
      );
      const d = (schedule && schedule.data) || {};
      const rawUrl = (d.videoDetails && d.videoDetails.videoUrl) || d.url || "";
      if (!rawUrl) {
        return showMessage(
          "No video published",
          "This class has no released video yet — open the source player to check again later.",
          false,
          `<a class="btn btn-primary" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Open source player</a>`
        );
      }
      plan = await api(`/api/stream?url=${encodeURIComponent(rawUrl)}`);
    }
  } catch (err) {
    return showMessage(
      "Stream unavailable",
      err.message || "The stream service did not respond.",
      true,
      `<a class="btn btn-primary" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Watch on source</a>`
    );
  }

  // Upstream signing is intermittently rate-limited. A transient failure is
  // worth retrying on its own before showing the user anything.
  if (plan && !plan.playable && plan.retryAfter && retriesLeft > 0) {
    retriesLeft -= 1;
    showLoading("Reconnecting…", "The stream service is catching up. Trying again.");
    await new Promise((r) => setTimeout(r, plan.retryAfter * 1000));
    return startStream();
  }

  if (!plan || !plan.playable || !plan.url) {
    // The lecture may simply live on a host we do not relay. Say that, and give
    // the student the direct link instead of a retry button that cannot help.
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
    const check = checkUrl();
    const notesHint =
      plan && plan.lecture && plan.lecture.hasNotes
        ? " The class notes and DPPs for this lecture are available in the list below."
        : "";
    showMessage(
      "This class has no video yet",
      reason + notesHint,
      false,
      `<a class="btn btn-primary" href="${check}" target="_blank" rel="noopener">Run playback check</a>
       <button class="btn btn-ghost" id="retryBtn">Retry</button>`
    );
    const retry = document.getElementById("retryBtn");
    if (retry) retry.addEventListener("click", () => startStream());
    return;
  }

  attachPlayer(plan);
}

/**
 * Load one script, but never wait forever.
 *
 * A CDN that is blocked by a firewall does not always fire `onerror` — the
 * request simply hangs, and the player would sit on "Starting playback…"
 * indefinitely. Time out and let the next CDN (or the native fallback) try.
 */
function loadOne(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      s.remove();
      finish(reject, new Error(`Timed out loading ${src}`));
    }, timeoutMs);
    s.src = src;
    s.onload = () => finish(resolve);
    s.onerror = () => finish(reject, new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * Load the first CDN that answers — a blocked CDN must not stop playback.
 *
 * There is an overall budget as well as a per-source one: sitting on a spinner
 * for 3 × 8 s while three CDNs hang is indistinguishable from a broken site.
 */
async function loadScript(sources, budgetMs = 9000) {
  const list = Array.isArray(sources) ? sources : [sources];
  const deadline = Date.now() + budgetMs;
  let lastError = null;
  for (const src of list) {
    const remaining = deadline - Date.now();
    if (remaining < 500) break;
    try {
      await loadOne(src, Math.min(6000, remaining));
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Failed to load the player library");
}

/* ------------------------------- playback -------------------------------- */

// Guarded: a stale cached copy of this module must never break the player just
// because the markup predates the quality picker.
const qualitySelect = document.getElementById("quality");

/** Everything needed to retry a stream without re-resolving the lecture. */
let currentPlan = null;
let hls = null;
let dash = null;
/** True when the <video> element owns the source (no hls.js / dash.js). */
let nativeSource = false;

/** Recoverable hls.js failures are almost always a stale or throttled segment. */
const MAX_RECOVERIES = 4;

function resetQuality() {
  if (!qualitySelect) return;
  qualitySelect.innerHTML = `<option value="-1">Auto</option>`;
  qualitySelect.style.display = "none";
}

function showQuality(levels) {
  if (!qualitySelect) return;
  if (!levels.length) return resetQuality();
  qualitySelect.innerHTML = `<option value="-1">Auto</option>${levels
    .map((l) => `<option value="${l.height}">${l.height}p</option>`)
    .join("")}`;
  qualitySelect.style.display = "";
}

/**
 * Play a YouTube/Vimeo-hosted lecture.
 *
 * A handful of batches publish the recording to YouTube rather than to a PW
 * CDN. The quality picker, the speed buttons and the resume position all
 * belong to the <video> element and simply do not apply inside an embed, so
 * they are hidden instead of being shown as dead controls.
 */
function attachEmbed(plan) {
  const src = plan.embed;
  if (!src || !embed) {
    return showMessage(
      "Video could not be embedded",
      "This lecture is hosted on YouTube. Open it on the source player instead.",
      false,
      `<a class="btn btn-primary" href="${plan.url || SITE.fallbackPlayer}" target="_blank" rel="noopener">Watch the lecture</a>`
    );
  }

  destroyPlayers();
  video.style.display = "none";
  embed.style.display = "";
  embed.src = src;
  if (playerBar) playerBar.querySelectorAll(".speed, .quality-select, #streamHealth").forEach((el) => {
    el.style.display = "none";
  });
  showQuality([]);
  overlay.style.display = "none";
  if (sourceLink && plan.url) sourceLink.href = plan.url;
}

async function attachPlayer(plan) {
  currentPlan = plan;

  if (plan.engine === "embed" || plan.kind === "youtube" || plan.kind === "vimeo") {
    attachEmbed(plan);
    return;
  }

  // A previously embedded lecture must give the <video> element back.
  if (embed && embed.style.display !== "none") {
    embed.src = "about:blank";
    embed.style.display = "none";
    video.style.display = "";
    if (playerBar) playerBar.querySelectorAll(".speed, .quality-select, #streamHealth").forEach((el) => {
      el.style.removeProperty("display");
    });
  }

  showLoading("Stream ready", "Starting playback…");

  // Layout metrics arrive one event after the player starts; hide the overlay
  // on the first frame the browser can actually paint.
  const markReady = () => {
    overlay.style.display = "none";
    restorePosition();
  };
  video.addEventListener("loadedmetadata", markReady);
  video.addEventListener("playing", markReady);
  setTimeout(markReady, 9000);

  // Native error handler: only meaningful when the <video> element owns the
  // source. When hls.js/dash.js is attached they report through their own error
  // events, and a spurious <video> error there must not replace the player with
  // a dead overlay.
  video.addEventListener(
    "error",
    () => {
      if (!nativeSource) return;
      // A browser without an HLS decoder fails every manifest it is handed, so
      // "this stream could not be opened" would blame the lecture for a missing
      // capability — while /api/check reports the same lecture as playing.
      if (!canPlayHlsNatively()) return hlsUnsupported(currentPlan);
      showMessage(
        "Playback error",
        "This stream could not be opened. Retry to fetch a fresh link, or run the playback check to see which step failed.",
        true,
        `<button class="btn btn-primary" id="retryStreamBtn">Retry</button>
         <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>
         <a class="btn btn-ghost" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Source player</a>`
      );
      document.getElementById("retryStreamBtn")?.addEventListener("click", () => startStream());
    },
    { once: false }
  );

  try {
    destroyPlayers();

    if (plan.kind === "hls" || plan.engine === "hls") {
      if (video.canPlayType("application/vnd.apple.mpegurl") && !window.Hls) {
        // Safari / iOS plays HLS natively.
        nativeSource = true;
        video.src = plan.url;
        showQuality([]);
      } else {
        // A blocked CDN must not kill the lecture: if hls.js cannot load, hand
        // the manifest to the browser and let it try natively.
        try {
          // Same-origin copy first: a blocked CDN used to leave the player
          // spinning forever on networks that block jsdelivr/unpkg/cdnjs.
          await loadScript([
            "/assets/vendor/hls.min.js",
            "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js",
            "https://unpkg.com/hls.js@1.5.17/dist/hls.min.js",
            "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js",
          ]);
        } catch (err) {
          nativeSource = true;
          video.src = plan.url;
          showQuality([]);
          video.play().catch(() => {});
          return;
        }
        if (!window.Hls || !window.Hls.isSupported()) {
          // Same idea: Firefox without MSE-HLS still deserves a native attempt.
          nativeSource = true;
          video.src = plan.url;
          showQuality([]);
          video.play().catch(() => {});
          return;
        }

        hls = new window.Hls({
          maxBufferLength: 30,
          // A lecture is a 2-hour VOD: start low and switch up instead of
          // stalling for ten seconds on the first segment.
          startLevel: -1,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 4,
          levelLoadingTimeOut: 20000,
          levelLoadingMaxRetry: 4,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetry: 6,
        });

        let recovered = 0;
        hls.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (!data || !data.fatal) return;
          if (recovered >= MAX_RECOVERIES) {
            showMessage(
              "Playback stopped",
              "The stream kept dropping. Retry to reconnect — your position is saved.",
              true,
              `<button class="btn btn-primary" id="retryStreamBtn">Retry</button>
               <a class="btn btn-ghost" href="${checkUrl()}" target="_blank" rel="noopener">Playback check</a>`
            );
            document.getElementById("retryStreamBtn")?.addEventListener("click", () => startStream());
            return;
          }
          // A manifest/level failure means the signed playlist itself is bad
          // (expired or a signer gave up). Retrying the same URL cannot help —
          // resolve a fresh plan, which walks the other signer hosts.
          const details = String(data.details || "");
          if (/manifest|level/i.test(details) && retriesLeft > 0) {
            retriesLeft -= 1;
            destroyPlayers();
            startStream();
            return;
          }

          recovered += 1;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else if (window.Hls.ErrorTypes.KEY_SYSTEM_ERROR) {
            // A fresh token usually fixes key/segment 401s.
            hls.startLoad();
          }
        });

        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          showQuality((hls.levels || []).map((l) => ({ height: l.height || 0 })));
        });
        hls.on(window.Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          if (!hls || !qualitySelect || qualitySelect.value !== "-1") return;
          const level = hls.levels && hls.levels[data.level];
          if (level) qualitySelect.dataset.playing = String(level.height || "");
        });

        hls.loadSource(plan.url);
        hls.attachMedia(video);
        window.__hls = hls;
      }
    } else if (plan.kind === "dash") {
      await loadScript([
        "/assets/vendor/dash.all.min.js",
        "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js",
        "https://unpkg.com/dashjs@4.7.4/dist/dash.all.min.js",
      ]);
      if (!window.dashjs) throw new Error("DASH is not supported here");
      dash = window.dashjs.MediaPlayer().create();
      dash.initialize(video, plan.url, false);
      window.__dash = dash;
      showQuality([]);
    } else {
      nativeSource = true;
      video.src = plan.url;
      showQuality([]);
    }

    // Autoplay may be blocked; a muted retry is better than a black frame.
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
  } catch (err) {
    showMessage(
      "Playback not supported",
      err.message || "This browser could not start the player.",
      true,
      `<button class="btn btn-primary" id="retryStreamBtn">Retry</button>
       <a class="btn btn-ghost" href="${SITE.fallbackPlayer}" target="_blank" rel="noopener">Open source player</a>`
    );
    document.getElementById("retryStreamBtn")?.addEventListener("click", () => startStream());
  }
}

function destroyPlayers() {
  nativeSource = false;
  if (embed) {
    embed.src = "about:blank";
    embed.style.display = "none";
  }
  if (video) video.style.display = "";
  if (hls) {
    try {
      hls.destroy();
    } catch {}
    hls = null;
    window.__hls = null;
  }
  if (dash) {
    try {
      dash.reset();
    } catch {}
    dash = null;
    window.__dash = null;
  }
  resetQuality();
}

qualitySelect?.addEventListener("change", () => {
  const height = Number(qualitySelect.value);
  if (hls && Array.isArray(hls.levels)) {
    // levels are ordered lowest → highest; pick the closest match
    if (height === -1) {
      hls.currentLevel = -1;
      return;
    }
    let best = -1;
    let delta = Infinity;
    hls.levels.forEach((l, i) => {
      const d = Math.abs((l.height || 0) - height);
      if (d < delta) {
        delta = d;
        best = i;
      }
    });
    hls.currentLevel = best;
  } else if (dash && dash.getBitrateInfoListFor) {
    const list = dash.getBitrateInfoListFor("video") || [];
    const target = height === -1 ? -1 : list.findIndex((b) => Math.abs((b.height || 0) - height) < 1);
    dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: height === -1 } } } });
    if (target >= 0) dash.setQualityFor("video", target, true);
  }
});

/* ------------------------------ position/speed --------------------------- */

function restorePosition() {
  const saved = Number(localStorage.getItem(positionKey) || 0);
  if (saved > 12) {
    video.currentTime = saved;
    toast(`Resumed at ${formatTime(saved)}`);
  }
}

function formatTime(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Surface stream trouble while it happens. A lecture that silently stalls looks
 * like a broken site; a "reconnecting" chip plus a saved position does not.
 */
let stalls = 0;
video.addEventListener("waiting", () => {
  stalls += 1;
  if (stalls < 3) return;
  const chip = document.getElementById("streamHealth");
  if (chip) {
    chip.textContent = "Reconnecting…";
    chip.style.display = "";
  }
});
video.addEventListener("playing", () => {
  // A playing video is healthy again: clear the chip and the stall counter.
  stalls = 0;
  const chip = document.getElementById("streamHealth");
  if (chip) chip.style.display = "none";
});

video.addEventListener("timeupdate", () => {
  if (video.currentTime > 5) localStorage.setItem(positionKey, String(Math.floor(video.currentTime)));
  positionLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
});

document.getElementById("restartBtn").addEventListener("click", () => {
  video.currentTime = 0;
  video.play().catch(() => {});
});

document.getElementById("speed").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-speed]");
  if (!btn) return;
  video.playbackRate = Number(btn.dataset.speed);
  document
    .querySelectorAll("#speed button")
    .forEach((b) => b.classList.toggle("active", b === btn));
  setPref("speed", Number(btn.dataset.speed));
});

video.playbackRate = Number(getPrefs().speed || 1);
document.querySelectorAll("#speed button").forEach((b) => {
  b.classList.toggle("active", Number(b.dataset.speed) === video.playbackRate);
});

// "Source player" opens the mirror with the batch pre-selected when supported.
sourceLink.href = SITE.fallbackPlayer;
sourceLink.textContent = "Open in vidcloud";
