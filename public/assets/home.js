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

mountChrome("home");

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
