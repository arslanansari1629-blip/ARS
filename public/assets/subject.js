/* Subject → chapter list */

import { mountChrome, esc, qs, toast, emptyState } from "./app.js";
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
      }
    } catch {
      /* breadcrumb is cosmetic */
    }

    const out = await loadChapters(batchId, subjectSlug);
    const chapters = out.chapters || [];
    if (!chapters.length) {
      list.innerHTML = emptyState("No chapters yet", "This subject has no chapter list on the source site right now.");
      subjectMeta.textContent = "";
      return;
    }
    subjectMeta.textContent = `${chapters.length} chapters · click a chapter for lectures, notes and DPPs`;
    list.innerHTML = `<div class="list">${chapters.map(row).join("")}</div>`;
  } catch (err) {
    list.innerHTML = emptyState("Could not load chapters", err.message);
    toast(err.message, "error");
  }
}
