/* Vidyakul native platform — catalogue → subjects → classes → player.
   All upstream decrypting happens server-side in /api/vidyakul;
   this file only renders clean JSON. Views are hash-routed:
   #/ (batches) · #/batch/<slug> · #/classes/<slug>?type=previous
*/
const view = document.getElementById("vkView");
const crumbs = document.getElementById("vkCrumbs");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (q) => {
  const r = await fetch(`/api/vidyakul?${q}`);
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.error || "request failed");
  return j;
};

let batchCache = new Map();

async function renderBatches(page = 1, append = false) {
  if (!append) view.innerHTML = `<p class="vk-msg">Loading batches…</p>`;
  crumbs.innerHTML = "";
  const data = await api(`view=batches&page=${page}`);
  for (const c of data.courses) batchCache.set(c.slug, c);
  const cards = data.courses.map((c) => `
    <a class="vk-card" href="#/batch/${encodeURIComponent(c.slug)}">
      ${c.image ? `<img loading="lazy" src="${esc(c.image)}" alt="" />` : ""}
      <h3>${esc(c.name)}</h3>
      <p>${esc(c.subjectsList || c.description || "")}</p>
      <div class="vk-meta"><span>${esc(c.language || "")}</span><span>${esc(c.totalClasses)} classes</span><span>${c.subjects.length} subjects</span></div>
      <span class="vk-cta">Let's Study →</span>
    </a>`).join("");
  const grid = `<div class="vk-grid">${cards}</div>`;
  const more = data.courses.length ? `<button class="vk-more" id="vkMore">Load more batches</button>` : `<p class="vk-msg">No more batches.</p>`;
  view.innerHTML = (append ? view.innerHTML.replace(/<button class="vk-more"[^>]*>.*?<\/button>/, "") : "") + grid + more;
  document.getElementById("vkMore")?.addEventListener("click", (e) => { e.target.remove(); renderBatches(page + 1, true); });
}

async function renderSearch(q) {
  view.innerHTML = `<p class="vk-msg">Searching…</p>`;
  const data = await api(`view=search&q=${encodeURIComponent(q)}`);
  for (const c of data.courses) if (c.slug) batchCache.set(c.slug, c);
  if (!data.courses.length) { view.innerHTML = `<p class="vk-msg">No batches found for “${esc(q)}”.</p>`; return; }
  view.innerHTML = `<div class="vk-grid">${data.courses.map((c) => `
    <a class="vk-card" href="#/batch/${encodeURIComponent(c.slug)}">
      ${c.image ? `<img loading="lazy" src="${esc(c.image)}" alt="" />` : ""}
      <h3>${esc(c.name)}</h3><p>${esc(c.subjectsList || "")}</p>
      <div class="vk-meta"><span>${esc(c.language || "")}</span><span>${esc(c.totalClasses)} classes</span></div>
      <span class="vk-cta">Let's Study →</span></a>`).join("")}</div>`;
}

async function findBatch(slug) {
  if (batchCache.has(slug)) return batchCache.get(slug);
  // Deep link: scan catalogue pages until the batch shows up.
  for (let p = 1; p <= 6; p++) {
    const data = await api(`view=batches&page=${p}`);
    for (const c of data.courses) batchCache.set(c.slug, c);
    if (batchCache.has(slug)) return batchCache.get(slug);
    if (!data.courses.length) break;
  }
  return null;
}

async function renderBatch(slug) {
  view.innerHTML = `<p class="vk-msg">Loading batch…</p>`;
  const batch = await findBatch(slug);
  crumbs.innerHTML = `<a href="#/">All batches</a> › <span>${esc(batch?.name || slug)}</span>`;
  if (!batch) { view.innerHTML = `<p class="vk-msg">Batch not found.</p>`; return; }
  view.innerHTML = `
    <div class="vk-batch-head">
      ${batch.image ? `<img src="${esc(batch.image)}" alt="" />` : ""}
      <div><h2>${esc(batch.name)}</h2><p>${esc(batch.description || batch.subjectsList || "")}</p>
      <div class="vk-meta"><span>${esc(batch.language || "")}</span><span>${esc(batch.totalClasses)} classes</span><span>${batch.subjects.length} subjects</span></div></div>
    </div>
    <h3 class="vk-h">Subjects — select one to view classes</h3>
    <div class="vk-grid">${batch.subjects.map((s) => `
      <a class="vk-card" href="#/classes/${encodeURIComponent(s.slug)}?type=previous&batch=${encodeURIComponent(slug)}">
        ${s.image ? `<img loading="lazy" src="${esc(s.image)}" alt="" />` : ""}
        <h3>${esc(s.name)}</h3>
        <div class="vk-meta"><span>${esc(s.totalClasses)}</span></div>
        <span class="vk-cta">View classes →</span></a>`).join("")}</div>`;
}

async function renderClasses(slug, type, batchSlug) {
  const batch = batchSlug ? await findBatch(batchSlug).catch(() => null) : null;
  const subject = batch?.subjects.find((s) => s.slug === slug);
  crumbs.innerHTML = `<a href="#/">All batches</a>${batch ? ` › <a href="#/batch/${encodeURIComponent(batchSlug)}">${esc(batch.name)}</a>` : ""} › <span>${esc(subject?.name || slug)}</span>`;
  view.innerHTML = `
    <h2 class="vk-h">${esc(subject?.name || "Classes")}</h2>
    <div class="vk-tabs">${["previous", "today", "upcoming"].map((t) => `<a class="${t === type ? "on" : ""}" href="#/classes/${encodeURIComponent(slug)}?type=${t}${batchSlug ? `&batch=${encodeURIComponent(batchSlug)}` : ""}">${t[0].toUpperCase() + t.slice(1)}</a>`).join("")}</div>
    <div id="vkClasses"><p class="vk-msg">Loading classes…</p></div>`;
  const data = await api(`view=classes&slug=${encodeURIComponent(slug)}&type=${encodeURIComponent(type)}`);
  const box = document.getElementById("vkClasses");
  if (!data.classes.length) { box.innerHTML = `<p class="vk-msg">No ${esc(type)} classes available.</p>`; return; }
  box.innerHTML = `<div class="vk-list">${data.classes.map((c) => `
    <article class="vk-class">
      <div><h3>${esc(c.title)}</h3><p>${esc(c.section || "")}</p>
      <div class="vk-meta"><span>${esc(c.teacher || "")}</span><span>${esc(c.dateTime || "")}</span>${c.language ? `<span>${esc(c.language)}</span>` : ""}</div></div>
      <button class="vk-watch" data-class="${esc(c.class_id)}" data-course="${esc(c.course_id)}" data-title="${esc(c.title)}" data-teacher="${esc(c.teacher || "")}" data-date="${esc(c.dateTime || "")}">▶ Watch</button>
    </article>`).join("")}</div>`;
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
  const data = await api(`view=play&class_id=${encodeURIComponent(d.class)}&course_id=${encodeURIComponent(d.course)}&title=${encodeURIComponent(d.title || "")}&teacher=${encodeURIComponent(d.teacher || "")}&date_time=${encodeURIComponent(d.date || "")}`);
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls();
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
function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [path, qs] = hash.split("?");
  const q = new URLSearchParams(qs || "");
  const parts = path.split("/").filter(Boolean);
  const run = (fn) => fn.catch((e) => { view.innerHTML = `<p class="vk-msg">Something went wrong: ${esc(e.message)}</p>`; });
  if (parts[0] === "batch" && parts[1]) run(renderBatch(decodeURIComponent(parts[1])));
  else if (parts[0] === "classes" && parts[1]) run(renderClasses(decodeURIComponent(parts[1]), q.get("type") || "previous", q.get("batch") || ""));
  else if (parts[0] === "search") run(renderSearch(q.get("q") || ""));
  else run(renderBatches());
}
window.addEventListener("hashchange", route);
document.getElementById("vkSearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = document.getElementById("vkSearchInput").value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});
route();
