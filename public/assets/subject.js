/* Subject → chapter list */

import {
  mountChrome,
  esc,
  qs,
  toast,
  emptyState,
  setPageMeta,
  clamp,
  ORIGIN,
} from "./app.js";
import { loadBatch, loadChapters } from "./data.js";

mountChrome("batches");

const batchId = qs("batch");
const subjectSlug = qs("subject");
const subjectNameParam = qs("name");

const list = document.getElementById("list");
const subjectName = document.getElementById("subjectName");
const subjectMeta = document.getElementById("subjectMeta");
const crumbs = document.getElementById("crumbs");
const batchLink = document.getElementById("batchLink");
const listTools = document.getElementById("listTools");
const chapterFilter = document.getElementById("chapterFilter");
const filterCount = document.getElementById("filterCount");

/** Every chapter as loaded, so filtering is a repaint and never a refetch. */
let allChapters = [];

if (subjectNameParam) subjectName.textContent = subjectNameParam;
batchLink.href = `/batch.html?id=${encodeURIComponent(batchId)}`;

if (!batchId || !subjectSlug) {
  list.innerHTML = emptyState("Missing subject", "Pick a subject from a batch first.", `<a class="btn btn-primary" href="/batches.html">Browse batches</a>`);
} else {
  load();
}

function row(c, index) {
  const href = `/chapter.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
    subjectSlug
  )}&chapter=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}`;
  return `
    <a class="list-row chapter-row fade-up" href="${href}">
      <span class="index">${String(index + 1).padStart(2, "0")}</span>
      <span class="grow">
        <span class="title">${esc(c.name)}</span>
        <span class="counts">
          ${c.videos ? `<span class="count-chip v">${c.videos} lectures</span>` : ""}
          ${c.notes ? `<span class="count-chip n">${c.notes} notes</span>` : ""}
          ${c.exercises ? `<span class="count-chip">${c.exercises} DPP</span>` : ""}
          ${!c.videos && !c.notes && !c.exercises ? `<span class="count-chip">PDF only</span>` : ""}
        </span>
      </span>
      <svg class="chev" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

/**
 * Paint a chapter list. Filtering redraws from `allChapters`, so typing costs
 * no requests and the numbering keeps following the filtered set — a reader who
 * filters for "Rotational" wants "01" to mean the first match, not chapter 14.
 */
function renderList(chapters) {
  if (!chapters.length) {
    list.innerHTML = emptyState(
      "No chapter matches that",
      "Try a shorter word — chapter names are matched anywhere in the title.",
      `<button class="btn btn-ghost btn-sm" id="clearFilterBtn">Clear filter</button>`
    );
    document.getElementById("clearFilterBtn")?.addEventListener("click", () => {
      chapterFilter.value = "";
      applyFilter();
    });
    if (filterCount) filterCount.textContent = `0 of ${allChapters.length}`;
    return;
  }
  list.innerHTML = `<div class="list">${chapters.map(row).join("")}</div>`;
  if (filterCount) {
    filterCount.textContent =
      chapters.length === allChapters.length
        ? ""
        : `${chapters.length} of ${allChapters.length}`;
  }
}

function applyFilter() {
  const q = (chapterFilter?.value || "").trim().toLowerCase();
  if (!q) return renderList(allChapters);
  // Numbers match too: "ch 4" and "4" both find "Chapter 04".
  renderList(
    allChapters.filter((c) => {
      const hay = `${c.name || ""} ${c.id || ""}`.toLowerCase();
      if (hay.includes(q)) return true;
      // Numeric queries ("4") also match the chapter's own number.
      const digits = q.replace(/[^0-9]/g, "");
      return Boolean(digits) && hay.replace(/[^0-9]/g, "").includes(digits);
    })
  );
}

chapterFilter?.addEventListener("input", applyFilter);
// "/" focuses the filter, the way every other list on the web behaves.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || !chapterFilter || listTools?.hidden) return;
  const tag = (e.target && e.target.tagName) || "";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
  e.preventDefault();
  chapterFilter.focus();
});

async function load() {
  list.innerHTML = `<div class="list">${Array.from({ length: 6 })
    .map(() => `<div class="skeleton sk-row"></div>`)
    .join("")}</div>`;

  try {
    // batch meta for breadcrumbs (name)
    try {
      const b = await loadBatch(batchId);
      if (b.batch) {
        crumbs.innerHTML = `<a href="/">Home</a> <span>/</span> <a href="/batches.html">Batches</a> <span>/</span>
          <a href="/batch.html?id=${encodeURIComponent(batchId)}" class="truncate">${esc(b.batch.name)}</a> <span>/</span>
          <span>${esc(subjectNameParam || "Subject")}</span>`;
        document.title = `${subjectNameParam || b.batch.name} — ArsVibe PW`;
        setPageMeta({
          title: `${subjectNameParam || b.batch.name} — ArsVibe PW`,
          description: clamp(
            `${subjectNameParam || "This subject"} in ${b.batch.name}: every chapter, lecture, class note and DPP.`
          ),
          canonical: `${ORIGIN}/subject?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subjectSlug)}`,
        });
      }
    } catch {
      /* breadcrumb is cosmetic */
    }

    const out = await loadChapters(batchId, subjectSlug);
    const chapters = out.chapters || [];
    if (!chapters.length) {
      list.innerHTML = emptyState("No chapters yet", "This subject has no chapter list published yet. Check back after the next upload.");
      subjectMeta.textContent = "";
      return;
    }
    subjectMeta.textContent = `${chapters.length} chapters · click a chapter for lectures, notes and DPPs`;
    allChapters = chapters;
    renderList(chapters);
    if (listTools) listTools.hidden = chapters.length < 6;
  } catch (err) {
    list.innerHTML = emptyState("Could not load chapters", err.message);
    toast(err.message, "error");
  }
}
