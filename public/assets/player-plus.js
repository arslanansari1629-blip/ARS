/* =========================================================================
   Player Plus — theatre mode, ambient glow, and note markers.
   -------------------------------------------------------------------------
   A companion to the player, like watch-notes.js: it borrows the <video>
   clock and the scrubber's geometry and owns nothing else. If this module
   fails, the lecture plays exactly as before.
   ========================================================================= */

const video = document.getElementById("video");
const wrap = document.getElementById("playerRoot");
const track = document.querySelector(".scrubber-track");
const lectureId = new URLSearchParams(location.search).get("id") || "";

/* ---- ambient glow: the screen lights the room a little ---- */
if (wrap) wrap.classList.add("has-ambient");

/* ---- theatre mode: the lecture takes the whole width ---- */
const actions = document.querySelector(".now-actions");
if (actions && !document.getElementById("theatreBtn")) {
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost btn-sm";
  btn.id = "theatreBtn";
  btn.type = "button";
  btn.textContent = "Theatre";
  btn.title = "Widen the player (t)";
  actions.appendChild(btn);
  const toggle = () => {
    const on = document.body.classList.toggle("theatre");
    btn.textContent = on ? "Exit theatre" : "Theatre";
    try { localStorage.setItem("arsvibe.theatre", on ? "1" : ""); } catch { /* ignore */ }
  };
  btn.addEventListener("click", toggle);
  try {
    if (localStorage.getItem("arsvibe.theatre") === "1") toggle();
  } catch { /* ignore */ }
  window.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "");
    if (!typing && e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) toggle();
  });
}

/* ---- live edge: for a live class, "jump to now" is one tap ---- */
if (video && actions && !document.getElementById("liveEdgeBtn")) {
  const btn = document.createElement("button");
  btn.className = "btn btn-primary btn-sm";
  btn.id = "liveEdgeBtn";
  btn.type = "button";
  btn.textContent = "🔴 Live";
  btn.title = "Jump to the live edge";
  btn.hidden = true;
  actions.appendChild(btn);
  btn.addEventListener("click", () => {
    if (Number.isFinite(video.duration) && video.duration) video.currentTime = Math.max(0, video.duration - 2);
    else if (video.seekable?.length) video.currentTime = video.seekable.end(video.seekable.length - 1);
    video.play?.().catch(() => {});
  });
  const checkLive = () => {
    const live = video.duration === Infinity || (video.seekable?.length && !Number.isFinite(video.duration));
    btn.hidden = !live;
    document.getElementById("commentsCard")?.classList.toggle("is-live", Boolean(live));
  };
  video.addEventListener("loadedmetadata", checkLive);
  video.addEventListener("durationchange", checkLive);
  checkLive();
}

/* ---- note markers: your notes, drawn on the scrubber ---- */
function paintMarkers() {
  if (!track || !video || !lectureId) return;
  const duration = Number(video.duration) || 0;
  track.querySelectorAll(".note-marker").forEach((m) => m.remove());
  if (!duration) return;
  let rows = [];
  try {
    rows = JSON.parse(localStorage.getItem(`notes:${lectureId}`) || "[]");
  } catch {
    return;
  }
  for (const n of Array.isArray(rows) ? rows : []) {
    if (!Number.isFinite(n?.t)) continue;
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "note-marker";
    dot.style.left = `${Math.min(100, (n.t / duration) * 100)}%`;
    dot.title = n.text ? `${Math.floor(n.t / 60)}:${String(Math.floor(n.t % 60)).padStart(2, "0")} — ${n.text}` : "Bookmark";
    dot.setAttribute("aria-label", dot.title);
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      video.currentTime = n.t;
      video.play?.().catch(() => {});
    });
    track.appendChild(dot);
  }
}
if (video && track) {
  video.addEventListener("loadedmetadata", paintMarkers);
  window.addEventListener("storage", (e) => {
    if (e.key === `notes:${lectureId}`) paintMarkers();
  });
  // Notes are written by a sibling module in the same tab (no storage event
  // fires for same-tab writes), so repaint on a gentle cadence while paused
  // or playing — three DOM nodes, not a render loop.
  setInterval(paintMarkers, 4000);
  paintMarkers();
}


/* =========================================================================
   Player God Mode — cinematic opening, centre flash, living ambient glow.
   -------------------------------------------------------------------------
   Three layers the core player does not know about:
     1. an opening animation that plays while the stream is being signed,
        and lifts on the first real frame;
     2. a centre transport flash (play/pause) drawn on the film itself;
     3. an ambient glow whose colour is sampled from the playing video,
        so the room light follows the lecture instead of a fixed tint.
   Every layer is cosmetic: remove this block and playback is unchanged.
   ========================================================================= */

const stageEl = document.getElementById("playerStage");

/* ---- 1 · the opening: ARS PLAYER, drawn while the signer works ---- */
if (wrap && stageEl && video && !document.getElementById("playerIntro")) {
  const intro = document.createElement("div");
  intro.className = "player-intro";
  intro.id = "playerIntro";
  intro.setAttribute("aria-hidden", "true");
  intro.innerHTML = `
    <span class="pi-ring"></span>
    <img class="pi-logo" src="/assets/logo.svg" alt="" width="54" height="54" />
    <div class="pi-word">ARS&nbsp;PLAYER</div>
    <div class="pi-title" id="piTitle">Preparing your lecture…</div>
    <div class="pi-bars" aria-hidden="true">${"<i></i>".repeat(7)}</div>`;
  stageEl.appendChild(intro);

  const piTitle = intro.querySelector("#piTitle");
  const paintTitle = () => {
    const t = document.getElementById("lectureTitle")?.textContent?.trim();
    if (t && !/loading/i.test(t)) piTitle.textContent = t;
  };
  paintTitle();
  const titleTimer = setInterval(paintTitle, 600);

  let introGone = false;
  const liftIntro = () => {
    if (introGone) return;
    introGone = true;
    clearInterval(titleTimer);
    paintTitle();
    intro.classList.add("pi-out");
    setTimeout(() => intro.remove(), 750);
  };
  video.addEventListener("playing", liftIntro, { once: true });
  intro.addEventListener("click", liftIntro);
  // A stream that errors must not leave the curtain up over the retry UI.
  setTimeout(liftIntro, 8000);
}

/* ---- 2 · centre flash: the tap, acknowledged on the film ---- */
if (stageEl && video && !document.getElementById("centerFlash")) {
  const flashEl = document.createElement("div");
  flashEl.className = "center-flash";
  flashEl.id = "centerFlash";
  flashEl.setAttribute("aria-hidden", "true");
  flashEl.innerHTML = `
    <svg class="cf-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z"/></svg>
    <svg class="cf-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
  stageEl.appendChild(flashEl);
  let flashTimer = null;
  const flash = (kind) => {
    flashEl.dataset.kind = kind;
    flashEl.classList.remove("on");
    void flashEl.offsetWidth;
    flashEl.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove("on"), 480);
  };
  video.addEventListener("play", () => flash("play"));
  video.addEventListener("pause", () => {
    // A pause at the very end is the up-next card's moment, not a flash's.
    if (!video.ended) flash("pause");
  });
}

/* ---- 3 · living ambient: the glow takes the lecture's own colour ---- */
if (wrap && video) {
  const sample = document.createElement("canvas");
  sample.width = 16;
  sample.height = 16;
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  let last = { r: 228, g: 87, b: 46 };
  const tick = () => {
    if (video.paused || video.ended || video.readyState < 2 || !sctx) return;
    try {
      sctx.drawImage(video, 0, 0, 16, 16);
      const data = sctx.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 16) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
      }
      if (!n) return;
      // Ease towards the new colour so the room light breathes, not strobes.
      last = {
        r: Math.round(last.r + (r / n - last.r) * 0.35),
        g: Math.round(last.g + (g / n - last.g) * 0.35),
        b: Math.round(last.b + (b / n - last.b) * 0.35),
      };
      wrap.style.setProperty("--ambient", `rgba(${last.r}, ${last.g}, ${last.b}, 0.5)`);
    } catch {
      /* a tainted canvas (cross-origin frame) just keeps the last colour */
    }
  };
  setInterval(tick, 900);
}

/* =========================================================================
   Playback tools — stream stats and a frame snapshot.
   -------------------------------------------------------------------------
   Two small instruments in the same row as Theatre:
     · Stats draws the numbers the player already knows (resolution,
       buffer ahead, dropped frames, live latency) once a second;
     · Snapshot saves the current frame as a PNG for the student's
       notes. The relay serves CORS-clean media, so the canvas is not
       tainted; if a browser still refuses, the button says so.
   Both are cosmetic: remove this block and playback is unchanged.
   ========================================================================= */

if (video && wrap && actions && !document.getElementById("statsBtn")) {
  const statsBtn = document.createElement("button");
  statsBtn.className = "btn btn-ghost btn-sm";
  statsBtn.id = "statsBtn";
  statsBtn.type = "button";
  statsBtn.textContent = "Stats";
  statsBtn.title = "Stream statistics (resolution, buffer, dropped frames)";
  actions.appendChild(statsBtn);

  const panel = document.createElement("div");
  panel.className = "player-stats";
  panel.id = "playerStats";
  panel.hidden = true;
  panel.setAttribute("role", "status");
  wrap.appendChild(panel);

  const fmt = (n, unit = "") => (Number.isFinite(n) ? `${Math.round(n)}${unit}` : "—");
  let timer = null;
  const paint = () => {
    const live = !Number.isFinite(video.duration);
    const bufferedEnd = video.buffered?.length ? video.buffered.end(video.buffered.length - 1) : 0;
    const ahead = Math.max(0, bufferedEnd - (video.currentTime || 0));
    const q = video.getVideoPlaybackQuality?.();
    const latency = live && video.seekable?.length
      ? Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime)
      : NaN;
    panel.innerHTML = [
      ["Resolution", video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "—"],
      ["Speed", `${Number(video.playbackRate) || 1}×`],
      [live ? "Behind live" : "Buffered ahead", fmt(live ? latency : ahead, "s")],
      ["Dropped frames", q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}` : "—"],
      ["Buffer health", Number.isFinite(ahead) ? `${Math.min(100, Math.round((ahead / 30) * 100))}%` : "—"],
      ["Network", navigator.connection ? `${navigator.connection.effectiveType || "?"}${navigator.connection.downlink ? ` · ~${navigator.connection.downlink} Mbps` : ""}` : "—"],
      ["Self-heal", (() => {
        const h = window.__player?._state?.healing;
        if (!h) return "armed";
        return `${h.health}/100${h.heals ? ` · ${h.heals} heal${h.heals === 1 ? "" : "s"}` : ""}${h.action ? ` · ${h.action}` : ""}`;
      })()],
      ["State", video.paused ? "paused" : live ? "live" : "playing"],
    ]
      .map(([k, v]) => `<div class="ps-row"><span>${k}</span><strong>${v}</strong></div>`)
      .join("");
  };
  const setOn = (on) => {
    panel.hidden = !on;
    statsBtn.classList.toggle("active", on);
    clearInterval(timer);
    timer = null;
    if (on) {
      paint();
      timer = setInterval(paint, 1000);
    }
  };
  statsBtn.addEventListener("click", () => setOn(panel.hidden));
}

if (video && actions && !document.getElementById("snapBtn")) {
  const snapBtn = document.createElement("button");
  snapBtn.className = "btn btn-ghost btn-sm";
  snapBtn.id = "snapBtn";
  snapBtn.type = "button";
  snapBtn.textContent = "Snapshot";
  snapBtn.title = "Save this frame as a PNG for your notes";
  actions.appendChild(snapBtn);
  snapBtn.addEventListener("click", () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `ars-frame-${Math.floor(video.currentTime || 0)}s.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, "image/png");
    } catch {
      snapBtn.textContent = "Snapshot blocked";
      setTimeout(() => (snapBtn.textContent = "Snapshot"), 1800);
    }
  });
}

/* =========================================================================
   Audio Only — the aryavidya player's screen-off mode.
   -------------------------------------------------------------------------
   Blanks the film (a CSS class; the lecture keeps playing and the
   phone can rest face-down) and tells the student so on the stage.
   Playback itself is untouched: remove this block and nothing changes
   except one fewer button.
   ========================================================================= */

if (video && wrap && actions && !document.getElementById("audioBtn")) {
  const audioBtn = document.createElement("button");
  audioBtn.className = "btn btn-ghost btn-sm";
  audioBtn.id = "audioBtn";
  audioBtn.type = "button";
  audioBtn.textContent = "Audio only";
  audioBtn.title = "Screen-off listening — blank the picture, keep the lecture";
  actions.appendChild(audioBtn);

  const chip = document.createElement("div");
  chip.className = "audio-only-chip";
  chip.id = "audioChip";
  chip.hidden = true;
  chip.innerHTML = `<strong>🎧 Audio only</strong><span>Screen is off — the lecture keeps playing. Tap Audio only again to bring the picture back.</span>`;
  (stageEl || wrap).appendChild(chip);

  audioBtn.addEventListener("click", () => {
    const on = wrap.classList.toggle("audio-only");
    chip.hidden = !on;
    audioBtn.classList.toggle("active", on);
    audioBtn.textContent = on ? "Show video" : "Audio only";
  });
}

/* =========================================================================
   Frame step + fine speed — the editor's keys.
   -------------------------------------------------------------------------
   When paused, , and . step one frame (1/30s) either way — the way to
   land exactly on the formula the teacher just wrote. When playing,
   < and > nudge speed by a quarter step. The core player keeps its
   own keys; these only add.
   ========================================================================= */

if (video) {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    if (e.key === "," || e.key === ".") {
      if (!video.paused) return;
      e.preventDefault();
      video.currentTime = Math.max(0, (video.currentTime || 0) + (e.key === "." ? 1 / 30 : -1 / 30));
    } else if (e.key === "<" || e.key === ">") {
      const next = Math.min(6, Math.max(0.25, (Number(video.playbackRate) || 1) + (e.key === ">" ? 0.25 : -0.25)));
      video.playbackRate = Math.round(next * 100) / 100;
    }
  });
}

/* =========================================================================
   Pro controls — Media Session, Auto-PiP, percent seek.
   -------------------------------------------------------------------------
   The engineering layer a "most advanced" player is judged by:
     · Media Session: the OS, the lock screen and the headphone buttons
       drive the lecture — title, artwork, play/pause/seek — instead of
       the browser treating the tab as an anonymous noise source.
     · Auto-PiP: opt-in; when the tab is hidden mid-lecture the class
       follows the student into a floating window. Browsers may refuse
       without engagement; refusals are swallowed, never surfaced.
     · Percent seek: 0–9 jump to that tenth of the lecture, the way
       every serious player behaves.
   All guarded, all removable without touching playback.
   ========================================================================= */

if (video && "mediaSession" in navigator) {
  const paintMeta = () => {
    const title = document.getElementById("lectureTitle")?.textContent?.trim();
    if (!title || /loading/i.test(title)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: "ArsVibe · Physics Wallah",
        album: document.querySelector(".crumbs")?.textContent?.replace(/\s+/g, " ").trim() || "Lecture",
        artwork: [{ src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
    } catch { /* metadata is garnish */ }
  };
  paintMeta();
  setTimeout(paintMeta, 2500);
  const seekBy = (d) => { video.currentTime = Math.max(0, (video.currentTime || 0) + d); };
  try {
    navigator.mediaSession.setActionHandler("play", () => video.play?.().catch(() => {}));
    navigator.mediaSession.setActionHandler("pause", () => video.pause());
    navigator.mediaSession.setActionHandler("seekbackward", (e) => seekBy(-(e.seekOffset || 10)));
    navigator.mediaSession.setActionHandler("seekforward", (e) => seekBy(e.seekOffset || 10));
    navigator.mediaSession.setActionHandler("seekto", (e) => {
      if (Number.isFinite(e.seekTime)) video.currentTime = e.seekTime;
    });
  } catch { /* older engines */ }
  const syncState = () => {
    try { navigator.mediaSession.playbackState = video.paused ? "paused" : "playing"; } catch { /* noop */ }
  };
  video.addEventListener("play", syncState);
  video.addEventListener("pause", syncState);
}

if (video && actions && document.pictureInPictureEnabled && !document.getElementById("autopipBtn")) {
  const pipBtn = document.createElement("button");
  pipBtn.className = "btn btn-ghost btn-sm";
  pipBtn.id = "autopipBtn";
  pipBtn.type = "button";
  const KEY = "arsvibe.autopip";
  const paint = () => {
    const on = localStorage.getItem(KEY) === "1";
    pipBtn.textContent = on ? "Auto-PiP on" : "Auto-PiP";
    pipBtn.classList.toggle("active", on);
    pipBtn.title = on
      ? "The lecture follows you into a floating window when you switch tabs"
      : "Let the lecture follow you into a floating window when you switch tabs";
  };
  pipBtn.addEventListener("click", () => {
    localStorage.setItem(KEY, localStorage.getItem(KEY) === "1" ? "0" : "1");
    paint();
  });
  paint();
  actions.appendChild(pipBtn);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "hidden") return;
    if (localStorage.getItem(KEY) !== "1") return;
    if (video.paused || video.ended || document.pictureInPictureElement) return;
    try { await video.requestPictureInPicture(); } catch { /* the browser declined */ }
  });
}

if (video) {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key) && Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (Number(e.key) / 10) * video.duration;
    }
  });
}
