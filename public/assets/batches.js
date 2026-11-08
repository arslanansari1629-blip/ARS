/* All batches — paginated live catalogue with search / filter / sort */

import {
  mountChrome,
  esc,
  money,
  debounce,
  qs,
  toast,
  skeletonCards,
  emptyState,
} from "./app.js";
import { loadCatalog, searchBatches } from "./data.js";

mountChrome("batches");

const grid = document.getElementById("grid");
const pager = document.getElementById("pager");
const searchInput = document.getElementById("searchInput");
const langFilter = document.getElementById("langFilter");
const sortBy = document.getElementById("sortBy");
const resetBtn = document.getElementById("resetBtn");
const resultCount = document.getElementById("resultCount");

const state = {
  page: 1,
  search: qs("q") || "",
  lang: "",
  sort: "default",
  totalPages: 1,
  total: 0,
};

if (state.search) searchInput.value = state.search;

function card(b) {
  return `
    <a class="batch-card fade-up" href="/batch.html?id=${encodeURIComponent(b.id)}">
      <div class="batch-thumb">
        ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="placeholder">${esc((b.name || "PW").slice(0, 2).toUpperCase())}</span>`}
        ${b.feeTotal ? "" : `<span class="free">Free</span>`}
      </div>
      <div class="batch-body">
        <div class="batch-title">${esc(b.name)}</div>
        <div class="batch-sub">${esc(b.byName || "")}</div>
        <div class="batch-meta">
          ${b.language ? `<span class="pill">${esc(b.language)}</span>` : ""}
          <span class="pill pill-brand">${esc(money(b.feeTotal))}</span>
        </div>
      </div>
    </a>`;
}

function buildLangOptions(batches) {
  const langs = Array.from(new Set(batches.map((b) => b.language).filter(Boolean))).sort();
  const current = langFilter.value;
  langFilter.innerHTML =
    `<option value="">All languages</option>` +
    langs.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
  if (langs.includes(current)) langFilter.value = current;
}

function sortBatches(list) {
  if (state.sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
  if (state.sort === "newest") {
    return [...list].sort(
      (a, b) => new Date(b.startDate || 0).getTime() - new Date(a.startDate || 0).getTime()
    );
  }
  return list;
}

function renderPager() {
  if (state.search) {
    pager.innerHTML = "";
    return;
  }
  // The local catalogue is complete (≈14 200 batches / 711 pages), so the pager
  // has to reach the last page — it used to be capped at 700 arbitrarily.
  const total = Math.max(1, state.totalPages || 1);
  const cur = state.page;
  const nums = new Set([1, total, cur, cur - 1, cur + 1]);
  const list = Array.from(nums).filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);

  let html = `<button ${cur <= 1 ? "disabled" : ""} data-go="${cur - 1}">Prev</button>`;
  let prev = 0;
  for (const n of list) {
    if (prev && n - prev > 1) html += `<span class="dim">…</span>`;
    html += `<button class="${n === cur ? "active" : ""}" data-go="${n}">${n}</button>`;
    prev = n;
  }
  html += `<button ${cur >= total ? "disabled" : ""} data-go="${cur + 1}">Next</button>`;
  pager.innerHTML = html;

  pager.querySelectorAll("button[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.go);
      if (!n || n < 1 || n > total || n === state.page) return;
      state.page = n;
      load();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

async function load() {
  grid.innerHTML = skeletonCards(12);
  pager.innerHTML = "";

  try {
    if (state.search) {
      const out = await searchBatches(state.search);
      let list = out.batches || [];
      buildLangOptions(list);
      if (state.lang) list = list.filter((b) => b.language === state.lang);
      list = sortBatches(list);
      grid.innerHTML = list.map(card).join("") || emptyState(
        "No batches matched",
        `Nothing found for “${state.search}”. Try a different name.`
      );
      const total = out.total ?? list.length;
      resultCount.textContent =
        `${total.toLocaleString("en-IN")} result${total === 1 ? "" : "s"} for “${state.search}”` +
        (total > list.length ? ` · showing the closest ${list.length}` : "");
      return;
    }

    const out = await loadCatalog(state.page);
    state.totalPages = out.totalPages || 1;
    state.total = out.total || 0;
    let list = out.batches || [];
    buildLangOptions(list);
    if (state.lang) list = list.filter((b) => b.language === state.lang);
    list = sortBatches(list);

    grid.innerHTML = list.map(card).join("") || emptyState(
      "Nothing on this page",
      "Try another page or reset the filters."
    );
    resultCount.textContent = `${state.total.toLocaleString("en-IN")} batches in the PW catalogue · page ${state.page} of ${state.totalPages.toLocaleString("en-IN")}`;
    renderPager();
  } catch (err) {
    grid.innerHTML = emptyState("Catalogue unavailable", err.message);
    resultCount.textContent = "Could not reach the PW catalogue.";
    toast(err.message, "error");
  }
}

searchInput.addEventListener(
  "input",
  debounce((e) => {
    state.search = e.target.value.trim();
    state.page = 1;
    load();
  }, 420)
);

langFilter.addEventListener("change", (e) => {
  state.lang = e.target.value;
  load();
});

sortBy.addEventListener("change", (e) => {
  state.sort = e.target.value;
  load();
});

resetBtn.addEventListener("click", () => {
  state.search = "";
  state.lang = "";
  state.sort = "default";
  state.page = 1;
  searchInput.value = "";
  langFilter.value = "";
  sortBy.value = "default";
  load();
});

load();
