/* Vidyakul native platform v2 — catalogue → subjects → classes → Pro player.
   Engineering notes:
   · All upstream decrypting happens server-side in /api/vidyakul;
     this file only renders clean JSON (hash-routed views).
   · Responses are cached in-memory + sessionStorage (10 min TTL), so
     back-navigation and tab switches paint instantly.
   · Saved batches, watch history and per-lecture resume positions
     live in localStorage — the player picks up where you left off.
   · No nested template literals (the build's module checker strips
     literals naively); strings are concatenated on purpose.
*/
const view = document.getElementById("vkView");
const crumbs = document.getElementById("vkCrumbs");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- tiny storage helpers ---------- */
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/* ---------- cached API ---------- */
const memCache = new Map();
const CACHE_MS = 10 * 60 * 1000;
async function api(q) {
  const now = Date.now();
  const hit = memCache.get(q);
  if (hit && now - hit.at < CACHE_MS) return hit.data;
  try {
    const raw = sessionStorage.getItem("vkapi:" + q);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (now - parsed.at < CACHE_MS) { memCache.set(q, parsed); return parsed.data; }
    }
  } catch { /* storage unavailable */ }
  const r = await fetch("/api/vidyakul?" + q);
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.error || "request failed");
  const entry = { at: now, data: j };
  memCache.set(q, entry);
  try { sessionStorage.setItem("vkapi:" + q, JSON.stringify(entry)); } catch { /* quota */ }
  return j;
}

/* ---------- state ---------- */
let batchCache = new Map();
let savedSlugs = new Set(lsGet("ars:vk:saved", []));
let activeClassFilter = "All";
let loadedPages = 0;
let totalClassesSeen = 0;

function paintStats() {
  const b = document.getElementById("vkStatBatches");
  if (b) b.textContent = String(batchCache.size || "–");
  const c = document.getElementById("vkStatClasses");
  if (c) c.textContent = totalClassesSeen ? String(totalClassesSeen) : "–";
  const s = document.getElementById("vkStatSaved");
  if (s) s.textContent = String(savedSlugs.size);
  const w = document.getElementById("vkStatWatched");
  if (w) w.textContent = String(lsGet("ars:vk:recent", []).length);
}

function classOf(name) {
  const s = String(name || "");
  const m = s.match(/(?:कक्षा|class)\s*(6|7|8|9|10|11|12)/i) || s.match(/(?<![0-9])(6|7|8|9|10|11|12)(?:th|वीं)/i);
  return m ? "Class " + m[1] : "Other";
}

/* ---------- building blocks ---------- */
function imgTag(src) {
  if (!src) return "";
  return '<img loading="lazy" src="' + esc(src) + '" alt="" />';
}
function skeletonGrid(n) {
  let out = '<div class="vk-grid" aria-hidden="true">';
  for (let i = 0; i < n; i++) out += '<div class="vk-skel"></div>';
  return out + "</div>";
}
function saveBtn(slug) {
  const on = savedSlugs.has(slug);
  return '<button type="button" class="vk-save' + (on ? " on" : "") + '" data-save="' + esc(slug) + '" aria-label="Save batch">' + (on ? "★ Saved" : "☆ Save") + "</button>";
}
function batchCard(c) {
  const href = c.direct
    ? "#/classes/" + encodeURIComponent(c.slug) + "?type=previous"
    : "#/batch/" + encodeURIComponent(c.slug);
  const classesMeta = c.totalClasses ? "<span>" + esc(c.totalClasses) + " classes</span>" : "";
  const subjectsMeta = c.subjects && c.subjects.length ? "<span>" + c.subjects.length + " subjects</span>" : "";
  const langMeta = c.language ? "<span>" + esc(c.language) + "</span>" : "";
  return '<article class="vk-card-wrap">' + saveBtn(c.slug)
    + '<a class="vk-card" href="' + href + '">'
    + imgTag(c.image)
    + "<h3>" + esc(c.name) + "</h3>"
    + "<p>" + esc(c.subjectsList || c.description || "") + "</p>"
    + '<div class="vk-meta">' + langMeta + classesMeta + subjectsMeta + "</div>"
    + '<span class="vk-cta">Let\'s Study →</span></a></article>';
}
function subjectCard(s, batchSlug) {
  const href = "#/classes/" + encodeURIComponent(s.slug) + "?type=previous&batch=" + encodeURIComponent(batchSlug);
  return '<a class="vk-card" href="' + href + '">'
    + imgTag(s.image)
    + "<h3>" + esc(s.name) + "</h3>"
    + '<div class="vk-meta"><span>' + esc(s.totalClasses) + "</span></div>"
    + '<span class="vk-cta">View classes →</span></a>';
}
function classCard(c) {
  const lang = c.language ? "<span>" + esc(c.language) + "</span>" : "";
  const pos = Number(lsGet("ars:vk:pos:" + c.class_id, 0));
  const resume = pos > 30 ? '<span class="vk-resume">Resume ' + Math.floor(pos / 60) + "m</span>" : "";
  return '<article class="vk-class"><div><h3>' + esc(c.title) + "</h3><p>" + esc(c.section || "") + "</p>"
    + '<div class="vk-meta"><span>' + esc(c.teacher || "") + "</span><span>" + esc(c.dateTime || "") + "</span>" + lang + resume + "</div></div>"
    + '<button class="vk-watch" data-class="' + esc(c.class_id) + '" data-course="' + esc(c.course_id)
    + '" data-title="' + esc(c.title) + '" data-teacher="' + esc(c.teacher || "") + '" data-date="' + esc(c.dateTime || "") + '">▶ Watch</button></article>';
}
function tabLink(t, type, slug, batchSlug) {
  const label = t[0].toUpperCase() + t.slice(1);
  const batchPart = batchSlug ? "&batch=" + encodeURIComponent(batchSlug) : "";
  return '<a class="' + (t === type ? "on" : "") + '" href="#/classes/' + encodeURIComponent(slug) + "?type=" + t + batchPart + '">' + label + "</a>";
}
function bindSaveButtons(root) {
  root.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    const slug = b.getAttribute("data-save");
    if (savedSlugs.has(slug)) savedSlugs.delete(slug); else savedSlugs.add(slug);
    lsSet("ars:vk:saved", [...savedSlugs]);
    b.classList.toggle("on", savedSlugs.has(slug));
    b.textContent = savedSlugs.has(slug) ? "★ Saved" : "☆ Save";
    paintStats();
  }));
}
function recentRow() {
  const recent = lsGet("ars:vk:recent", []);
  if (!recent.length) return "";
  const cards = recent.map((r) =>
    '<article class="vk-class"><div><h3>' + esc(r.title) + '</h3><div class="vk-meta"><span>' + esc(r.teacher || "") + "</span><span>" + esc(r.date || "") + '</span></div></div>'
    + '<button class="vk-watch" data-class="' + esc(r.classId) + '" data-course="' + esc(r.courseId) + '" data-title="' + esc(r.title) + '" data-teacher="' + esc(r.teacher || "") + '" data-date="' + esc(r.date || "") + '">▶ Resume</button></article>'
  ).join("");
  return '<h3 class="vk-h">Continue watching</h3><div class="vk-list">' + cards + "</div>";
}
function bindWatchButtons(root) {
  root.querySelectorAll(".vk-watch").forEach((b) => b.addEventListener("click", () => play(b.dataset)));
}

/* ---------- views ---------- */
function filterChips(courses) {
  const present = new Set(courses.map((c) => classOf(c.name + " " + (c.subjectsList || ""))));
  const order = ["All", "Class 12", "Class 11", "Class 10", "Class 9", "Class 8", "Class 7", "Class 6", "Other", "Saved"];
  const chips = order
    .filter((f) => f === "All" || f === "Saved" || present.has(f))
    .map((f) => '<button type="button" class="vk-chip' + (f === activeClassFilter ? " on" : "") + '" data-filter="' + f + '">' + f + "</button>")
    .join("");
  return '<div class="vk-toolbar"><div class="vk-chips">' + chips + '</div><span class="vk-count" id="vkCount"></span></div>';
}
function applyFilter() {
  const cards = view.querySelectorAll(".vk-card-wrap");
  let shown = 0;
  cards.forEach((el) => {
    const slug = el.querySelector("[data-save]")?.getAttribute("data-save") || "";
    const course = batchCache.get(slug);
    const cls = course ? classOf(course.name + " " + (course.subjectsList || "")) : "Other";
    const ok = activeClassFilter === "All"
      || (activeClassFilter === "Saved" ? savedSlugs.has(slug) : cls === activeClassFilter);
    el.style.display = ok ? "" : "none";
    if (ok) shown++;
  });
  const count = document.getElementById("vkCount");
  if (count) count.textContent = shown + " batches";
}
function bindChips() {
  view.querySelectorAll("[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
    activeClassFilter = chip.getAttribute("data-filter");
    view.querySelectorAll("[data-filter]").forEach((c) => c.classList.toggle("on", c === chip));
    applyFilter();
  }));
}

async function renderBatches(page = 1, append = false) {
  if (!append) {
    view.innerHTML = recentRow() + '<div id="vkHomeBody">' + skeletonGrid(8) + "</div>";
    bindWatchButtons(view);
  }
  crumbs.innerHTML = "";
  const data = await api("view=batches&page=" + page);
  loadedPages = page;
  for (const c of data.courses) {
    batchCache.set(c.slug, c);
    totalClassesSeen += Number(String(c.totalClasses).replace(/[^0-9]/g, "")) || 0;
  }
  paintStats();
  const body = document.getElementById("vkHomeBody");
  if (!body) return;
  const grid = '<div class="vk-grid">' + data.courses.map(batchCard).join("") + "</div>";
  const more = data.courses.length
    ? '<button class="vk-more" id="vkMore">Load more batches</button>'
    : '<p class="vk-msg">No more batches.</p>';
  if (append) {
    const old = document.getElementById("vkMore");
    if (old) old.remove();
    body.insertAdjacentHTML("beforeend", grid + more);
  } else {
    body.innerHTML = filterChips([...batchCache.values()]) + grid + more;
    bindChips();
  }
  bindSaveButtons(body);
  applyFilter();
  const btn = document.getElementById("vkMore");
  if (btn) btn.addEventListener("click", () => { btn.remove(); renderBatches(page + 1, true); });
}

async function renderSearch(q) {
  view.innerHTML = skeletonGrid(6);
  const data = await api("view=search&q=" + encodeURIComponent(q));
  for (const c of data.courses) if (c.slug) batchCache.set(c.slug, c);
  paintStats();
  if (!data.courses.length) {
    view.innerHTML = '<p class="vk-msg">No batches found for "' + esc(q) + '". <a href="#/">Browse all batches</a></p>';
    return;
  }
  view.innerHTML = '<h2 class="vk-h">Results for "' + esc(q) + '"</h2><div class="vk-grid">' + data.courses.map(batchCard).join("") + "</div>";
  bindSaveButtons(view);
}

async function findBatch(slug) {
  if (batchCache.has(slug)) return batchCache.get(slug);
  for (let p = 1; p <= 6; p++) {
    const data = await api("view=batches&page=" + p);
    for (const c of data.courses) batchCache.set(c.slug, c);
    if (batchCache.has(slug)) return batchCache.get(slug);
    if (!data.courses.length) break;
  }
  return null;
}

async function renderBatch(slug) {
  view.innerHTML = skeletonGrid(6);
  const batch = await findBatch(slug);
  const name = batch ? batch.name : slug;
  crumbs.innerHTML = '<a href="#/">All batches</a> › <span>' + esc(name) + "</span>";
  if (!batch) { view.innerHTML = '<p class="vk-msg">Batch not found.</p>'; return; }
  const head = '<div class="vk-batch-head">' + imgTag(batch.image) + "<div><h2>" + esc(batch.name) + "</h2><p>"
    + esc(batch.description || batch.subjectsList || "") + '</p><div class="vk-meta"><span>' + esc(batch.language || "")
    + "</span><span>" + esc(batch.totalClasses) + " classes</span><span>" + batch.subjects.length + " subjects</span></div></div></div>";
  const cards = batch.subjects.map((s) => subjectCard(s, slug)).join("");
  view.innerHTML = head + '<h3 class="vk-h">Subjects — select one to view classes</h3><div class="vk-grid">' + cards + "</div>";
}

async function renderClasses(slug, type, batchSlug) {
  const batch = batchSlug ? await findBatch(batchSlug).catch(() => null) : null;
  const subject = batch ? batch.subjects.find((s) => s.slug === slug) : null;
  const batchCrumb = batch ? ' › <a href="#/batch/' + encodeURIComponent(batchSlug) + '">' + esc(batch.name) + "</a>" : "";
  crumbs.innerHTML = '<a href="#/">All batches</a>' + batchCrumb + " › <span>" + esc(subject ? subject.name : slug) + "</span>";
  const tabs = ["previous", "today", "upcoming"].map((t) => tabLink(t, type, slug, batchSlug)).join("");
  view.innerHTML = '<h2 class="vk-h">' + esc(subject ? subject.name : "Classes") + '</h2><div class="vk-tabs">' + tabs + '</div>'
    + '<div class="vk-toolbar"><input id="vkClassFilter" type="search" placeholder="Filter classes by title or teacher…" aria-label="Filter classes" /><span class="vk-count" id="vkClassCount"></span></div>'
    + '<div id="vkClasses">' + skeletonGrid(5) + "</div>";
  const data = await api("view=classes&slug=" + encodeURIComponent(slug) + "&type=" + encodeURIComponent(type));
  const box = document.getElementById("vkClasses");
  if (!box) return;
  if (!data.classes.length) { box.innerHTML = '<p class="vk-msg">No ' + esc(type) + " classes available.</p>"; return; }
  box.innerHTML = '<div class="vk-list">' + data.classes.map(classCard).join("") + "</div>";
  bindWatchButtons(box);
  const countEl = document.getElementById("vkClassCount");
  const paintCount = () => {
    const visible = box.querySelectorAll(".vk-class:not([style*='none'])").length;
    if (countEl) countEl.textContent = visible + " of " + data.classes.length + " classes";
  };
  paintCount();
  const filterInput = document.getElementById("vkClassFilter");
  if (filterInput) filterInput.addEventListener("input", () => {
    const q = filterInput.value.trim().toLowerCase();
    box.querySelectorAll(".vk-class").forEach((el) => {
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
    paintCount();
  });
}

/* ---------- Pro player ---------- */
const player = document.getElementById("vkPlayer");
const video = document.getElementById("vkVideo");
const qualitySel = document.getElementById("vkQuality");
const speedSel = document.getElementById("vkSpeed");
let hls = null;
let currentClassId = "";
let posTimer = null;

function rememberWatch(d) {
  const recent = lsGet("ars:vk:recent", []).filter((r) => r.classId !== d.class);
  recent.unshift({ classId: d.class, courseId: d.course, title: d.title || "Lecture", teacher: d.teacher || "", date: d.date || "", at: Date.now() });
  lsSet("ars:vk:recent", recent.slice(0, 8));
  paintStats();
}
function fillQualityLevels() {
  if (!hls) return;
  const levels = hls.levels || [];
  qualitySel.innerHTML = '<option value="-1">Auto</option>' + levels.map((lv, i) =>
    '<option value="' + i + '">' + (lv.height ? lv.height + "p" : Math.round(lv.bitrate / 1000) + " kbps") + "</option>"
  ).join("");
}
async function play(d) {
  document.getElementById("vkPlayerTitle").textContent = d.title || "Lecture";
  document.getElementById("vkPlayerMeta").textContent = [d.teacher, d.date].filter(Boolean).join(" · ");
  player.hidden = false;
  document.body.style.overflow = "hidden";
  currentClassId = d.class || "";
  rememberWatch(d);
  const startAt = Number(lsGet("ars:vk:pos:" + currentClassId, 0)) || 0;
  const q = "view=play&class_id=" + encodeURIComponent(d.class) + "&course_id=" + encodeURIComponent(d.course)
    + "&title=" + encodeURIComponent(d.title || "") + "&teacher=" + encodeURIComponent(d.teacher || "")
    + "&date_time=" + encodeURIComponent(d.date || "");
  const data = await api(q);
  const HlsCtor = window.Hls;
  if (HlsCtor && HlsCtor.isSupported()) {
    if (hls) hls.destroy();
    hls = new HlsCtor({ maxBufferLength: 60, capLevelToPlayerSize: true });
    hls.loadSource(data.videoUrl);
    hls.attachMedia(video);
    hls.on(HlsCtor.Events.MANIFEST_PARSED, fillQualityLevels);
  } else {
    video.src = data.videoUrl;
  }
  video.playbackRate = Number(speedSel.value) || 1;
  const seekResume = () => {
    if (startAt > 30 && video.duration && startAt < video.duration - 15) video.currentTime = startAt;
    video.removeEventListener("loadedmetadata", seekResume);
  };
  video.addEventListener("loadedmetadata", seekResume);
  video.play().catch(() => {});
  clearInterval(posTimer);
  posTimer = setInterval(() => {
    if (currentClassId && video.currentTime > 5 && !video.ended) lsSet("ars:vk:pos:" + currentClassId, Math.floor(video.currentTime));
  }, 5000);
}
function closePlayer() {
  player.hidden = true;
  document.body.style.overflow = "";
  video.pause();
  clearInterval(posTimer);
  if (currentClassId && video.currentTime > 5 && !video.ended) lsSet("ars:vk:pos:" + currentClassId, Math.floor(video.currentTime));
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute("src");
  currentClassId = "";
}
document.getElementById("vkPlayerClose").addEventListener("click", closePlayer);
player.addEventListener("click", (e) => { if (e.target === player) closePlayer(); });
qualitySel.addEventListener("change", () => { if (hls) hls.nextLevel = Number(qualitySel.value); });
speedSel.addEventListener("change", () => { video.playbackRate = Number(speedSel.value) || 1; });
document.getElementById("vkPip").addEventListener("click", () => {
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(() => {});
});
document.getElementById("vkFs").addEventListener("click", () => {
  const box = player.querySelector(".vk-player-box");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (box && box.requestFullscreen) box.requestFullscreen().catch(() => {});
});
video.addEventListener("ended", () => {
  if (currentClassId) try { localStorage.removeItem("ars:vk:pos:" + currentClassId); } catch { /* noop */ }
});
document.addEventListener("keydown", (e) => {
  if (player.hidden) return;
  if (e.key === "Escape") closePlayer();
  else if (e.key === " " || e.key === "k") { e.preventDefault(); if (video.paused) video.play().catch(() => {}); else video.pause(); }
  else if (e.key === "ArrowRight") video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
  else if (e.key === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 10);
  else if (e.key === "f") document.getElementById("vkFs").click();
  else if (e.key === "m") video.muted = !video.muted;
});

/* ---------- routing ---------- */
function go(promise) {
  promise.catch((e) => {
    view.innerHTML = '<p class="vk-msg">Something went wrong: ' + esc(e.message) + ' <button type="button" class="vk-retry">Retry</button></p>';
    const retry = view.querySelector(".vk-retry");
    if (retry) retry.addEventListener("click", () => route());
  });
}
function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const splitAt = hash.indexOf("?");
  const path = splitAt >= 0 ? hash.slice(0, splitAt) : hash;
  const q = new URLSearchParams(splitAt >= 0 ? hash.slice(splitAt + 1) : "");
  const parts = path.split("/").filter(Boolean);
  window.scrollTo({ top: 0 });
  if (parts[0] === "batch" && parts[1]) go(renderBatch(decodeURIComponent(parts[1])));
  else if (parts[0] === "classes" && parts[1]) go(renderClasses(decodeURIComponent(parts[1]), q.get("type") || "previous", q.get("batch") || ""));
  else if (parts[0] === "search") go(renderSearch(q.get("q") || ""));
  else if (batchCache.size) {
    // Back to home with a warm cache: repaint without refetching.
    loadedPages = Math.max(1, loadedPages);
    const keep = new Map(batchCache);
    view.innerHTML = recentRow() + '<div id="vkHomeBody"></div>';
    bindWatchButtons(view);
    batchCache = keep;
    const body = document.getElementById("vkHomeBody");
    body.innerHTML = filterChips([...batchCache.values()])
      + '<div class="vk-grid">' + [...batchCache.values()].map(batchCard).join("") + "</div>"
      + '<button class="vk-more" id="vkMore">Load more batches</button>';
    bindChips();
    bindSaveButtons(body);
    applyFilter();
    document.getElementById("vkMore").addEventListener("click", (e) => { e.target.remove(); renderBatches(loadedPages + 1, true); });
    paintStats();
  }
  else go(renderBatches());
}
window.addEventListener("hashchange", route);
const searchForm = document.getElementById("vkSearch");
const searchInput = document.getElementById("vkSearchInput");
let searchDebounce = null;
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q) location.hash = "#/search?q=" + encodeURIComponent(q);
});
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length < 3) return;
  searchDebounce = setTimeout(() => { location.hash = "#/search?q=" + encodeURIComponent(q); }, 450);
});
paintStats();
route();
