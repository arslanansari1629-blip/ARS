/* Chapter contents: lectures, notes (PDF), DPPs */

import { mountChrome, esc, qs, toast, emptyState, fmtDate } from "./app.js";
import { loadContents } from "./data.js";

mountChrome("batches");

const batchId = qs("batch");
const subjectSlug = qs("subject");
const chapterId = qs("chapter");
const chapterName = qs("name");

const body = document.getElementById("body");
const chapterNameEl = document.getElementById("chapterName");
const chapterMeta = document.getElementById("chapterMeta");
const crumbs = document.getElementById("crumbs");
const tabs = document.getElementById("tabs");

let type = "videos";
const cache = new Map();

if (chapterName) {
  chapterNameEl.textContent = chapterName;
  document.title = `${chapterName} — EduVibe PW`;
}

if (!batchId || !subjectSlug || !chapterId) {
  body.innerHTML = emptyState("Missing chapter", "Open a chapter from a subject page.", `<a class="btn btn-primary" href="/batches.html">Browse batches</a>`);
} else {
  buildCrumbs();
  load("videos");
}

function buildCrumbs() {
  crumbs.innerHTML = `<a href="/">Home</a> <span>/</span>
    <a href="/batch.html?id=${encodeURIComponent(batchId)}">Batch</a> <span>/</span>
    <a href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subjectSlug)}">Subject</a> <span>/</span>
    <span class="truncate">${esc(chapterName || "Chapter")}</span>`;
}

function watchUrl(item) {
  return `/lecture.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
    subjectSlug
  )}&id=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.title)}`;
}

/**
 * Flag whether a lecture actually has something to play.
 *
 * The chapter listing never contains the stream URL (that only comes from
 * `Schedule`), but it does say how the item was published: a `PDF`/`NOTES`
 * entry is material only, and a class without any rendition list or with a
 * pending status has no recording yet. Saying so on the row saves the user a
 * dead click into an empty player.
 */
function streamBadge(item) {
  const type = String(item.lectureType || "").toUpperCase();
  const status = String(item.status || "").toLowerCase();
  const renditions = Array.isArray(item.types) ? item.types : [];
  const hasStream = Boolean(item.videoId) || renditions.length > 0;

  if (/PDF|NOTE|DOC/.test(type)) {
    return `<span class="badge-soon">Notes only</span>`;
  }
  if (hasStream || /^(ready|completed|published)$/.test(status)) {
    return `<span class="badge-live">Video ready</span>`;
  }
  return `<span class="badge-soon">Recording pending</span>`;
}

function videoRow(item, index) {
  return `
    <a class="list-row fade-up" href="${watchUrl(item)}">
      <span class="index">${String(index + 1).padStart(2, "0")}</span>
      <span class="grow">
        <span class="title">${esc(item.title)}</span>
        <span class="meta">
          ${item.date ? `<span>${esc(fmtDate(item.date))}</span>` : ""}
          ${item.duration ? `<span>${esc(item.duration)}</span>` : ""}
          ${item.lectureType ? `<span>${esc(item.lectureType)}</span>` : ""}
          ${streamBadge(item)}
        </span>
      </span>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-2)" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" fill="var(--brand-2)" stroke="none"/></svg>
    </a>`;
}

function docRow(doc) {
  const viewer = `/viewer.html?url=${encodeURIComponent(doc.url)}&name=${encodeURIComponent(doc.name)}`;
  return `
    <div class="doc-row fade-up">
      <span class="pdf">PDF</span>
      <span class="grow">
        <span class="name">${esc(doc.name)}</span>
        <span class="meta">${esc(doc.topic || doc.note || "Document")}</span>
      </span>
      <a class="btn btn-ghost btn-sm" href="${viewer}" target="_blank" rel="noopener">Open</a>
      <a class="btn btn-ghost btn-sm" href="/api/media?url=${encodeURIComponent(doc.url)}" download>Download</a>
    </div>`;
}

function docItemRow(item) {
  const docs = item.docs || [];
  return `
    <div class="card fade-up" style="padding:.75rem">
      <div class="row between" style="margin-bottom:.5rem">
        <strong style="font-size:.88rem">${esc(item.title)}</strong>
        ${item.date ? `<span class="tiny dim">${esc(fmtDate(item.date))}</span>` : ""}
      </div>
      <div class="list" style="gap:.45rem">
        ${docs.map(docRow).join("") || `<div class="tiny dim" style="padding:.3rem">No file attached.</div>`}
      </div>
    </div>`;
}

async function load(nextType) {
  type = nextType;
  tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.type === type));

  if (cache.has(type)) return render(cache.get(type));

  body.innerHTML = `<div class="list">${Array.from({ length: 5 })
    .map(() => `<div class="skeleton" style="height:60px;border-radius:14px"></div>`)
    .join("")}</div>`;

  try {
    const out = await loadContents(batchId, subjectSlug, chapterId, type);
    cache.set(type, out.items || []);
    render(out.items || []);
  } catch (err) {
    body.innerHTML = emptyState("Could not load this section", err.message);
    toast(err.message, "error");
  }
}

function render(items) {
  if (!items.length) {
    const label = { videos: "lectures", notes: "notes", DppNotes: "DPPs", DppVideos: "DPP solutions" }[type];
    body.innerHTML = emptyState(`No ${label} yet`, "The source chapter has nothing published in this section.");
    chapterMeta.textContent = "";
    return;
  }

  if (type === "videos" || type === "DppVideos") {
    const label = type === "videos" ? "lectures" : "DPP solution videos";
    // Playability is decided per lecture by the source, not by this list, so
    // link the whole-chapter verification next to the count.
    const check =
      type === "videos"
        ? ` <a href="/api/check?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
            subjectSlug
          )}&chapter=${encodeURIComponent(chapterId)}" target="_blank" rel="noopener">verify playback →</a>`
        : "";
    chapterMeta.innerHTML = `${items.length} ${label}${check}`;
    body.innerHTML = `<div class="list">${items.map(videoRow).join("")}</div>`;
  } else {
    const total = items.reduce((n, i) => n + (i.docs ? i.docs.length : 0), 0);
    chapterMeta.textContent = `${total} PDF${total === 1 ? "" : "s"} available`;
    body.innerHTML = `<div class="list" style="gap:.7rem">${items.map(docItemRow).join("")}</div>`;
  }
}

tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  load(btn.dataset.type);
});
