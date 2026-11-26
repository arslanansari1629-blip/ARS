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

function card(batch) {
  const el = document.createElement("article");
  el.className = "allen-card";
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
  $("#allenGrid").replaceChildren(...rows.map(card));
  $("#allenStatus").textContent = rows.length
    ? `All Batches (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ""})`
    : all.length
      ? "No Allen batches match that filter."
      : "The Allen catalogue is quiet right now — it will recover on its own when the upstream answers again.";
}

function paintStats() {
  const set = (id, n) => {
    const el = $(id);
    if (el) el.textContent = String(n);
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
  paintStats();
  paintContinue();
  renderGrid();
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
  if (!subjects.length) {
    // One quiet retry before saying anything: upstream blips and a
    // stale cached page both look exactly like "no subjects" once.
    await new Promise((r) => setTimeout(r, 700));
    out = await api(subjectsUrl);
    subjects = Array.isArray(out.items) ? out.items : [];
  }
  const box = $("#allenSubjects");
  if (!subjects.length) {
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

/* ---------------- player v2 ---------------- */

const video = () => $("#allenVideo");

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
  // Paused state drives the whole overlay: top bar, center cluster
  // (−10s / play / +10s) and the control bar fade in together.
  $("#allenPlayerShell")?.classList.toggle("ap-paused", v.paused);
}

function paintUpNext() {
  const box = $("#allenUpNext");
  if (!box) return;
  const lectures = currentChapter?.lectures || [];
  box.replaceChildren(
    ...lectures.map((lec, i) => {
      const row = rowEl(i + 1, lec.title, `<span class="dur">${lec.duration || ""}</span>`, "");
      row.classList.toggle("now", currentLecture?.id === lec.id);
      row.addEventListener("click", () =>
        watch(currentChapter.batch, currentChapter.subject, lec)
      );
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

function wirePlayer() {
  const v = video();
  v.addEventListener("play", paintPlayBtn);
  v.addEventListener("pause", paintPlayBtn);
  v.addEventListener("timeupdate", () => {
    const d = v.duration || 0;
    $("#allenProgressFill").style.width = d ? `${(v.currentTime / d) * 100}%` : "0%";
    $("#allenTime").textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
    // Resume memory, throttled: one write every five seconds of play.
    if (currentLecture && v.currentTime > 5 && Date.now() - lastSaveAt > 5000) {
      lastSaveAt = Date.now();
      try {
        localStorage.setItem(posKey(currentLecture.id), JSON.stringify({ t: v.currentTime, at: Date.now() }));
      } catch {
        /* private mode */
      }
    }
  });
  v.addEventListener("ended", () => stepLecture(1));
  v.addEventListener("loadedmetadata", () => {
    if (!currentLecture) return;
    const pos = readJson(posKey(currentLecture.id), null);
    if (pos && pos.t > 5 && v.duration && pos.t < v.duration - 10) {
      v.currentTime = pos.t;
      setNote(`Resumed from ${fmt(pos.t)} — jahan chhoda tha, wahi se.`);
    }
  });
  const spin = (on) => {
    const s = $("#allenSpin");
    if (s) s.hidden = !on;
  };
  v.addEventListener("waiting", () => spin(true));
  v.addEventListener("playing", () => spin(false));
  v.addEventListener("canplay", () => spin(false));
  v.addEventListener("error", () => spin(false));
  $("#allenPlayBtn").addEventListener("click", () => (v.paused ? v.play() : v.pause()));
  $("#allenBigPlay").addEventListener("click", () => v.play().catch(() => {}));
  $("#allenCBack")?.addEventListener("click", () => (v.currentTime = Math.max(0, v.currentTime - 10)));
  $("#allenCFwd")?.addEventListener("click", () => (v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10)));
  v.addEventListener("click", () => (v.paused ? v.play().catch(() => {}) : v.pause()));
  // Speed / Quality popup menus, driving the hidden selects so every
  // existing listener keeps working unchanged.
  const bindMenu = (btnId, menuId, label) => {
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
      if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });
    return { btn, menu };
  };
  const speed = bindMenu("#allenSpeedBtn", "#allenSpeedMenu");
  speed.menu?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-speed]");
    if (!item) return;
    const sel = $("#allenSpeed");
    sel.value = item.dataset.speed;
    sel.dispatchEvent(new Event("change"));
    if (![...sel.options].some((o) => o.value === item.dataset.speed)) v.playbackRate = Number(item.dataset.speed);
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
    sel.dispatchEvent(new Event("change"));
    qualityMenuApi.menu.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === item));
    qualityMenuApi.btn.textContent = `Quality · ${item.textContent.trim()}`;
    qualityMenuApi.menu.hidden = true;
  });
  $("#allenPrev").addEventListener("click", () => stepLecture(-1));
  $("#allenNext").addEventListener("click", () => stepLecture(1));
  $("#allenVol").addEventListener("input", (e) => (v.volume = Number(e.target.value)));
  $("#allenBack10").addEventListener("click", () => (v.currentTime = Math.max(0, v.currentTime - 10)));
  $("#allenFwd10").addEventListener("click", () => (v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10)));
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
  $("#allenFull").addEventListener("click", () => {
    const shell = $("#allenPlayerShell");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shell.requestFullscreen?.().catch(() => {});
  });
  $("#allenRetry").addEventListener("click", () => {
    if (currentLecture?.retry) currentLecture.retry();
  });
  document.addEventListener("keydown", (e) => {
    if ($("#allenWatch").hidden) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) return;
    if (e.key === " ") {
      e.preventDefault();
      v.paused ? v.play() : v.pause();
    } else if (e.key === "ArrowRight") v.currentTime += 10;
    else if (e.key === "ArrowLeft") v.currentTime -= 10;
    else if (e.key.toLowerCase() === "f") $("#allenFull").click();
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
  if (stageDur) stageDur.textContent = lec.duration ? `⏱ ${lec.duration}` : "";
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
  setNote("Asking the Allen upstream for the stream…");
  if (!lec.playUrl) {
    setNote("This lecture carries no play address upstream.");
    return;
  }
  if (lec.thumbnail) {
    v.poster = `/api/media?url=${encodeURIComponent(lec.thumbnail)}`;
  }
  const out = await api(`/api/allen?view=play&play=${encodeURIComponent(lec.playUrl)}`);
  // Fallback, their player's own method: their player.html loads the
  // token URL itself as the stream source. If our resolver could not
  // classify the answer, route the token URL through our playlist
  // proxy directly and let the proxy sniff the playlist out of it.
  if (!out.success || !(out.proxyUrl || out.url)) {
    out.success = true;
    out.url = lec.playUrl;
    out.proxyUrl = `/api/allen?view=playlist&u=${encodeURIComponent(lec.playUrl)}`;
    setNote("Direct stream mode — proxy se stream jor rahe hain…");
  }
  const history = readJson(historyKey, []);
  history.unshift({ code: batch.code, subject: subject.name, title: lec.title, at: Date.now() });
  try {
    localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 50)));
  } catch {
    /* private mode */
  }
  paintContinue();
  // Always our own proxy URL: playlists rewritten, segments relayed.
  const src = out.proxyUrl || out.url;
  const quality = $("#allenQuality");
  const mkOption = (label, value) => {
    const o = document.createElement("option");
    o.textContent = label;
    o.value = value;
    return o;
  };
  quality.replaceChildren(mkOption("Auto", "-1"));
  const qMenu = $("#allenQualityMenu");
  if (qMenu) {
    qMenu.querySelectorAll("[data-quality]:not([data-quality='-1'])").forEach((b) => b.remove());
    const qb = $("#allenQualityBtn");
    if (qb) qb.textContent = "Quality · Auto";
  }
  // Our proxy URL always serves a playlist (token URLs carry no
  // .m3u8 suffix, which is why name-matching alone starved hls.js
  // and left Chrome staring at an unplayable native source).
  const looksHls = /\.m3u8($|\?)/i.test(out.url || "") || Boolean(out.proxyUrl);
  if (window.Hls && window.Hls.isSupported() && looksHls && !/\.mp4($|\?)/i.test(out.url || "")) {
    // Buffer-free tuning: start on the estimated-best level, keep a
    // deep forward buffer so a lecture plays straight through, retry
    // fragments fast instead of stalling, and let the ABR breathe.
    hls = new window.Hls({
      enableWorker: true,
      startLevel: -1,
      capLevelToPlayerSize: false,
      maxBufferLength: 90,
      maxMaxBufferLength: 300,
      backBufferLength: 30,
      maxBufferSize: 120 * 1000 * 1000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 400,
      fragLoadingMaxRetryTimeout: 4000,
      manifestLoadingMaxRetry: 3,
      levelLoadingMaxRetry: 4,
      testBandwidth: true,
    });
    let fatalRetries = 0;
    let firstFrag = false;
    let nativeTried = false;
    const reportStage = (stage, detail) => {
      try {
        const payload = JSON.stringify({ where: "allen-player", stage, detail: String(detail || "").slice(0, 300), at: Date.now() });
        if (navigator.sendBeacon) navigator.sendBeacon("/api/client-error", payload);
      } catch {
        /* telemetry is best-effort */
      }
    };
    hls.on(window.Hls.Events.MANIFEST_LOADED, () => setNote("Playlist mil gayi — stream jod rahe hain…"));
    hls.on(window.Hls.Events.FRAG_LOADED, () => {
      if (!firstFrag) {
        firstFrag = true;
        setNote("");
      }
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      (hls.levels || []).forEach((lv, i) => {
        const label = lv.height ? `${lv.height}p` : `${Math.round((lv.bitrate || 0) / 1000)}k`;
        quality.appendChild(mkOption(label, String(i)));
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
          setNote(`Stream error (${data.details || "network"}) — retry ${fatalRetries}/4 ho raha hai…`);
          hls.startLoad();
        } else if (currentLecture?.retry && !watchRetriedOnce) {
          // Bounded: four in-place retries, then ONE fresh-token reload.
          watchRetriedOnce = true;
          setNote("Stream phir se jod rahe hain (fresh token)…");
          currentLecture.retry();
        } else if (!nativeTried) {
          // Last resort: hand the same proxy URL to the native engine
          // (Safari-style HLS) before declaring the lecture dark.
          nativeTried = true;
          setNote("Native player se aakhri koshish…");
          destroyHls();
          v.src = src;
          v.play().catch(() => setNote(`Lecture nahi chala (${data.details || "stream error"}) — ↻ dabao ya doosra lecture try karo.`));
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
  setNote("Playlist hamare proxy se load ho rahi hai…");
  paintPlayBtn();
  v.play().catch(() => paintPlayBtn());
}

/* ---------------- wiring ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  wirePlayer();
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
  loadCatalogue().catch(() => {
    $("#allenStatus").textContent = "The Allen catalogue could not load — check the connection and retry.";
  });
});
