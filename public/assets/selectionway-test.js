/* Selection Way — TEST MODE native client.
   Batches → topics/classes → player (HLS classLink + MP4 ladder +
   PDF notes), all through /api/selectionway. Deliberately unlinked
   from the landing: the platform goes live only on the operator's
   word. No nested template literals (build gate). */

const view = document.getElementById("swView");
const crumbs = document.getElementById("swCrumbs");
const player = document.getElementById("swPlayer");
const video = document.getElementById("swVideo");
const sourceSel = document.getElementById("swSource");
const HlsCtor = window.Hls;
let hls = null;
let allBatches = [];
let activeCategory = "All";
let currentPlay = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cache = new Map();

async function api(path) {
  if (cache.has(path)) return cache.get(path);
  const pending = fetch(path, { headers: { Accept: "application/json" } }).then(async (r) => {
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.success === false) throw new Error((data && data.error) || `Request failed (${r.status})`);
    return data;
  });
  cache.set(path, pending);
  try { return await pending; } catch (e) { cache.delete(path); throw e; }
}

function setCrumb(html) { crumbs.innerHTML = html; }
function skeleton(n) {
  let out = '<div class="sw-grid">';
  for (let i = 0; i < n; i++) out += '<div class="sw-skel"></div>';
  return out + "</div>";
}
function paintStats(patch) {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined) el.textContent = v; };
  set("swStatBatches", patch.batches);
  set("swStatClasses", patch.classes);
  set("swStatNotes", patch.notes);
  set("swStatCats", patch.cats);
}

function batchCard(b) {
  const meta = [];
  if (b.mainCategory) meta.push(esc(b.mainCategory));
  if (b.classesCount) meta.push(b.classesCount + " classes");
  if (b.isLive) meta.push("Live");
  if (b.isRecorded) meta.push("Recorded");
  if (b.isFree) meta.push("Free");
  const price = b.discountPrice > 0 ? "₹" + b.discountPrice : (b.isFree ? "Free" : "");
  return '<a class="sw-card" href="#/batch/' + encodeURIComponent(b.id) + '">' +
    (b.banner ? '<img loading="lazy" src="' + esc(b.banner) + '" alt="" />' : "") +
    "<h3>" + esc(b.title) + "</h3>" +
    (b.shortDescription ? "<p>" + esc(b.shortDescription) + "</p>" : "") +
    '<div class="sw-meta">' + meta.map((m) => "<span>" + m + "</span>").join("") + (price ? "<span>" + esc(price) + "</span>" : "") + "</div>" +
    (b.facultyName ? '<p class="sw-faculty">👨‍🏫 ' + esc(b.facultyName) + "</p>" : "") +
    '<span class="sw-cta">Let\'s Study →</span></a>';
}

function renderHome() {
  setCrumb("");
  const cats = ["All", ...new Set(allBatches.map((b) => b.mainCategory).filter(Boolean))].sort();
  const q = (document.getElementById("swSearchInput").value || "").toLowerCase().trim();
  const items = allBatches.filter((b) =>
    (activeCategory === "All" || b.mainCategory === activeCategory) &&
    (!q || (b.title + " " + b.categoryName + " " + b.facultyName).toLowerCase().includes(q)));
  let html = '<div class="sw-chips">' + cats.map((c) =>
    '<button type="button" class="sw-chip' + (c === activeCategory ? " on" : "") + '" data-cat="' + esc(c) + '">' + esc(c) + "</button>").join("") + "</div>";
  html += '<p class="sw-count">' + items.length + " batches</p>";
  html += items.length ? '<div class="sw-grid">' + items.map(batchCard).join("") + "</div>"
    : '<p class="sw-msg">No batches match — search ya category badal kar dekho.</p>';
  view.innerHTML = html;
  view.querySelectorAll("[data-cat]").forEach((chip) => chip.addEventListener("click", () => {
    activeCategory = chip.getAttribute("data-cat");
    renderHome();
  }));
  paintStats({ batches: String(allBatches.length), cats: String(cats.length - 1) });
}

async function showHome() {
  if (!allBatches.length) {
    view.innerHTML = skeleton(8);
    let data;
    try {
      data = await api("/api/selectionway?view=batches");
    } catch (e) {
      data = await api("/api/selectionway?view=batches");
    }
    allBatches = data.items || [];
  }
  renderHome();
}

let batchTopics = [];
let batchIdNow = "";

async function showBatch(batchId) {
  batchIdNow = batchId;
  setCrumb('<a href="#/">← All batches</a>');
  view.innerHTML = skeleton(6) + '<p class="sw-msg">Batch load ho raha hai — bade batches (1000+ classes) me kuch seconds lag sakte hain…</p>';
  let data;
  try {
    data = await api("/api/selectionway?view=classes&id=" + encodeURIComponent(batchId));
  } catch (e) {
    cache.delete("/api/selectionway?view=classes&id=" + encodeURIComponent(batchId));
    data = await api("/api/selectionway?view=classes&id=" + encodeURIComponent(batchId));
  }
  batchTopics = data.topics || [];
  const c = data.course || {};
  paintStats({ classes: String(data.totalClasses || 0), notes: String(data.totalNotes || 0) });
  let html = '<div class="sw-batch-head">' +
    (c.bannerWide || c.banner ? '<img src="' + esc(c.bannerWide || c.banner) + '" alt="" />' : "") +
    "<div><h2>" + esc(c.title || "Batch") + "</h2>" +
    (c.shortDescription ? "<p>" + esc(c.shortDescription) + "</p>" : "") +
    '<div class="sw-meta">' +
    (c.mainCategory ? "<span>" + esc(c.mainCategory) + "</span>" : "") +
    "<span>" + (data.totalClasses || 0) + " classes</span><span>" + (data.totalNotes || 0) + " notes</span>" +
    (c.validity ? "<span>" + esc(c.validity) + "</span>" : "") + "</div>" +
    (c.facultyName ? '<p class="sw-faculty">👨‍🏫 ' + esc(c.facultyName) + "</p>" : "") +
    "</div></div>";
  html += '<div class="sw-toolbar"><input id="swClassFilter" type="search" placeholder="Filter lectures in this batch…" aria-label="Filter lectures" /></div><div id="swTopics">';
  html += topicsHtml("");
  html += "</div>";
  view.innerHTML = html;
  const filter = document.getElementById("swClassFilter");
  let timer = null;
  filter.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      document.getElementById("swTopics").innerHTML = topicsHtml(filter.value.toLowerCase().trim());
      bindTopics();
    }, 200);
  });
  bindTopics();
}

/* Topics render as headers first; a topic's lecture rows are only
   built when it is opened (or when a search forces matches open) —
   a 1,300-class batch must not build 1,300 DOM rows up front. */
function topicsHtml(q) {
  let html = "";
  batchTopics.forEach((t, i) => {
    const classes = (t.classes || []).filter((c) => !q || (c.title + " " + c.teacherName + " " + c.sectionName).toLowerCase().includes(q));
    if (!classes.length) return;
    html += '<div class="sw-topic"><button type="button" class="sw-topic-head" data-topic="' + i + '">' +
      '<span>' + esc(t.topicName) + '</span><span class="sw-count">' + classes.length + ' lectures ▾</span></button>' +
      '<div class="sw-topic-body" data-body="' + i + '"' + (q ? "" : " hidden") + ">" + (q ? classesHtml(classes) : "") + "</div></div>";
  });
  return html || '<p class="sw-msg">No lectures match.</p>';
}

function classesHtml(classes) {
  let html = "";
  for (const c of classes) {
    const dur = c.duration ? Math.round(c.duration / 60) + " min" : "";
    const bits = [c.sectionName, c.teacherName, dur, c.pdfCount ? "📄 " + c.pdfCount : ""].filter(Boolean).join(" · ");
    html += '<div class="sw-class"><div><h4>' + esc(c.title) + "</h4><p>" + esc(bits) + "</p></div>" +
      (c.hasVideo ? '<button type="button" class="sw-watch" data-watch="' + esc(c.id) + '">▶ Watch</button>' : '<span class="sw-novideo">No video</span>') + "</div>";
  }
  return html;
}

function bindTopics() {
  view.querySelectorAll("[data-topic]").forEach((head) => head.addEventListener("click", () => {
    const i = head.getAttribute("data-topic");
    const body = view.querySelector('[data-body="' + i + '"]');
    if (!body) return;
    const open = body.hidden;
    body.hidden = !open;
    if (open && !body.innerHTML) {
      const q = (document.getElementById("swClassFilter")?.value || "").toLowerCase().trim();
      const t = batchTopics[Number(i)];
      const classes = (t.classes || []).filter((c) => !q || (c.title + " " + c.teacherName + " " + c.sectionName).toLowerCase().includes(q));
      body.innerHTML = classesHtml(classes);
      bindWatch();
    }
  }));
  bindWatch();
}

function bindWatch() {
  view.querySelectorAll("[data-watch]").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => openPlayer(batchIdNow, btn.getAttribute("data-watch")));
  });
}

function stopPlayer() {
  try { video.pause(); } catch { /* noop */ }
  if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
  video.removeAttribute("src");
  try { video.load(); } catch { /* noop */ }
}

const proxied = (u) => "/api/selectionway?view=proxy&url=" + encodeURIComponent(u);

function setSource(url) {
  stopPlayer();
  if (!url) return;
  url = proxied(url);
  if (/\.m3u8($|\?)/i.test(url) && HlsCtor && HlsCtor.isSupported()) {
    hls = new HlsCtor({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url;
  }
  video.play().catch(() => {});
}

async function openPlayer(batchId, classId) {
  player.hidden = false;
  document.getElementById("swPlayerTitle").textContent = "Loading…";
  document.getElementById("swPlayerMeta").textContent = "";
  document.getElementById("swPdfs").innerHTML = "";
  const data = await api("/api/selectionway?view=play&id=" + encodeURIComponent(batchId) + "&class=" + encodeURIComponent(classId));
  currentPlay = data;
  document.getElementById("swPlayerTitle").textContent = data.title || "Lecture";
  document.getElementById("swPlayerMeta").textContent = [data.topicName, data.teacherName].filter(Boolean).join(" · ");
  const opts = [];
  if (data.classLink) opts.push({ label: /\.m3u8($|\?)/i.test(data.classLink) ? "Auto (HLS)" : "Stream", url: data.classLink });
  for (const r of data.recordings || []) opts.push({ label: "MP4 " + (r.quality || ""), url: r.url });
  sourceSel.innerHTML = opts.map((o, i) => '<option value="' + i + '">' + esc(o.label) + "</option>").join("");
  sourceSel.onchange = () => {
    const o = opts[Number(sourceSel.value)] || opts[0];
    paintDownload(o);
    if (o) setSource(o.url);
  };
  paintDownload(opts[0]);
  if (opts[0]) setSource(opts[0].url);
  document.getElementById("swPdfs").innerHTML = (data.pdfs || []).map((p) =>
    '<a class="sw-pdf" href="' + esc(p.url) + '" target="_blank" rel="noopener">📄 ' + esc(p.name) + "</a>").join("");
}

function paintDownload(o) {
  const dl = document.getElementById("swDownload");
  if (o && /\.mp4($|\?)/i.test(o.url)) { dl.href = proxied(o.url); dl.hidden = false; } else { dl.hidden = true; }
}

function closePlayer() {
  stopPlayer();
  player.hidden = true;
  currentPlay = null;
}

document.getElementById("swPlayerClose").addEventListener("click", closePlayer);
player.addEventListener("click", (e) => { if (e.target === player) closePlayer(); });
document.getElementById("swSpeed").addEventListener("change", (e) => { video.playbackRate = Number(e.target.value) || 1; });
document.getElementById("swPip").addEventListener("click", () => { if (video.requestPictureInPicture) video.requestPictureInPicture().catch(() => {}); });
document.getElementById("swFs").addEventListener("click", () => {
  const box = player.querySelector(".sw-player-box");
  if (box && box.requestFullscreen) box.requestFullscreen().catch(() => {});
});
document.addEventListener("keydown", (e) => {
  if (player.hidden) return;
  if (e.key === "Escape") closePlayer();
  if (e.key === " ") { e.preventDefault(); video.paused ? video.play().catch(() => {}) : video.pause(); }
  if (e.key === "ArrowRight") video.currentTime += 10;
  if (e.key === "ArrowLeft") video.currentTime -= 10;
});

let searchTimer = null;
document.getElementById("swSearchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { if (!location.hash || location.hash === "#/") renderHome(); }, 250);
});
document.getElementById("swSearch").addEventListener("submit", (e) => {
  e.preventDefault();
  if (location.hash && location.hash !== "#/") location.hash = "#/";
  else renderHome();
});

function route() {
  const m = location.hash.match(/^#\/batch\/(.+)$/);
  const run = m ? showBatch(decodeURIComponent(m[1])) : showHome();
  run.catch((e) => {
    view.innerHTML = '<p class="sw-msg">Something went wrong: ' + esc(e.message) + ' <button type="button" class="sw-retry">Retry</button></p>';
    const retry = view.querySelector(".sw-retry");
    if (retry) retry.addEventListener("click", route);
  });
}
window.addEventListener("hashchange", route);
route();
