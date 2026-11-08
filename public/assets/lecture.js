/* Lecture page — resolves the PW stream and plays it through our relay */

import {
  api,
  mountChrome,
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
          `<a class="btn btn-primary" href="https://pw.eduvibe.cc.cd/" target="_blank" rel="noopener">Open source player</a>`
        );
      }
      plan = await api(`/api/stream?url=${encodeURIComponent(rawUrl)}`);
    }
  } catch (err) {
    return showMessage(
      "Stream unavailable",
      err.message || "The stream service did not respond.",
      true,
      `<a class="btn btn-primary" href="https://pw.eduvibe.cc.cd/" target="_blank" rel="noopener">Watch on source</a>`
    );
  }

  if (!plan || !plan.playable || !plan.url) {
    const reason =
      (plan && plan.reason) || "PW has not published a playable stream for this lecture yet.";
    const check = `/api/check?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
      subjectSlug
    )}&id=${encodeURIComponent(lectureId)}`;
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

function loadOne(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Load the first CDN that answers — a blocked CDN must not stop playback. */
async function loadScript(sources) {
  const list = Array.isArray(sources) ? sources : [sources];
  let lastError = null;
  for (const src of list) {
    try {
      await loadOne(src);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Failed to load the player library");
}

async function attachPlayer(plan) {
  showLoading("Stream ready", "Starting playback…");

  const markReady = () => {
    overlay.style.display = "none";
    restorePosition();
  };

  try {
    if (plan.kind === "hls" || plan.engine === "hls") {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = plan.url;
      } else {
        await loadScript([
          "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js",
          "https://unpkg.com/hls.js@1.5.17/dist/hls.min.js",
          "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js",
        ]);
        if (!window.Hls || !window.Hls.isSupported()) throw new Error("HLS is not supported here");
        const hls = new window.Hls({ maxBufferLength: 30 });
        // a fatal network/media error would otherwise kill playback for good:
        // recover in place, and only fall back to the message after retries
        let recovered = 0;
        hls.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (!data || !data.fatal) return;
          if (recovered >= 2) {
            showMessage(
              "Playback error",
              "The stream link may have expired. Reload the page to fetch a fresh link.",
              true,
              `<button class="btn btn-primary" id="retryStreamBtn">Retry</button>
               <button class="btn btn-ghost" id="reloadBtn">Reload</button>`
            );
            const r = document.getElementById("retryStreamBtn");
            if (r) r.addEventListener("click", () => startStream());
            const l = document.getElementById("reloadBtn");
            if (l) l.addEventListener("click", () => location.reload());
            return;
          }
          recovered += 1;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          }
        });
        hls.loadSource(plan.url);
        hls.attachMedia(video);
        window.__hls = hls;
      }
    } else if (plan.kind === "dash") {
      await loadScript([
        "https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js",
        "https://unpkg.com/dashjs@4.7.4/dist/dash.all.min.js",
      ]);
      if (!window.dashjs) throw new Error("DASH is not supported here");
      const player = window.dashjs.MediaPlayer().create();
      player.initialize(video, plan.url, false);
      window.__dash = player;
    } else {
      video.src = plan.url;
    }

    video.addEventListener("loadeddata", markReady, { once: true });
    video.addEventListener(
      "error",
      () => {
        showMessage(
          "Playback error",
          "The stream link may have expired. Reload the page to fetch a fresh link.",
          true,
          `<button class="btn btn-primary" onclick="location.reload()">Reload</button>
           <a class="btn btn-ghost" href="https://pw.eduvibe.cc.cd/" target="_blank" rel="noopener">Source player</a>`
        );
      },
      { once: true }
    );

    setTimeout(markReady, 9000);
    video.play().catch(() => {});
  } catch (err) {
    showMessage("Playback not supported", err.message, true, `
      <a class="btn btn-primary" href="https://pw.eduvibe.cc.cd/" target="_blank" rel="noopener">Open source player</a>`);
  }
}

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

document.addEventListener("click", (e) => {
  if (e.target.id === "retryBtn") location.reload();
});

sourceLink.href = `https://pw.eduvibe.cc.cd/`;
