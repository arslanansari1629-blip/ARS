/* Next Toppers upgraded player (dedicated watch page).
   Audio truth for this platform, checked live: the VideoCrypt
   non-DRM HLS carries audio MUXED into the TS segments (master
   CODECS="…,mp4a.40.2", no separate EXT-X-MEDIA audio rendition) —
   so "no audio" can only be a mute/autoplay artefact, and the
   player says which: the audio badge tracks muted state, the
   console reports the audio codec + decoded-audio bytes, and IF a
   stream ever ships split audio tracks the Audio menu switches
   them (hls.audioTracks), because our playlist rewrite routes
   EXT-X-MEDIA through the playlist proxy, never the plain relay. */

const $ = (s) => document.querySelector(s);
const q = new URLSearchParams(location.search);
const courseId = q.get("course") || "";
const contentId = q.get("content") || "";
const folderId = q.get("folder") || "0";
const title = q.get("title") || "Lecture";
const POS_KEY = (id) => `arsvibe.nt.pos.${id}`;

const v = $("#ntwVideo");
const shell = $("#ntwShell");
let hls = null;
let dash = null;
let siblings = [];
let recovered = false;

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const note = (t) => ($("#ntwNote").textContent = t);
const spin = (on) => ($("#ntwSpin").style.display = on ? "block" : "none");

$("#ntwTitle").textContent = title;
$("#ntwStageTitle").textContent = title;
document.title = `${title} — Next Toppers · ArsVibe`;
$("#ntwMeta").textContent = q.get("courseTitle") || "Next Toppers";
$("#ntwBack").addEventListener("click", () => {
  location.href = courseId ? `/nexttopper?course=${encodeURIComponent(courseId)}` : "/nexttopper";
});

/* ---------- audio surface ---------- */
function paintAudio() {
  const badge = $("#ntwAudioBadge");
  const muted = v.muted || v.volume === 0;
  badge.textContent = muted ? "🔇 Muted" : "🔊 Audio";
  badge.classList.toggle("muted", muted);
  $("#ntwMute").textContent = muted ? "🔇" : "🔊";
}
function audioReport() {
  // Muxed streams expose the codec on the level; decoded-byte
  // counters prove samples are actually flowing, not just present.
  const level = hls?.levels?.[hls.currentLevel] || hls?.levels?.[0];
  const codec = level?.audioCodec || (dash ? "DASH" : "muxed");
  const decoded = v.webkitAudioDecodedByteCount;
  const tracks = hls?.audioTracks?.length || 0;
  return tracks > 1 ? `${codec} · ${tracks} tracks` : decoded !== undefined ? `${codec} · muxed · ${Math.round(decoded / 1024)} KB decoded` : `${codec} · muxed`;
}

/* ---------- stream loading ---------- */
async function resolve() {
  spin(true);
  note("Stream taiyaar kar rahe hain…");
  const qs = new URLSearchParams({
    view: "play",
    course: courseId,
    content: contentId,
    file: q.get("file") || "",
    vdc: q.get("vdc") || "",
  });
  const d = await fetch(`/api/nexttopper?${qs}`, { headers: { Accept: "application/json" } }).then((r) => r.json()).catch(() => null);
  if (!d?.success) {
    spin(false);
    note(`Yeh lecture abhi play nahi ho raha: ${d?.error || "stream nahi mila"}`);
    return;
  }
  if (d.kind === "youtube") {
    const m = d.url.match(/(?:v=|youtu\.be\/)([\w-]{6,})/);
    v.hidden = true;
    const f = $("#ntwFrame");
    f.src = m ? `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1` : d.url;
    f.hidden = false;
    spin(false);
    note("YouTube lecture");
    return;
  }
  const src = d.proxyUrl || d.url;
  if (d.kind === "dash" && window.dashjs) {
    dash = dashjs.MediaPlayer().create();
    dash.initialize(v, src, true);
    spin(false);
    note("Lecture ready hai (DASH)");
    return;
  }
  if (d.kind === "hls" && window.Hls && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 30, capLevelToPlayerSize: false });
    hls.loadSource(src);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      buildQuality(data.levels || []);
      buildAudio();
      v.play().catch(() => note("Play dabao — autoplay roka gaya hai."));
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const l = hls.levels[data.level];
      if (l) $("#ntwQualityBtn").textContent = hls.autoLevelEnabled ? "Auto" : `${l.height}p`;
      buildAudio();
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, buildAudio);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data?.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recovered) {
        recovered = true;
        note("Network atka — stream phir se jod rahe hain…");
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        note("Media error — recover kar rahe hain…");
        hls.recoverMediaError();
      } else {
        spin(false);
        note("Stream ruk gaya — ↻ se fresh try karo.");
      }
    });
  } else {
    v.src = src;
    v.play().catch(() => {});
  }
  spin(false);
}

function buildQuality(levels) {
  const menu = $("#ntwQualityMenu");
  menu.querySelectorAll("[data-quality]:not([data-quality='-1'])").forEach((b) => b.remove());
  levels.forEach((l, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.quality = String(i);
    b.textContent = `${l.height}p · ${Math.round((l.bitrate || 0) / 1000)} kbps`;
    menu.appendChild(b);
  });
  menu.querySelectorAll("[data-quality]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.quality);
      if (hls) hls.nextLevel = i;
      menu.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      $("#ntwQualityBtn").textContent = i < 0 ? "Auto" : `${levels[i]?.height || ""}p`;
      toggleMenu(menu, false);
    })
  );
}

function buildAudio() {
  const menu = $("#ntwAudioMenu");
  const tracks = hls?.audioTracks || [];
  menu.querySelectorAll("[data-audio]:not([data-audio='-1'])").forEach((b) => b.remove());
  tracks.forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.audio = String(i);
    b.textContent = t.name || t.lang || `Audio ${i + 1}`;
    if (i === hls.audioTrack) b.classList.add("on");
    menu.appendChild(b);
  });
  // No split renditions upstream (muxed audio): say so honestly
  // instead of showing an empty menu that looks broken.
  if (!tracks.length) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Muxed audio (video ke saath)";
    b.classList.add("on");
    menu.appendChild(b);
  }
  menu.querySelectorAll("[data-audio]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.audio);
      if (hls && i >= 0) hls.audioTrack = i;
      menu.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      toggleMenu(menu, false);
    })
  );
}

/* ---------- controls ---------- */
const togglePlay = () => (v.paused ? v.play().catch(() => {}) : v.pause());
$("#ntwPlay").addEventListener("click", togglePlay);
$("#ntwBigPlay").addEventListener("click", togglePlay);
v.addEventListener("click", togglePlay);
const seekBy = (d) => {
  v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + d));
  const fx = $(d < 0 ? "#ntwFxL" : "#ntwFxR");
  fx.classList.add("show");
  setTimeout(() => fx.classList.remove("show"), 550);
};
$("#ntwBack10").addEventListener("click", () => seekBy(-10));
$("#ntwFwd10").addEventListener("click", () => seekBy(10));
$("#ntwCBack").addEventListener("click", (e) => { e.stopPropagation(); seekBy(-10); });
$("#ntwCFwd").addEventListener("click", (e) => { e.stopPropagation(); seekBy(10); });

let lastTap = 0;
shell.addEventListener("dblclick", (e) => {
  const r = shell.getBoundingClientRect();
  seekBy(e.clientX - r.left < r.width / 2 ? -10 : 10);
});
shell.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTap < 300) {
    const t = e.changedTouches[0];
    const r = shell.getBoundingClientRect();
    seekBy(t.clientX - r.left < r.width / 2 ? -10 : 10);
  }
  lastTap = now;
});

v.addEventListener("play", () => { shell.classList.add("playing"); $("#ntwPlay").textContent = "⏸"; $("#ntwBigPlay").firstElementChild.textContent = "⏸"; });
v.addEventListener("pause", () => { shell.classList.remove("playing"); $("#ntwPlay").textContent = "▶"; $("#ntwBigPlay").firstElementChild.textContent = "▶"; });
v.addEventListener("waiting", () => spin(true));
v.addEventListener("playing", () => spin(false));
v.addEventListener("volumechange", paintAudio);
$("#ntwMute").addEventListener("click", () => { v.muted = !v.muted; paintAudio(); });
$("#ntwVol").addEventListener("input", (e) => { v.volume = Number(e.target.value); v.muted = v.volume === 0; paintAudio(); });

v.addEventListener("timeupdate", () => {
  const d = v.duration || 0;
  $("#ntwPlayed").style.width = d ? `${(v.currentTime / d) * 100}%` : "0";
  $("#ntwTime").textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
  if (v.currentTime > 5 && !v.ended && contentId) localStorage.setItem(POS_KEY(contentId), String(Math.floor(v.currentTime)));
});
v.addEventListener("progress", () => {
  try {
    const d = v.duration || 0;
    if (d && v.buffered.length) $("#ntwBuffered").style.width = `${(v.buffered.end(v.buffered.length - 1) / d) * 100}%`;
  } catch { /* no buffered ranges yet */ }
});
v.addEventListener("loadedmetadata", () => {
  const at = Number(localStorage.getItem(POS_KEY(contentId)) || 0);
  if (at > 5 && v.duration && at < v.duration - 10) v.currentTime = at;
  paintAudio();
});
v.addEventListener("ended", () => {
  if (contentId) localStorage.removeItem(POS_KEY(contentId));
  const i = siblings.findIndex((s) => s.id === contentId);
  if (i >= 0 && siblings[i + 1]) {
    note("Lecture khatm — agla chala rahe hain…");
    setTimeout(() => goTo(siblings[i + 1]), 1500);
  }
});
$("#ntwProgress").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (v.duration) v.currentTime = ((e.clientX - r.left) / r.width) * v.duration;
});

const toggleMenu = (menu, showIt) => {
  for (const m of ["#ntwSpeedMenu", "#ntwQualityMenu", "#ntwAudioMenu"]) $(m).hidden = m !== `#${menu.id}` ? true : showIt === undefined ? !menu.hidden : !showIt;
};
$("#ntwSpeedBtn").addEventListener("click", () => toggleMenu($("#ntwSpeedMenu")));
$("#ntwQualityBtn").addEventListener("click", () => toggleMenu($("#ntwQualityMenu")));
$("#ntwAudioBtn").addEventListener("click", () => toggleMenu($("#ntwAudioMenu")));
$("#ntwSpeedMenu").querySelectorAll("[data-speed]").forEach((b) =>
  b.addEventListener("click", () => {
    v.playbackRate = Number(b.dataset.speed);
    $("#ntwSpeedBtn").textContent = `${b.dataset.speed}×`;
    $("#ntwSpeedMenu").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    toggleMenu($("#ntwSpeedMenu"), false);
  })
);
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ntw-menuwrap")) for (const m of ["#ntwSpeedMenu", "#ntwQualityMenu", "#ntwAudioMenu"]) $(m).hidden = true;
});

$("#ntwStatsBtn").addEventListener("click", () => { $("#ntwStats").hidden = !$("#ntwStats").hidden; });
setInterval(() => {
  if ($("#ntwStats").hidden) return;
  const q2 = v.getVideoPlaybackQuality?.();
  $("#ntwStRes").textContent = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : "—";
  const l = hls?.levels?.[hls.currentLevel];
  $("#ntwStBitrate").textContent = l ? `${Math.round(l.bitrate / 1000)} kbps` : "—";
  $("#ntwStAudio").textContent = v.muted ? "muted" : audioReport();
  let ahead = 0;
  try {
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) ahead = v.buffered.end(i) - v.currentTime;
  } catch { /* ranges not ready */ }
  $("#ntwStBuffer").textContent = `${ahead.toFixed(1)}s`;
  $("#ntwStDropped").textContent = q2 ? String(q2.droppedVideoFrames) : "—";
  $("#ntwStEngine").textContent = hls ? "hls.js" : dash ? "dash.js" : "native";
}, 1000);

$("#ntwRetry").addEventListener("click", () => {
  recovered = false;
  if (hls) { try { hls.destroy(); } catch { /* gone */ } hls = null; }
  resolve();
});
$("#ntwPip").addEventListener("click", async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } catch { note("PiP is browser mein nahi chal raha."); }
});
$("#ntwFull").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else shell.requestFullscreen?.();
});

function goTo(item) {
  const qs = new URLSearchParams({
    course: courseId, content: item.id, vdc: item.vdcId || "", file: item.fileUrl || "",
    title: item.title, folder: folderId, courseTitle: q.get("courseTitle") || "",
  });
  location.href = `/ntwatch?${qs}`;
}
$("#ntwPrev").addEventListener("click", () => {
  const i = siblings.findIndex((s) => s.id === contentId);
  if (i > 0) goTo(siblings[i - 1]);
});
$("#ntwNext").addEventListener("click", () => {
  const i = siblings.findIndex((s) => s.id === contentId);
  if (i >= 0 && siblings[i + 1]) goTo(siblings[i + 1]);
});

document.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
  const k = e.key.toLowerCase();
  if (k === " " || k === "k") { e.preventDefault(); togglePlay(); }
  else if (k === "arrowleft" || k === "j") seekBy(-10);
  else if (k === "arrowright" || k === "l") seekBy(10);
  else if (k === "f") $("#ntwFull").click();
  else if (k === "m") { v.muted = !v.muted; paintAudio(); }
  else if (k === "i") $("#ntwStatsBtn").click();
});

/* ---------- up next ---------- */
(async () => {
  if (!courseId) return;
  try {
    const d = await fetch(`/api/nexttopper?view=content&course=${encodeURIComponent(courseId)}&folder=${encodeURIComponent(folderId)}`, {
      headers: { Accept: "application/json" },
    }).then((r) => r.json());
    siblings = (d.items || []).filter((x) => x.kind === "video");
    $("#ntwUpNext").innerHTML = siblings
      .filter((s) => s.id !== contentId)
      .map((s) => `<button class="ntw-nextitem" data-go="${s.id}" type="button">${s.thumbnail ? `<img src="${s.thumbnail}" alt="" loading="lazy" />` : ""}<strong>${s.title}</strong><span>${s.duration && s.duration !== "0" ? `${Math.round(Number(s.duration) / 60)} min · ` : ""}Lecture</span></button>`)
      .join("") || `<p class="tiny dim">Is folder mein aur lectures nahi hain.</p>`;
    $("#ntwUpNext").querySelectorAll("[data-go]").forEach((el) =>
      el.addEventListener("click", () => {
        const item = siblings.find((s) => s.id === el.dataset.go);
        if (item) goTo(item);
      })
    );
  } catch { /* sidebar is garnish */ }
})();

paintAudio();
resolve();
