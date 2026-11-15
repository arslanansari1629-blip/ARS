/* Home page logic — live catalogue from the PW upstream */

import {
  mountChrome,
  toast,
  esc,
  money,
  debounce,
  skeletonCards,
  recentBatches,
  imageUrl,
  emptyState,
} from "./app.js";
import { loadCatalog as fetchCatalog, searchBatches } from "./data.js";
import { heartButton, wireFavourites } from "./favourites.js";
import { getLibrary } from "./library.js";

mountChrome("home");
wireFavourites();

const trendingGrid = document.getElementById("trendingGrid");
const catalogGrid = document.getElementById("catalogGrid");
const recentGrid = document.getElementById("recentGrid");
const recentSection = document.getElementById("recentSection");
const resultsBox = document.getElementById("heroSearchResults");

function batchCard(b) {
  const thumb = b.image
    ? `<img src="${esc(imageUrl(b.image))}" alt="" loading="lazy" onerror="this.remove()" />`
    : "";
  return `
    <a class="batch-card fade-up" href="/batch.html?id=${encodeURIComponent(b.id)}">
      <div class="batch-thumb">
        ${thumb}
        ${b.image ? "" : `<span class="placeholder">${esc((b.name || "PW").slice(0, 2).toUpperCase())}</span>`}
        ${b.feeTotal ? "" : `<span class="free">Free</span>`}
        ${heartButton(b)}
      </div>
      <div class="batch-body">
        <div class="batch-title">${esc(b.name)}</div>
        <div class="batch-sub">${esc(b.byName || "Physics Wallah batch")}</div>
        <div class="batch-meta">
          ${b.language ? `<span class="pill">${esc(b.language)}</span>` : ""}
          <span class="pill pill-brand">${esc(money(b.feeTotal))}</span>
        </div>
      </div>
    </a>`;
}

/* Exam goals: the front door's signposts. Each tile is a catalogue search
   that already works — no new route, just fewer decisions. */
const GOALS = [
  ["🧪", "JEE", "JEE", "Arjuna, Lakshya, Prayas…"],
  ["🧬", "NEET", "NEET", "Yakeen, Samarth…"],
  ["📚", "Class 12", "Class 12", "Boards + entrance together"],
  ["📖", "Class 11", "Class 11", "The foundation year"],
  ["⚙️", "GATE", "GATE", "Engineering entrances"],
  ["🏛️", "UPSC", "UPSC", "Civil services"],
  ["📋", "SSC", "SSC", "Government exams"],
  ["🏦", "Banking", "Bank", "Bank PO & clerk"],
  ["📊", "CAT / MBA", "CAT", "Management entrances"],
  ["🪖", "Defence", "NDA", "NDA & AFCAT"],
];
const goalGrid = document.getElementById("goalGrid");
if (goalGrid) {
  goalGrid.innerHTML = GOALS.map(
    ([emoji, label, q, sub]) => `
      <a class="goal-tile" href="/batches.html?q=${encodeURIComponent(q)}">
        <span class="goal-emoji" aria-hidden="true">${emoji}</span>
        <strong>${esc(label)}</strong><span>${esc(sub)}</span>
      </a>`
  ).join("");
}

/* Continue watching on the front door too: the dashboard has always known
   how far into a lecture you are (the player writes pos:<id>); the home
   page simply never asked. Same keys, same rail, no new storage. */
(function continueWatching() {
  const section = document.getElementById("continueSection");
  const rail = document.getElementById("continueRail");
  if (!section || !rail) return;
  let lectures = [];
  try {
    lectures = getLibrary().lectures || [];
  } catch {
    return;
  }
  const resumable = lectures
    .map((l) => ({ ...l, pos: Number(localStorage.getItem(`pos:${l.id}`) || 0) }))
    .filter((l) => l.pos > 12)
    .sort((a, b) => b.pos - a.pos)
    .slice(0, 6);
  if (!resumable.length) return;
  section.hidden = false;
  rail.innerHTML = resumable
    .map((l) => {
      const href = `/watch.html?batch=${encodeURIComponent(l.batch)}&subject=${encodeURIComponent(l.subject)}&id=${encodeURIComponent(l.id)}&title=${encodeURIComponent(l.title || "Lecture")}`;
      return `
        <a class="resume-card" href="${href}">
          <span class="resume-thumb">
            ${l.thumbnail ? `<img src="${esc(l.thumbnail)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="resume-ph">▶</span>`}
            <span class="resume-at">${Math.round(l.pos / 60)}m in</span>
          </span>
          <span class="resume-text">
            <strong>${esc(l.title || "Lecture")}</strong>
            <span class="tiny dim">${esc(l.chapter || l.subject || "")}</span>
          </span>
          <span class="resume-go">Resume</span>
        </a>`;
    })
    .join("");
})();

async function loadCatalog() {
  trendingGrid.innerHTML = skeletonCards(8);
  catalogGrid.innerHTML = skeletonCards(8);

  let page1;
  try {
    page1 = await fetchCatalog(1);
  } catch (err) {
    trendingGrid.innerHTML = emptyState(
      "Catalogue unreachable",
      err.message || "The PW catalogue could not be loaded right now."
    );
    catalogGrid.innerHTML = "";
    toast("Could not load the batch catalogue", "error");
    return;
  }

  const batches = page1.batches || [];
  trendingGrid.innerHTML = batches.slice(0, 8).map(batchCard).join("") || emptyState(
    "No batches found",
    "The upstream catalogue returned an empty page."
  );

  // second page for variety in the "browse" grid
  let page2 = { batches: [] };
  try {
    page2 = await fetchCatalog(2);
  } catch {
    /* ignore — page 1 is enough */
  }
  const combined = [...batches.slice(8), ...(page2.batches || [])].slice(0, 12);
  catalogGrid.innerHTML = combined.map(batchCard).join("") || trendingGrid.innerHTML;

  const totalEl = document.getElementById("statSubjects");
  if (totalEl && page1.total) {
    totalEl.textContent = page1.total.toLocaleString("en-IN");
    totalEl.nextElementSibling.textContent = "batches live";
  }
}

function renderRecent() {
  const list = recentBatches();
  if (!list.length) {
    recentSection.hidden = true;
    return;
  }
  recentSection.hidden = false;
  recentGrid.innerHTML = list
    .map(
      (b) => `
      <a class="batch-card fade-up" href="/batch.html?id=${encodeURIComponent(b.id)}">
        <div class="batch-thumb">
          ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="placeholder">${esc((b.name || "PW").slice(0, 2).toUpperCase())}</span>`}
          ${heartButton(b)}
        </div>
        <div class="batch-body"><div class="batch-title">${esc(b.name)}</div></div>
      </a>`
    )
    .join("");
}

const heroInput = document.getElementById("heroSearchInput");
const heroForm = document.getElementById("heroSearch");

async function runSearch(term) {
  if (!term || term.trim().length < 2) {
    resultsBox.classList.add("hide");
    return;
  }
  resultsBox.classList.remove("hide");
  resultsBox.innerHTML = `<div class="pad-row" class="tiny dim">Searching “${esc(term)}”…</div>`;
  try {
    const out = await searchBatches(term);
    const list = (out.batches || []).slice(0, 6);
    if (!list.length) {
      resultsBox.innerHTML = `<div class="pad-row" class="tiny dim">No batches matched “${esc(term)}”.</div>`;
      return;
    }
    resultsBox.innerHTML =
      list
        .map(
          (b) => `
        <a href="/batch.html?id=${encodeURIComponent(b.id)}">
          ${b.image ? `<img src="${esc(b.image)}" alt="" onerror="this.remove()" />` : `<span class="ph"></span>`}
          <span class="grow truncate">${esc(b.name)}</span>
          <span class="pill">${esc(b.language || "PW")}</span>
        </a>`
        )
        .join("") +
      `<a href="/batches.html?q=${encodeURIComponent(term)}" class="tiny link">See all results →</a>`;
  } catch (err) {
    resultsBox.innerHTML = `<div class="pad-row" class="tiny dim">Search failed: ${esc(err.message)}</div>`;
  }
}

heroInput?.addEventListener("input", debounce((e) => runSearch(e.target.value), 420));
heroForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const term = heroInput.value.trim();
  if (term) location.href = `/batches.html?q=${encodeURIComponent(term)}`;
});
document.addEventListener("click", (e) => {
  if (!resultsBox) return;
  if (!resultsBox.contains(e.target) && e.target !== heroInput) {
    resultsBox.classList.add("hide");
  }
});

loadCatalog();
renderRecent();
