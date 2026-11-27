/**
 * The Allen platform page v2: batches → subjects → chapters →
 * lectures → upgraded player, entirely over our own /api/allen
 * (which proxies the Allen upstream stack). Playback always loads the
 * ArsVibe Allen proxy URL — the browser never talks to Allen hosts
 * directly — with quality/speed/PiP/fullscreen, seek bar, resume
 * position and self-retry.
 */
const $ = (s) => document.querySelector(s);
const savedKey = "arsvibe.allen.saved.v1";
const historyKey = "arsvibe.allen.history.v1";
const posKey = (id) => `arsvibe.allen.pos.${id}`;

let all = [];
let exam = "All";
let sortBy = "default";
let showSaved = false;
let hls = null;
let currentLecture = null;
let currentChapter = null; // { batch, subject, topic, lectures }
let lastSaveAt = 0;
let watchRetriedOnce = false;

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};
const saved = () => readJson(savedKey, []);
const isSaved = (code) => saved().includes(code);
function toggleSaved(code) {
  const list = saved().filter((c) => c !== code);
  if (!isSaved(code)) list.push(code);
  localStorage.setItem(savedKey, JSON.stringify(list));
  paintSavedCount();
  renderGrid();
}
function paintSavedCount() {
  $("#allenSavedCount").textContent = String(saved().length);
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  return res.json().catch(() => ({ success: false, items: [] }));
}

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(sec).padStart(2, "0")}`;
};

/* ---------------- catalogue ---------------- */

function examClass(b) {
  if (b.exam === "NEET") return "exam-neet";
  if (b.exam === "JEE Main") return "exam-main";
  if (/grade|foundation/i.test(b.exam)) return "exam-foundation";
  return "";
}

function card(batch, i = 0) {
  const el = document.createElement("article");
  el.className = "allen-card";
  // Entrance stagger (Allen Ultra): rows bloom in sequence instead of
  // landing as one flat slab; capped so a 500-row catalogue never
  // keeps a student waiting on choreography.
  el.style.animationDelay = `${Math.min(i, 14) * 38}ms`;
  el.innerHTML = `
    <div class="allen-card-top ${examClass(batch)}">
      <div class="row" style="gap:6px;align-items:center">
        <span class="allen-tag">${batch.exam}</span>
        ${batch.live ? `<span class="allen-tag live">● LIVE</span>` : ""}
        <span class="allen-card-code" style="margin-left:auto"></span>
      </div>
      <h3 class="allen-card-name"></h3>
    </div>
    <div class="allen-card-body">
      <div class="allen-meta">
        ${batch.class ? `<span>${batch.class}</span>` : ""}
        ${batch.type ? `<span>${batch.type}</span>` : ""}
        ${batch.timing ? `<span>${batch.timing}</span>` : ""}
      </div>
      <div class="allen-actions">
        <button class="allen-btn" data-explore type="button">Explore →</button>
        <button class="allen-btn ghost ${isSaved(batch.code) ? "saved" : ""}" data-save type="button">${isSaved(batch.code) ? "★ Saved" : "☆ Save"}</button>
      </div>
    </div>`;
  // Catalogue text is data, never markup.
  el.querySelector(".allen-card-code").textContent = batch.code;
  el.querySelector(".allen-card-name").textContent = batch.name;
  el.querySelector("[data-explore]").addEventListener("click", () => openBatch(batch));
  el.querySelector("[data-save]").addEventListener("click", () => toggleSaved(batch.code));
  return el;
}

function sorted(rows) {
  const out = [...rows];
  if (sortBy === "name") out.sort((a, b) => a.name.localeCompare(b.name));
  if (sortBy === "class") out.sort((a, b) => String(a.class).localeCompare(String(b.class), undefined, { numeric: true }));
  if (sortBy === "type") out.sort((a, b) => String(a.type).localeCompare(String(b.type)));
  return out;
}

function renderGrid() {
  const term = $("#allenSearch").value.trim().toLowerCase();
  const rows = sorted(
    all.filter((b) => {
      if (showSaved && !isSaved(b.code)) return false;
      if (exam !== "All" && b.exam !== exam) return false;
      if (!term) return true;
      return `${b.name} ${b.code} ${b.class} ${b.exam} ${b.type}`.toLowerCase().includes(term);
    })
  );
  $("#allenGrid").replaceChildren(...rows.map((b, i) => card(b, i)));
  $("#allenStatus").textContent = rows.length
    ? `All Batches (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ""})`
    : all.length
      ? "No Allen batches match that filter."
      : "The Allen catalogue is quiet right now — it will recover on its own when the upstream answers again.";
}

function paintStats() {
  const set = (id, n) => {
    const el = $(id);
    if (!el) return;
    // Count-up (Allen Ultra): the number climbs to its real value.
    // Always lands exactly on n; a reduced-motion reader gets it
    // instantly.
    const target = Number(n) || 0;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || target === 0) {
      el.textContent = String(target);
      return;
    }
    const started = performance.now();
    const tick = (now) => {
      // Clamped both ways: a frame timestamp can predate `started`
      // by a frame, and an unclamped negative p turns the easing
      // cubic into a runaway negative number on the hero.
      const p = Math.min(1, Math.max(0, (now - started) / 750));
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  set("#allenStatTotal", all.length);
  set("#allenStatJee", all.filter((b) => /^JEE/.test(b.exam)).length);
  set("#allenStatNeet", all.filter((b) => b.exam === "NEET").length);
  set("#allenStatLive", all.filter((b) => b.live).length);
}

function paintContinue() {
  const history = readJson(historyKey, []);
  const wrap = $("#allenContinueWrap");
  if (!history.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $("#allenContinue").replaceChildren(
    ...history.slice(0, 8).map((h) => {
      const b = document.createElement("button");
      b.className = "cw";
      b.type = "button";
      b.innerHTML = `<span>▶ Continue · </span><b></b><span></span>`;
      b.querySelector("b").textContent = h.title;
      b.querySelectorAll("span")[1].textContent = `${h.subject || ""} · ${h.code || ""}`;
      b.addEventListener("click", () => {
        const batch = all.find((x) => x.code === h.code);
        if (batch) openBatch(batch);
      });
      return b;
    })
  );
}

async function loadCatalogue() {
  paintSavedCount();
  $("#allenGrid").replaceChildren(
    ...Array.from({ length: 8 }, () => {
      const d = document.createElement("div");
      d.className = "allen-skel";
      return d;
    })
  );
  const out = await api("/api/allen?view=batches");
  all = Array.isArray(out.items) ? out.items : [];
  // Catalogue FIRST, cosmetics after, each in its own fault cell.
  // The hero stats once painted happily (517! 253!) while a throw in
  // a later painter left the grid white — a student reads that as
  // "the site is broken", and they are right. The grid is the page;
  // nothing decorative is allowed to stand in front of it any more.
  try {
    renderGrid();
  } catch (err) {
    reportStage("render", err?.message || String(err));
    $("#allenStatus").textContent = "Batches load ho gaye lekin list ban nahi payi — Retry dabao.";
  }
  try {
    paintStats();
  } catch {
    /* the numbers are decoration */
  }
  try {
    paintContinue();
  } catch {
    /* continue-watching is decoration */
  }
}

/* ---------------- drill-down ---------------- */

async function openBatch(batch) {
  $("#allenCatalogue").hidden = true;
  $("#allenContinueWrap").hidden = true;
  $("#allenWatch").hidden = true;
  $("#allenBatch").hidden = false;
  $("#allenBatchName").textContent = batch.name;
  $("#allenBatchMeta").textContent = [batch.class, batch.exam, batch.type, batch.code].filter(Boolean).join(" • ");
  $("#allenSubjects").replaceChildren();
  $("#allenTopicsWrap").hidden = true;
  $("#allenLecturesWrap").hidden = true;
  const subjectsUrl = `/api/allen?view=subjects&batch=${encodeURIComponent(batch.batchId)}&course=${encodeURIComponent(batch.courseId)}`;
  let out = await api(subjectsUrl);
  let subjects = Array.isArray(out.items) ? out.items : [];
  if (!subjects.length && !out.empty) {
    // One quiet retry before saying anything: upstream blips and a
    // stale cached page both look exactly like "no subjects" once.
    // (An explicit `empty` answer is NOT retried — the upstream has
    // already told us this batch lists nothing, and a retry would
    // tell the student the same lie twice.)
    await new Promise((r) => setTimeout(r, 700));
    out = await api(subjectsUrl);
    subjects = Array.isArray(out.items) ? out.items : [];
  }
  const box = $("#allenSubjects");
  if (!subjects.length) {
    if (out.empty) {
      // The honest answer for most of the catalogue: the upstream
      // itself lists no subjects for this batch, so no retry can
      // conjure content. Say so plainly and point back to the list.
      box.innerHTML = `<p class="tiny dim">Is batch ke liye upstream par abhi koi subject list nahi hai — ye batch khaali hai, isme kholne ko kuch nahi. Koi dusra batch chun lo.</p>`;
      return;
    }
    box.innerHTML = `<p class="tiny dim">Subjects load nahi ho paye${out.status ? ` (upstream status ${out.status})` : ""} — network blip ho sakta hai. <button class="allen-btn ghost" id="allenSubjectsRetry" type="button">Retry</button></p>`;
    $("#allenSubjectsRetry")?.addEventListener("click", () => openBatch(batch));
    return;
  }
  box.replaceChildren(
    ...subjects.map((s) => {
      const el = document.createElement("article");
      el.className = "allen-subject";
      el.innerHTML = `<h3></h3><p class="tiny dim">${s.tag || s.badge || "Lectures"}</p><button class="allen-btn" type="button">Open chapters →</button>`;
      el.querySelector("h3").textContent = s.name;
      el.querySelector("button").addEventListener("click", () => openSubject(batch, s));
      return el;
    })
  );
}

function rowEl(num, title, meta, actionLabel) {
  const row = document.createElement("button");
  row.className = "allen-row";
  row.type = "button";
  row.innerHTML = `<span class="num"></span><span class="ttl"></span>${meta || ""}<span class="allen-btn" style="pointer-events:none">${actionLabel}</span>`;
  row.querySelector(".num").textContent = num;
  row.querySelector(".ttl").textContent = title;
  return row;
}

async function openSubject(batch, subject) {
  const out = await api(
    `/api/allen?view=topics&batch=${encodeURIComponent(batch.batchId)}&course=${encodeURIComponent(batch.courseId)}&subject=${encodeURIComponent(subject.id)}&taxonomy=${encodeURIComponent(subject.taxonomyId)}`
  );
  const topics = Array.isArray(out.items) ? out.items : [];
  $("#allenTopicHead").textContent = `${subject.name} — chapters (${topics.length})`;
  const list = $("#allenTopics");
  list.replaceChildren(
    ...topics.map((t) => {
      const row = rowEl(t.order || "•", t.name, t.completed ? `<span class="done">✓ Completed</span>` : "", "Open →");
      row.addEventListener("click", () => openTopic(batch, subject, t));
      return row;
    })
  );
  if (!topics.length) list.innerHTML = `<p class="tiny dim">No chapters answered upstream for this subject yet.</p>`;
  $("#allenLecturesWrap").hidden = true;
  $("#allenTopicsWrap").hidden = false;
  $("#allenTopicsWrap").scrollIntoView({ behavior: "smooth" });
}

async function openTopic(batch, subject, topic) {
  const out = await api(
    `/api/allen?view=lectures&batch=${encodeURIComponent(batch.batchId)}&course=${encodeURIComponent(batch.courseId)}&subject=${encodeURIComponent(subject.id)}&taxonomy=${encodeURIComponent(subject.taxonomyId)}&topic=${encodeURIComponent(topic.id)}`
  );
  const lectures = Array.isArray(out.items) ? out.items : [];
  currentChapter = { batch, subject, topic, lectures };
  $("#allenLectureHead").textContent = `${topic.name} — lectures (${lectures.length})`;
  const list = $("#allenLectures");
  list.replaceChildren(
    ...lectures.map((lec, i) => {
      const label = lec.subTopics?.length ? `${lec.title} — ${lec.subTopics.join(", ")}` : lec.title;
      const thumb = lec.thumbnail ? `<img class="thumb" loading="lazy" alt="" src="/api/media?url=${encodeURIComponent(lec.thumbnail)}" />` : "";
      const row = rowEl(i + 1, label, `${thumb}<span class="dur">${lec.date || ""}${lec.duration ? ` · ${lec.duration}` : ""}</span>`, "Watch");
      row.addEventListener("click", () => watch(batch, subject, lec));
      return row;
    })
  );
  if (!lectures.length) list.innerHTML = `<p class="tiny dim">No lectures answered upstream for this chapter yet.</p>`;
  $("#allenLecturesWrap").hidden = false;
  $("#allenLecturesWrap").scrollIntoView({ behavior: "smooth" });
}

/* ---------------- Allen Player Pro (v5) ----------------
   Built fresh on the source player's layout: top title bar, center
   −10s/play/+10s cluster, bottom seek + Speed/Quality menus. Fast
   start (estimated-best level, deep buffer, quick fragment retry),
   a buffered-ahead bar, a live audio-track badge (the audio lives
   in its own playlist — when that dies the badge stays grey and the
   note says so), resume memory, Up Next and bounded self-recovery:
   in-place retries → one fresh-token reload → native engine. */

const video = () => $("#allenVideo");
const shell = () => $("#allenPlayerShell");

function setNote(t) {
  $("#allenWatchNote").textContent = t || "";
}

function destroyHls() {
  if (hls) {
    try {
      hls.destroy();
    } catch {
      /* already gone */
    }
    hls = null;
  }
}

function paintPlayBtn() {
  const v = video();
  $("#allenPlayBtn").textContent = v.paused ? "▶" : "⏸";
  shell()?.classList.toggle("ap-paused", v.paused);
}

function paintUpNext() {
  const box = $("#allenUpNext");
  if (!box) return;
  const lectures = currentChapter?.lectures || [];
  box.replaceChildren(
    ...lectures.map((lec, i) => {
      const row = rowEl(i + 1, lec.title, `<span class="dur">${lec.duration || ""}</span>`, "");
      row.classList.toggle("now", currentLecture?.id === lec.id);
      row.addEventListener("click", () => watch(currentChapter.batch, currentChapter.subject, lec));
      return row;
    })
  );
  if (!lectures.length) box.innerHTML = `<p class="tiny dim">No lectures in this chapter.</p>`;
}

function stepLecture(dir) {
  const lectures = currentChapter?.lectures || [];
  const i = lectures.findIndex((l) => l.id === currentLecture?.id);
  const next = lectures[i + dir];
  if (next && currentChapter) watch(currentChapter.batch, currentChapter.subject, next);
}

function reportStage(stage, detail) {
  try {
    const payload = JSON.stringify({
      where: "allen-player",
      stage,
      detail: String(detail || "").slice(0, 300),
      at: Date.now(),
    });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/client-error", payload);
  } catch {
    /* telemetry is best-effort */
  }
}

/* Player settings that survive the session (Pro X): volume, mute,
   speed and quality are the student's, not the page's — a returning
   viewer should find the player exactly as they left it. */
const SETTINGS_KEY = "arsvibe.allen.settings.v1";
function loadSettings() {
  return readJson(SETTINGS_KEY, {}) || {};
}
function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    /* private mode */
  }
}

function wirePlayer() {
  const v = video();
  // Restore the student's own setup before anything plays.
  const settings = loadSettings();
  if (typeof settings.volume === "number") {
    v.volume = Math.min(1, Math.max(0, settings.volume));
    const vol = $("#allenVol");
    if (vol) vol.value = String(v.volume);
  }
  if (typeof settings.rate === "number" && settings.rate > 0) {
    v.playbackRate = settings.rate;
    const lbl = $("#allenSpeedBtn");
    if (lbl) lbl.textContent = `Speed · ${settings.rate}×`;
  }
  const spin = (on) => {
    const s = $("#allenSpin");
    if (s) s.hidden = !on;
  };
  v.addEventListener("play", paintPlayBtn);
  v.addEventListener("pause", paintPlayBtn);
  v.addEventListener("waiting", () => spin(true));
  v.addEventListener("playing", () => spin(false));
  v.addEventListener("canplay", () => spin(false));
  v.addEventListener("error", () => spin(false));
  v.addEventListener("ended", () => stepLecture(1));
  v.addEventListener("timeupdate", () => {
    const d = v.duration || 0;
    $("#allenProgressFill").style.width = d ? `${(v.currentTime / d) * 100}%` : "0%";
    try {
      const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      $("#allenBuffered").style.width = d ? `${(end / d) * 100}%` : "0%";
    } catch {
      /* no buffered ranges yet */
    }
    $("#allenTime").textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
    if (currentLecture && v.currentTime > 5 && Date.now() - lastSaveAt > 5000) {
      lastSaveAt = Date.now();
      try {
        localStorage.setItem(posKey(currentLecture.id), JSON.stringify({ t: v.currentTime, at: Date.now() }));
      } catch {
        /* private mode */
      }
    }
  });
  v.addEventListener("loadedmetadata", () => {
    // Fullscreen Fit Engine: remember the lecture's own shape so the
    // stage can fit portrait recordings without cropping them.
    shell()?.classList.toggle(
      "ap-video-portrait",
      !!v.videoHeight && v.videoHeight > v.videoWidth
    );
    if (!currentLecture) return;
    const pos = readJson(posKey(currentLecture.id), null);
    if (pos && pos.t > 5 && v.duration && pos.t < v.duration - 10) {
      v.currentTime = pos.t;
      setNote(`Resumed from ${fmt(pos.t)} — jahan chhoda tha, wahi se.`);
    }
  });
  v.addEventListener("click", () => (v.paused ? v.play().catch(() => {}) : v.pause()));

  const seekBy = (delta) => {
    v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + delta));
  };
  $("#allenPlayBtn").addEventListener("click", () => (v.paused ? v.play() : v.pause()));
  $("#allenBigPlay").addEventListener("click", () => v.play().catch(() => {}));
  $("#allenCBack")?.addEventListener("click", () => seekBy(-10));
  $("#allenCFwd")?.addEventListener("click", () => seekBy(10));
  $("#allenBack10").addEventListener("click", () => seekBy(-10));
  $("#allenFwd10").addEventListener("click", () => seekBy(10));
  $("#allenPrev").addEventListener("click", () => stepLecture(-1));
  $("#allenNext").addEventListener("click", () => stepLecture(1));
  $("#allenVol").addEventListener("input", (e) => {
    v.volume = Number(e.target.value);
    saveSettings({ volume: v.volume });
  });
  $("#allenProgress").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (v.duration) v.currentTime = ((e.clientX - r.left) / r.width) * v.duration;
  });
  $("#allenSpeed").addEventListener("change", (e) => (v.playbackRate = Number(e.target.value) || 1));
  $("#allenQuality").addEventListener("change", (e) => {
    if (hls) hls.currentLevel = Number(e.target.value);
  });
  $("#allenPip").addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      setNote("Picture-in-picture is browser ne allow nahi kiya.");
    }
  });
  /* ---- Fullscreen Fit Engine (player v8) ----
     Mobile fullscreen used to silently fail or letterbox: iOS Safari has
     no element requestFullscreen at all, Android needs an orientation
     lock to actually use the screen, and the stage stayed locked to
     aspect-ratio 16/9 inside the fullscreen box, so on a portrait phone
     the lecture rendered as a thin strip. The engine detects the device
     and walks a capability ladder until SOMETHING fills the screen:
       1. standard / webkit element fullscreen on the player shell
       2. + screen.orientation.lock("landscape") when the lecture is
          landscape and the phone is portrait (Android Chrome)
       3. iOS Safari: the video element's own webkitEnterFullscreen
       4. pseudo-fullscreen (fixed 100dvw × 100dvh) for webviews and
          browsers that expose none of the above — always works.
     On fullscreenchange the stage drops its 16/9 ratio and stretches to
     the real viewport (see the v8 CSS block), so the picture auto-fits
     whatever device asked for it. */
  const fsBtn = $("#allenFull");
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const inPseudoFs = () => !!shell()?.classList.contains("ap-pseudo-fs");
  const isFs = () => !!fsEl() || inPseudoFs();
  const touchDevice = () =>
    (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window) ?? false;
  const isIOS = () =>
    /iP(hone|ad|od)/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const paintFsBtn = () => {
    if (!fsBtn) return;
    fsBtn.textContent = isFs() ? "🗗" : "⛶";
    fsBtn.classList.toggle("on", isFs());
    fsBtn.title = isFs() ? "Exit fullscreen" : "Fullscreen — auto-fits your device";
  };
  const lockLandscape = async () => {
    // Only meaningful once a real fullscreen owns the screen; every
    // failure here is cosmetic, so it is swallowed by design.
    try {
      const o = screen.orientation;
      if (!o?.lock) return;
      const landscapeVideo = !v.videoWidth || v.videoWidth >= v.videoHeight;
      if (landscapeVideo && touchDevice()) await o.lock("landscape");
    } catch {
      /* browser refused (desktop, iOS, no gesture) — fullscreen still fits */
    }
  };
  const unlockOrientation = () => {
    try {
      screen.orientation?.unlock?.();
    } catch {
      /* nothing was locked */
    }
  };
  const setPseudoFs = (on) => {
    shell()?.classList.toggle("ap-pseudo-fs", on);
    document.body.classList.toggle("allen-pseudo-fs", on);
    paintFsBtn();
  };
  const enterFs = async () => {
    const target = shell();
    // 1) Standard + prefixed element fullscreen.
    const req =
      target?.requestFullscreen ||
      target?.webkitRequestFullscreen ||
      target?.webkitRequestFullScreen;
    if (target && req) {
      try {
        const p = req.call(target, { navigationUI: "hide" });
        if (p?.catch) await p;
        await lockLandscape();
        return;
      } catch {
        try {
          await req.call(target); // retry bare — some engines reject options
          await lockLandscape();
          return;
        } catch {
          /* fall through to the next rung */
        }
      }
    }
    // 2) iOS Safari: only the <video> itself may go fullscreen.
    if (isIOS() && typeof v.webkitEnterFullscreen === "function") {
      try {
        v.webkitEnterFullscreen();
        return;
      } catch {
        /* fall through */
      }
    }
    // 3) Pseudo-fullscreen: CSS takes the whole dynamic viewport.
    setPseudoFs(true);
  };
  const exitFs = async () => {
    if (inPseudoFs()) {
      setPseudoFs(false);
      return;
    }
    unlockOrientation();
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else document.webkitExitFullscreen?.();
    } catch {
      /* already exited */
    }
  };
  fsBtn?.addEventListener("click", () => (isFs() ? exitFs() : enterFs()));
  document.addEventListener("fullscreenchange", paintFsBtn);
  document.addEventListener("webkitfullscreenchange", paintFsBtn);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inPseudoFs()) setPseudoFs(false);
  });
  v.addEventListener("webkitendfullscreen", paintFsBtn);
  // A rotating phone mid-lecture: keep the stage fitted to the new box.
  window.addEventListener("orientationchange", () => setTimeout(paintFsBtn, 60));
  $("#allenRetry").addEventListener("click", () => currentLecture?.retry?.());

  // Popup menus (Speed / Quality) driving the hidden selects.
  const bindMenu = (btnId, menuId) => {
    const btn = $(btnId);
    const menu = $(menuId);
    if (!btn || !menu) return { btn, menu };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".ap-menu").forEach((m) => {
        if (m !== menu) m.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) menu.hidden = true;
    });
    return { btn, menu };
  };
  const speed = bindMenu("#allenSpeedBtn", "#allenSpeedMenu");
  speed.menu?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-speed]");
    if (!item) return;
    v.playbackRate = Number(item.dataset.speed) || 1;
    saveSettings({ rate: v.playbackRate });
    speed.menu.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === item));
    speed.btn.textContent = `Speed · ${item.dataset.speed}×`;
    speed.menu.hidden = true;
  });
  const qualityMenuApi = bindMenu("#allenQualityBtn", "#allenQualityMenu");
  qualityMenuApi.menu?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-quality]");
    if (!item) return;
    const sel = $("#allenQuality");
    sel.value = item.dataset.quality;
    saveSettings({ quality: Number(item.dataset.quality) });
    sel.dispatchEvent(new Event("change"));
    qualityMenuApi.menu.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === item));
    qualityMenuApi.btn.textContent = `Quality · ${item.textContent.trim()}`;
    qualityMenuApi.menu.hidden = true;
  });

  /* ---- Pro X: QoE console, seek FX, cinema mode ---- */
  const statsPanel = $("#allenStatsPanel");
  const paintStatsPanel = () => {
    if (!statsPanel || statsPanel.hidden) return;
    const set = (id, val) => {
      const el = $(id);
      if (el) el.textContent = val;
    };
    set("#allenStRes", v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : "—");
    const lv = hls && hls.levels && hls.levels[hls.currentLevel];
    set(
      "#allenStBitrate",
      lv ? `${Math.round((lv.bitrate || 0) / 1000)} kbps${hls.autoLevelEnabled ? " (auto)" : ""}` : "native"
    );
    let ahead = 0;
    try {
      for (let i = 0; i < v.buffered.length; i += 1) {
        if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
          ahead = v.buffered.end(i) - v.currentTime;
          break;
        }
      }
    } catch {
      /* no ranges yet */
    }
    set("#allenStBuffer", `${ahead.toFixed(1)}s`);
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    set("#allenStDropped", q ? `${q.droppedVideoFrames} / ${q.totalVideoFrames}` : "—");
    const conn = navigator.connection || {};
    set("#allenStNet", conn.effectiveType ? `${conn.effectiveType}${conn.saveData ? " · data-saver" : ""}` : "—");
    set("#allenStEngine", hls ? "hls.js · ABR" : "native");
  };
  setInterval(paintStatsPanel, 500);
  const toggleStats = () => {
    if (!statsPanel) return;
    statsPanel.hidden = !statsPanel.hidden;
    $("#allenStatsBtn")?.classList.toggle("on", !statsPanel.hidden);
    paintStatsPanel();
  };
  $("#allenStatsBtn")?.addEventListener("click", toggleStats);
  $("#allenCinemaBtn")?.addEventListener("click", (e) => {
    const on = document.body.classList.toggle("allen-cinema");
    e.currentTarget.classList.toggle("on", on);
  });
  // Double-tap / double-click seek with a ripple readout. Single
  // click still toggles play (the two toggles of a double-click
  // cancel out), which is the pattern every big player uses.
  const seekFx = (side) => {
    const el = side < 0 ? $("#allenSeekFxL") : $("#allenSeekFxR");
    if (!el) return;
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  };
  v.addEventListener("dblclick", (e) => {
    const r = v.getBoundingClientRect();
    const dir = e.clientX - r.left < r.width / 2 ? -1 : 1;
    seekBy(dir * 10);
    seekFx(dir);
  });

  document.addEventListener("keydown", (e) => {
    if ($("#allenWatch").hidden) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    const key = e.key;
    if (key === " " || key.toLowerCase() === "k") {
      e.preventDefault();
      v.paused ? v.play() : v.pause();
    } else if (key === "ArrowRight" || key.toLowerCase() === "l") seekBy(10);
    else if (key === "ArrowLeft" || key.toLowerCase() === "j") seekBy(-10);
    else if (key === "ArrowUp") {
      e.preventDefault();
      v.volume = Math.min(1, v.volume + 0.1);
      saveSettings({ volume: v.volume });
    } else if (key === "ArrowDown") {
      e.preventDefault();
      v.volume = Math.max(0, v.volume - 0.1);
      saveSettings({ volume: v.volume });
    } else if (key.toLowerCase() === "m") v.muted = !v.muted;
    else if (key.toLowerCase() === "p") $("#allenPip").click();
    else if (key.toLowerCase() === "i") toggleStats();
    else if (key.toLowerCase() === "f") $("#allenFull").click();
    else if (/^[0-9]$/.test(key) && v.duration) v.currentTime = (Number(key) / 10) * v.duration;
  });
}

async function watch(batch, subject, lec, isRetry = false) {
  $("#allenBatch").hidden = true;
  $("#allenContinueWrap").hidden = true;
  $("#allenWatch").hidden = false;
  $("#allenWatchTitle").textContent = lec.title;
  $("#allenWatchMeta").textContent = [subject.name, batch.name, lec.date, lec.duration].filter(Boolean).join(" · ");
  const stageTitle = $("#allenStageTitle");
  if (stageTitle) stageTitle.textContent = lec.title;
  const stageDur = $("#allenStageDur");
  if (stageDur) stageDur.textContent = lec.duration || "";
  if (!currentChapter || !currentChapter.lectures.some((l) => l.id === lec.id)) {
    currentChapter = { batch, subject, topic: { name: "" }, lectures: [lec] };
  }
  currentLecture = { id: lec.id, retry: () => watch(batch, subject, lec, true) };
  watchRetriedOnce = isRetry;
  paintUpNext();
  $("#allenWatch").scrollIntoView({ behavior: "smooth" });

  const v = video();
  destroyHls();
  v.removeAttribute("src");
  v.load();
  const audioBadge = $("#allenAudioBadge");
  if (audioBadge) audioBadge.classList.remove("on");
  if (!lec.playUrl) {
    setNote("This lecture carries no play address upstream.");
    return;
  }
  if (lec.thumbnail) v.poster = `/api/media?url=${encodeURIComponent(lec.thumbnail)}`;
  setNote("Token le rahe hain…");
  const startedAt = Date.now();
  const out = await api(`/api/allen?view=play&play=${encodeURIComponent(lec.playUrl)}`);
  if (!out.success || !(out.proxyUrl || out.url)) {
    // Their player's own fallback: route the token through the proxy.
    out.success = true;
    out.url = lec.playUrl;
    out.proxyUrl = `/api/allen?view=playlist&u=${encodeURIComponent(lec.playUrl)}`;
  }
  const history = readJson(historyKey, []);
  history.unshift({ code: batch.code, subject: subject.name, title: lec.title, at: Date.now() });
  try {
    localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 50)));
  } catch {
    /* private mode */
  }
  paintContinue();

  const src = out.proxyUrl || out.url;
  const quality = $("#allenQuality");
  quality.replaceChildren();
  const autoOpt = document.createElement("option");
  autoOpt.value = "-1";
  autoOpt.textContent = "Auto";
  quality.appendChild(autoOpt);
  const qMenu = $("#allenQualityMenu");
  if (qMenu) {
    qMenu.querySelectorAll("[data-quality]:not([data-quality='-1'])").forEach((b) => b.remove());
    const qb = $("#allenQualityBtn");
    if (qb) qb.textContent = "Quality · Auto";
  }

  setNote("Playlist load ho rahi hai — fast start…");
  const looksHls = /\.m3u8($|\?)/i.test(out.url || "") || Boolean(out.proxyUrl);
  if (window.Hls && window.Hls.isSupported() && looksHls && !/\.mp4($|\?)/i.test(out.url || "")) {
    // Network-aware start (Pro X): a data-saver or 2G/3G connection
    // opens on the lowest rung and climbs, instead of stalling on
    // the top rendition while the ABR engine measures. Everyone
    // else keeps the measuring start.
    const conn = navigator.connection || {};
    const slowNet = Boolean(conn.saveData) || /^(slow-)?2g$|^3g$/.test(conn.effectiveType || "");
    hls = new window.Hls({
      enableWorker: true,
      startLevel: slowNet ? 0 : -1,
      capLevelToPlayerSize: true,
      maxBufferLength: 60,
      maxMaxBufferLength: 240,
      backBufferLength: 20,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 350,
      fragLoadingMaxRetryTimeout: 3500,
      manifestLoadingMaxRetry: 3,
      levelLoadingMaxRetry: 4,
      testBandwidth: true,
    });
    let fatalRetries = 0;
    let nativeTried = false;
    let firstFragAt = 0;
    hls.on(window.Hls.Events.MANIFEST_LOADED, () => setNote("Playlist mil gayi — stream jod rahe hain…"));
    hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
      if (audioBadge && (data?.audioTracks?.length || 0) > 0) audioBadge.classList.add("on");
    });
    hls.on(window.Hls.Events.FRAG_LOADED, () => {
      if (!firstFragAt) {
        firstFragAt = Date.now();
        setNote(`⚡ Fast load — ${((firstFragAt - startedAt) / 1000).toFixed(1)}s me stream shuru.`);
        setTimeout(() => {
          if (!video().paused) setNote("");
        }, 2500);
      }
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      // The student's own quality choice outranks Auto when it
      // still exists in this lecture's ladder.
      const savedQ = loadSettings().quality;
      if (typeof savedQ === "number" && savedQ >= 0 && (hls.levels || [])[savedQ]) {
        hls.currentLevel = savedQ;
        quality.value = String(savedQ);
        const qb = $("#allenQualityBtn");
        if (qb) {
          const lv = hls.levels[savedQ];
          qb.textContent = `Quality · ${lv.height ? `${lv.height}p` : `${Math.round((lv.bitrate || 0) / 1000)}k`}`;
        }
      }
      (hls.levels || []).forEach((lv, i) => {
        const label = lv.height ? `${lv.height}p` : `${Math.round((lv.bitrate || 0) / 1000)}k`;
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = label;
        quality.appendChild(o);
        if (qMenu) {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.quality = String(i);
          b.textContent = label;
          qMenu.appendChild(b);
        }
      });
    });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data?.fatal) return;
      reportStage(data.type || "fatal", `${data.details || ""} ${data.response?.code || ""}`.trim());
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        fatalRetries += 1;
        if (fatalRetries <= 4) {
          setNote(`Stream error (${data.details || "network"}) — retry ${fatalRetries}/4…`);
          hls.startLoad();
        } else if (currentLecture?.retry && !watchRetriedOnce) {
          watchRetriedOnce = true;
          setNote("Fresh token se phir koshish…");
          currentLecture.retry();
        } else if (!nativeTried) {
          nativeTried = true;
          setNote("Native player se aakhri koshish…");
          destroyHls();
          v.src = src;
          v.play().catch(() =>
            setNote(`Lecture nahi chala (${data.details || "stream error"}) — ↻ dabao ya doosra lecture try karo.`)
          );
        } else {
          setNote(`Lecture nahi chala (${data.details || "stream error"}) — ↻ dabao ya doosra lecture try karo.`);
        }
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        setNote(`Playback atak gaya (${data.details || "media error"}) — ↻ dabao, token fresh milega.`);
      }
    });
    hls.loadSource(src);
    hls.attachMedia(v);
  } else {
    v.src = src;
  }
  paintPlayBtn();
  v.play().catch(() => paintPlayBtn());
}

/* ---------------- wiring ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  // Every subsystem wires in its own fault cell. The catalogue is the
  // page; the player is furniture. A throw in the furniture (a stale
  // cached page missing a new button, an exotic browser missing an
  // API) must never again leave a student staring at an empty grid —
  // that exact failure is why this isolation exists.
  const wire = (fn) => {
    try {
      fn();
    } catch (err) {
      reportStage("wire", err?.message || String(err));
    }
  };
  wire(wirePlayer);
  wire(() => {
  $("#allenSearch").addEventListener("input", renderGrid);
  $("#allenSort").addEventListener("change", (e) => {
    sortBy = e.target.value;
    renderGrid();
  });
  $("#allenExamChips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-exam]");
    if (!btn) return;
    exam = btn.dataset.exam;
    document.querySelectorAll("#allenExamChips [data-exam]").forEach((b) => {
      b.classList.toggle("on", b.dataset.exam === exam);
    });
    renderGrid();
  });
  $("#allenSavedTab").addEventListener("click", () => {
    showSaved = !showSaved;
    $("#allenSavedTab").classList.toggle("on", showSaved);
    renderGrid();
  });
  $("#allenBack").addEventListener("click", () => {
    $("#allenBatch").hidden = true;
    $("#allenCatalogue").hidden = false;
    paintContinue();
  });
  $("#allenWatchBack").addEventListener("click", () => {
    const v = video();
    v.pause();
    destroyHls();
    currentLecture = null;
    $("#allenWatch").hidden = true;
    $("#allenBatch").hidden = false;
  });
  // Poster tilt (Allen Ultra): cards lean a few degrees toward the
  // pointer — enough to feel physical, never enough to fight the
  // click. Hover-capable pointers only; touch keeps the flat grid.
  if (matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches) {
    const grid = $("#allenGrid");
    grid.addEventListener("pointermove", (e) => {
      const el = e.target.closest(".allen-card");
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty("--ry", `${(x * 5).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${(-y * 5).toFixed(2)}deg`);
    });
    grid.addEventListener("pointerout", (e) => {
      const el = e.target.closest(".allen-card");
      if (el) {
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
      }
    });
  }
  });
  loadCatalogue().catch(() => {
    const st = $("#allenStatus");
    if (st) {
      st.textContent = "The Allen catalogue could not load — check the connection and retry.";
      // A dead-end sentence helps nobody; give the failure a button.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "allen-retry-inline";
      btn.textContent = "Retry";
      btn.addEventListener("click", () => loadCatalogue().catch(() => {}));
      st.append(" ", btn);
    }
  });
});
