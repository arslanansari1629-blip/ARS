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
import { loadCatalog, loadFacets } from "./data.js";
import { heartButton, wireFavourites } from "./favourites.js";

mountChrome("batches");
wireFavourites();

const grid = document.getElementById("grid");
const pager = document.getElementById("pager");
const searchInput = document.getElementById("searchInput");
const langFilter = document.getElementById("langFilter");
const priceFilter = document.getElementById("priceFilter");
const sortBy = document.getElementById("sortBy");
const resetBtn = document.getElementById("resetBtn");
const resultCount = document.getElementById("resultCount");

// A deep link with ?lang= pre-applies the language filter, so a sidebar entry
// like "Hinglish batches" can point at a real filtered view.
const initialLang = qs("lang") || "";
const SORTS = ["name", "newest", "price-asc", "price-desc"];
// Old links used ?sort=price / ?sort=free; keep them working.
const SORT_ALIASES = { price: "price-asc", free: "price-desc" };
const initialSort = SORTS.includes(SORT_ALIASES[qs("sort")] || qs("sort"))
  ? SORT_ALIASES[qs("sort")] || qs("sort")
  : "default";
const initialPrice = ["free", "paid"].includes(qs("price")) ? qs("price") : "all";
const state = {
  page: 1,
  search: qs("q") || "",
  lang: initialLang,
  price: initialPrice,
  sort: initialSort,
  totalPages: 1,
  total: 0,
  shown: 0,
};

if (state.search) searchInput.value = state.search;
if (state.sort !== "default" && sortBy) sortBy.value = state.sort;
if (state.price !== "all" && priceFilter) priceFilter.value = state.price;

/** True when anything narrows the catalogue — the pager only makes sense then. */
function isFiltered() {
  return Boolean(state.search || state.lang || state.price !== "all");
}

/** Filters travel in the URL so a filtered view can be linked and reloaded. */
function syncUrl() {
  // Guarded: `history`/`location` are absent in a non-browser render (and in the
  // jsdom harness), and losing a URL nicety must never break the listing.
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const url = new URL(location.href);
  const set = (k, v) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
  set("q", state.search);
  set("lang", state.lang);
  set("price", state.price === "all" ? "" : state.price);
  set("sort", state.sort === "default" ? "" : state.sort);
  set("page", state.page > 1 ? String(state.page) : "");
  history.replaceState(null, "", url);
}

function card(b) {
  return `
    <a class="batch-card fade-up" href="/batch.html?id=${encodeURIComponent(b.id)}">
      <div class="batch-thumb">
        ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="placeholder">${esc((b.name || "PW").slice(0, 2).toUpperCase())}</span>`}
        ${b.feeTotal ? "" : `<span class="free">Free</span>`}
        ${heartButton(b)}
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

let facets = null;

/**
 * Fill the language dropdown from the catalogue facets.
 *
 * It used to be built from the batches on the current page, so the dropdown
 * offered only the languages that happened to appear in those twenty rows — a
 * Kannada batch on page 300 could not be found by filtering. Counts come from
 * the whole catalogue so the control states how much is behind it.
 */
async function ensureFacets() {
  if (facets) return facets;
  try {
    facets = await loadFacets();
  } catch {
    facets = { languages: [], prices: { free: 0, paid: 0, total: 0 } };
  }
  const current = state.lang;
  langFilter.innerHTML =
    `<option value="">All languages</option>` +
    facets.languages
      .map(
        (l) =>
          `<option value="${esc(l.key)}">${esc(l.label)} (${l.count.toLocaleString("en-IN")})</option>`
      )
      .join("");
  if (current && facets.languages.some((l) => l.key === current.toLowerCase())) {
    langFilter.value = current.toLowerCase();
  } else if (current) {
    // An unknown ?lang= is kept as a value so the request still filters on it.
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = current;
    langFilter.append(opt);
    langFilter.value = current;
  }

  // Label the price options with real counts, so "Free only" says how many.
  if (facets.prices && priceFilter) {
    const { free } = facets.prices;
    const freeOpt = priceFilter.querySelector('option[value="free"]');
    if (freeOpt && free) freeOpt.textContent = `Free only (${free.toLocaleString("en-IN")})`;
  }
  return facets;
}

function renderPager() {
  // A filtered listing is one page of best matches, so paging it is meaningless;
  // the unfiltered catalogue is the only thing with real pages.
  if (isFiltered() || state.totalPages <= 1) {
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

/** `1–20 of 14,201` — a range, because a bare page number hides the scale. */
function rangeLabel(shown, total) {
  if (!total) return "nothing";
  const first = (state.page - 1) * 20 + 1;
  return `${first.toLocaleString("en-IN")}–${(first + shown - 1).toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}`;
}

async function load() {
  grid.innerHTML = skeletonCards(12);
  pager.innerHTML = "";
  resultCount.textContent = "Loading…";
  syncUrl();
  await ensureFacets();

  try {
    // One request shape for search and browse: the server applies every filter
    // over all 14,201 rows and returns the page plus the true match count.
    const out = await loadCatalog(state.page, {
      term: state.search,
      lang: state.lang,
      price: state.price,
      sort: state.sort,
    });

    const list = out.batches || [];
    state.total = out.total || 0;
    state.shown = list.length;
    state.totalPages = isFiltered() ? 1 : out.totalPages || 1;

    grid.innerHTML =
      list.map(card).join("") ||
      emptyState(
        "No batches matched",
        isFiltered()
          ? `Nothing in the catalogue matches those filters${state.search ? ` and “${state.search}”` : ""}. Try removing one.`
          : "The catalogue returned no batches. Try again in a moment."
      );

    if (isFiltered()) {
      const bits = [];
      if (state.search) bits.push(`“${state.search}”`);
      if (state.lang) bits.push(langFilter.selectedOptions?.[0]?.textContent || state.lang);
      if (state.price !== "all") bits.push(state.price === "free" ? "free" : "paid");
      const capped = state.total > list.length;
      resultCount.textContent =
        `${state.total.toLocaleString("en-IN")} match${state.total === 1 ? "" : "es"}` +
        (bits.length ? ` for ${bits.join(" · ")}` : "") +
        (capped ? ` · showing the closest ${list.length}` : "");
    } else {
      resultCount.textContent =
        `${state.total.toLocaleString("en-IN")} batches in the PW catalogue · ` +
        `${rangeLabel(list.length, state.total)} · page ${state.page} of ${state.totalPages.toLocaleString("en-IN")}`;
    }

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

priceFilter.addEventListener("change", (e) => {
  state.price = e.target.value;
  state.page = 1;
  load();
});

sortBy.addEventListener("change", (e) => {
  state.sort = e.target.value;
  state.page = 1;
  load();
});

resetBtn.addEventListener("click", () => {
  state.search = "";
  state.lang = "";
  state.price = "all";
  state.sort = "default";
  state.page = 1;
  searchInput.value = "";
  langFilter.value = "";
  priceFilter.value = "all";
  sortBy.value = "default";
  load();
});

load();
