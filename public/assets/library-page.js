/* Library page — batches / lectures / PDFs saved locally */

import { mountChrome, esc, fmtRelative, emptyState, toast } from "./app.js";
import { getLibrary, clearLibrary } from "./library.js";
import { heartButton, wireFavourites } from "./favourites.js";

mountChrome("library");
wireFavourites();

const body = document.getElementById("body");
const tabs = document.getElementById("tabs");
let tab = "batches";

function render() {
  const lib = getLibrary();

  if (tab === "batches") {
    body.innerHTML = lib.batches.length
      ? `<div class="grid grid-batches">${lib.batches
          .map(
            (b) => `
          <a class="batch-card fade-up" href="/batch.html?id=${encodeURIComponent(b.id)}">
            <div class="batch-thumb">
              ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="placeholder">${esc((b.name || "PW").slice(0, 2).toUpperCase())}</span>`}
              ${heartButton(b)}
            </div>
            <div class="batch-body">
              <div class="batch-title">${esc(b.name)}</div>
              <div class="tiny dim">${esc(fmtRelative(new Date(b.at).toISOString()))}</div>
            </div>
          </a>`
          )
          .join("")}</div>`
      : emptyState("No saved batches", "Batches you open will be listed here.", `<a class="btn btn-primary btn-sm" href="/batches.html">Browse batches</a>`);
    return;
  }

  if (tab === "lectures") {
    body.innerHTML = lib.lectures.length
      ? `<div class="list">${lib.lectures
          .map(
            (l) => `
          <a class="list-row" href="/lecture.html?batch=${encodeURIComponent(l.batch)}&subject=${encodeURIComponent(
              l.subject
            )}&id=${encodeURIComponent(l.id)}&title=${encodeURIComponent(l.title || "Lecture")}">
            <span class="index">▶</span>
            <span class="grow">
              <span class="title">${esc(l.title || "Lecture")}</span>
              <span class="meta">${esc(l.chapter || "")}${l.chapter ? " · " : ""}${esc(fmtRelative(new Date(l.at).toISOString()))}</span>
            </span>
          </a>`
          )
          .join("")}</div>`
      : emptyState("No lectures yet", "Lectures you open appear here.", `<a class="btn btn-primary btn-sm" href="/batches.html">Find a batch</a>`);
    return;
  }

  body.innerHTML = lib.docs.length
    ? `<div class="list">${lib.docs
        .map(
          (d) => `
        <div class="doc-row">
          <span class="pdf">PDF</span>
          <span class="grow">
            <span class="name">${esc(d.name || "Document")}</span>
            <span class="meta">${esc(fmtRelative(new Date(d.at).toISOString()))}</span>
          </span>
          <a class="btn btn-ghost btn-sm" href="/viewer.html?url=${encodeURIComponent(d.url)}&name=${encodeURIComponent(d.name || "Document")}" target="_blank" rel="noopener">Open</a>
        </div>`
        )
        .join("")}</div>`
    : emptyState("No PDFs yet", "Notes and DPPs you open are saved here.", `<a class="btn btn-primary btn-sm" href="/batches.html">Browse</a>`);
}

tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  tab = btn.dataset.tab;
  tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === btn));
  render();
});

document.getElementById("clearBtn").addEventListener("click", () => {
  clearLibrary();
  render();
  toast("Library cleared");
});

render();
