/* Vidyakul native platform — catalogue → subjects → classes → player.
   All upstream decrypting happens server-side in /api/vidyakul;
   this file only renders clean JSON. Views are hash-routed:
   #/ (batches) · #/batch/<slug> · #/classes/<slug>?type=previous
   (No nested template literals — the build's module checker strips
   literals naively, and nesting would swallow real declarations.)
*/
const view = document.getElementById("vkView");
const crumbs = document.getElementById("vkCrumbs");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (q) => {
  const r = await fetch("/api/vidyakul?" + q);
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.error || "request failed");
  return j;
};

let batchCache = new Map();

function imgTag(src, cls) {
  if (!src) return "";
  return '<img loading="lazy" src="' + esc(src) + '" alt="" />';
}

function batchCard(c) {
  return '<a class="vk-card" href="#/batch/' + encodeURIComponent(c.slug) + '">'
    + imgTag(c.image)
    + "<h3>" + esc(c.name) + "</h3>"
    + "<p>" + esc(c.subjectsList || c.description || "") + "</p>"
    + '<div class="vk-meta"><span>' + esc(c.language || "") + "</span><span>" + esc(c.totalClasses) + " classes</span><span>" + c.subjects.length + " subjects</span></div>"
    + '<span class="vk-cta">Let\'s Study →</span></a>';
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
  return '<article class="vk-class"><div><h3>' + esc(c.title) + "</h3><p>" + esc(c.section || "") + "</p>"
    + '<div class="vk-meta"><span>' + esc(c.teacher || "") + "</span><span>" + esc(c.dateTime || "") + "</span>" + lang + "</div></div>"
    + '<button class="vk-watch" data-class="' + esc(c.class_id) + '" data-course="' + esc(c.course_id)
    + '" data-title="' + esc(c.title) + '" data-teacher="' + esc(c.teacher || "") + '" data-date="' + esc(c.dateTime || "") + '">▶ Watch</button></article>';
}

function tabLink(t, type, slug, batchSlug) {
  const label = t[0].toUpperCase() + t.slice(1);
  const batchPart = batchSlug ? "&batch=" + encodeURIComponent(batchSlug) : "";
  return '<a class="' + (t === type ? "on" : "") + '" href="#/classes/' + encodeURIComponent(slug) + "?type=" + t + batchPart + '">' + label + "</a>";
}

async function renderBatches(page = 1, append = false) {
  if (!append) view.innerHTML = '<p class="vk-msg">Loading batches…</p>';
  crumbs.innerHTML = "";
  const data = await api("view=batches&page=" + page);
  for (const c of data.courses) batchCache.set(c.slug, c);
  const grid = '<div class="vk-grid">' + data.courses.map(batchCard).join("") + "</div>";
  const more = data.courses.length
    ? '<button class="vk-more" id="vkMore">Load more batches</button>'
    : '<p class="vk-msg">No more batches.</p>';
  if (append) {
    const old = document.getElementById("vkMore");
    if (old) old.remove();
    view.insertAdjacentHTML("beforeend", grid + more);
  } else {
    view.innerHTML = grid + more;
  }
  const btn = document.getElementById("vkMore");
  if (btn) btn.addEventListener("click", () => { btn.remove(); renderBatches(page + 1, true); });
}

async function renderSearch(q) {
  view.innerHTML = '<p class="vk-msg">Searching…</p>';
  const data = await api("view=search&q=" + encodeURIComponent(q));
  for (const c of data.courses) if (c.slug) batchCache.set(c.slug, c);
  if (!data.courses.length) {
    view.innerHTML = '<p class="vk-msg">No batches found for "' + esc(q) + '".</p>';
    return;
  }
  view.innerHTML = '<div class="vk-grid">' + data.courses.map(batchCard).join("") + "</div>";
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
  view.innerHTML = '<p class="vk-msg">Loading batch…</p>';
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
  view.innerHTML = '<h2 class="vk-h">' + esc(subject ? subject.name : "Classes") + '</h2><div class="vk-tabs">' + tabs + '</div><div id="vkClasses"><p class="vk-msg">Loading classes…</p></div>';
  const data = await api("view=classes&slug=" + encodeURIComponent(slug) + "&type=" + encodeURIComponent(type));
  const box = document.getElementById("vkClasses");
  if (!data.classes.length) { box.innerHTML = '<p class="vk-msg">No ' + esc(type) + " classes available.</p>"; return; }
  box.innerHTML = '<div class="vk-list">' + data.classes.map(classCard).join("") + "</div>";
  box.querySelectorAll(".vk-watch").forEach((b) => b.addEventListener("click", () => play(b.dataset)));
}

/* ---------- player ---------- */
const player = document.getElementById("vkPlayer");
const video = document.getElementById("vkVideo");
let hls = null;
async function play(d) {
  document.getElementById("vkPlayerTitle").textContent = d.title || "Lecture";
  document.getElementById("vkPlayerMeta").textContent = [d.teacher, d.date].filter(Boolean).join(" · ");
  player.hidden = false;
  const q = "view=play&class_id=" + encodeURIComponent(d.class) + "&course_id=" + encodeURIComponent(d.course)
    + "&title=" + encodeURIComponent(d.title || "") + "&teacher=" + encodeURIComponent(d.teacher || "")
    + "&date_time=" + encodeURIComponent(d.date || "");
  const data = await api(q);
  const HlsCtor = window.Hls;
  if (HlsCtor && HlsCtor.isSupported()) {
    hls = new HlsCtor();
    hls.loadSource(data.videoUrl);
    hls.attachMedia(video);
  } else {
    video.src = data.videoUrl;
  }
  video.play().catch(() => {});
}
document.getElementById("vkPlayerClose").addEventListener("click", () => {
  player.hidden = true;
  video.pause();
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute("src");
});

/* ---------- routing ---------- */
function go(promise) {
  promise.catch((e) => { view.innerHTML = '<p class="vk-msg">Something went wrong: ' + esc(e.message) + "</p>"; });
}
function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const splitAt = hash.indexOf("?");
  const path = splitAt >= 0 ? hash.slice(0, splitAt) : hash;
  const q = new URLSearchParams(splitAt >= 0 ? hash.slice(splitAt + 1) : "");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "batch" && parts[1]) go(renderBatch(decodeURIComponent(parts[1])));
  else if (parts[0] === "classes" && parts[1]) go(renderClasses(decodeURIComponent(parts[1]), q.get("type") || "previous", q.get("batch") || ""));
  else if (parts[0] === "search") go(renderSearch(q.get("q") || ""));
  else go(renderBatches());
}
window.addEventListener("hashchange", route);
document.getElementById("vkSearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("vkSearchInput").value.trim();
  if (q) location.hash = "#/search?q=" + encodeURIComponent(q);
});
route();
