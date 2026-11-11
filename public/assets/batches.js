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
import { loadCatalog, loadFacets, loadBatch, loadContents } from "./data.js";
import { practiceHref, walkBatch } from "./dpp-panel.js";
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

/**
 * `#dpp-tests` — the nav's DPP Tests entry.
 *
 * This used to render a notice explaining that papers live in a batch's DPP
 * Tests tab and leave the catalogue underneath: a page that told you where the
 * thing was instead of showing it. It now walks the batches already on screen,
 * reads each one's paper list from the same route the panel uses, and lists the
 * papers here — with Practice on each, the batch it belongs to, and a way to
 * search. Batches whose walk has not answered yet say so, and the walk stops at
 * a bounded number so opening the tab is not a crawl.
 */
async function showDppTests() {
  const host = document.getElementById("dppTestsNotice") || document.createElement("div");
  host.id = "dppTestsNotice";
  host.className = "dpp-tests";
  host.dataset.sig = catalogSig();
  if (!host.isConnected) grid.parentElement.insertBefore(host, grid);

  host.innerHTML = `
    <div class="dpp-panel-head">
      <div>
        <span class="eyebrow">Practice</span>
        <h2>DPP tests</h2>
        <p class="muted tiny">Every paper is marked against its own answer key, one attempt each.</p>
        <p class="muted tiny" id="dppTestsNote" role="status">Finding papers in the batches below…</p>
      </div>
      <div class="dpp-panel-tools">
        <label class="dpp-panel-search">
          <span class="sr-only">Search DPP papers</span>
          <input type="search" id="dppTestsSearch" placeholder="Search papers, batches, chapters…" autocomplete="off" />
        </label>
        <button class="btn btn-ghost btn-sm" id="dppTestsDismiss" type="button">All batches</button>
      </div>
    </div>
    <div class="dpp-tests-list" id="dppTestsList">
      <div class="list">${Array.from({ length: 3 })
        .map(() => `<div class="skeleton sk-row"></div>`)
        .join("")}</div>
    </div>`;

  document.getElementById("dppTestsDismiss").addEventListener("click", () => {
    host.classList.add("hide");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    document.getElementById("resultCount")?.scrollIntoView?.({ block: "start" });
  });

  const note = document.getElementById("dppTestsNote");
  const listEl = document.getElementById("dppTestsList");
  const searchEl = document.getElementById("dppTestsSearch");

  const papers = [];
  const seen = new Set();
  let query = "";
  let scanning = true;

  const render = () => {
    const needle = query.trim().toLowerCase();
    const rows = papers.filter((paper) =>
      !needle ||
      `${paper.title} ${paper.chapter} ${paper.subjectName} ${paper.batchName}`.toLowerCase().includes(needle)
    );

    if (rows.length) {
      listEl.innerHTML = `<div class="list dpp-panel-rows">${rows
        .map(
          (paper) => `
        <article class="dpp-panel-row">
          <div class="dpp-panel-main">
            <span class="pill">${esc(paper.batchName)}</span>
            <strong>${esc(paper.title)}</strong>
            <span class="tiny dim">${esc(paper.subjectName)} · ${esc(paper.chapter)}${paper.file && paper.file !== paper.title ? ` · ${esc(paper.file)}` : ""}</span>
          </div>
          <div class="dpp-panel-actions">
            <a class="btn btn-primary btn-sm" href="${esc(practiceHref(paper))}">Practice</a>
            <a class="btn btn-ghost btn-sm" href="/api/media?url=${encodeURIComponent(paper.url)}" target="_blank" rel="noopener">PDF</a>
          </div>
        </article>`
        )
        .join("")}</div>`;
    } else if (scanning) {
      listEl.innerHTML = `<div class="list">${Array.from({ length: 3 })
        .map(() => `<div class="skeleton sk-row"></div>`)
        .join("")}</div>`;
    } else {
      listEl.innerHTML = `<div class="empty-state">
        <p><strong>${needle ? `No paper matches “${esc(query)}”.` : "None of these batches list a DPP yet."}</strong></p>
        <p class="tiny muted">${
          needle
            ? "Clear the search, or open a batch's DPP Tests tab for everything in it."
            : "Open any batch and press its DPP Tests tab — the papers live under its chapters."
        }</p>
      </div>`;
    }

    const found = papers.length;
    note.textContent = scanning
      ? `${found} paper${found === 1 ? "" : "s"} so far, reading the batches on this page…`
      : found
        ? `${found} paper${found === 1 ? "" : "s"} from ${new Set(papers.map((p) => p.batchName)).size} batch${new Set(papers.map((p) => p.batchName)).size === 1 ? "" : "es"} on this page. Press Practice on any of them.`
        : "No papers found in the batches on this page.";
  };

  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    render();
  });

  render();

  /**
   * Walk a handful of the visible batches, not all of them, and not deeply: this
   * is a way in, and a reader who has not found a paper after a few batches wants
   * the catalogue or their own batch — not a longer spinner.
   *
   * The walk itself is `walkBatch` from the panel, so a paper listed here is the
   * same record the batch page lists: same title, same chapter, same Practice link.
   */
  const targets = (state.list || []).filter((b) => b && b.id).slice(0, 6);

  await Promise.all(
    targets.slice(0, 3).map(async (target) => {
      let subjects = target.subjects || [];
      if (!subjects.length) {
        const info = await loadBatch(target.id).catch(() => null);
        subjects = info?.subjects || [];
      }
      await walkBatch({
        batch: target.id,
        subjects,
        limit: 8,
        onPaper: (paper) => {
          if (seen.has(paper.url)) return;
          seen.add(paper.url);
          papers.push({ ...paper, batch: target.id, batchName: target.name || target.id });
          render();
        },
        onProgress: () => render(),
      }).catch(() => {});
      render();
    })
  );

  scanning = false;
  render();
}

/** True while the nav's DPP Tests panel is the thing on screen. */
const onDppTests = () => location.hash.replace("#", "") === "dpp-tests";

/** What the catalogue is currently showing — the panel lists *this* page. */
const catalogSig = () => `${state.page}|${state.search}|${state.lang}|${state.price}|${state.sort}`;

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
    state.list = list;
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

  // The nav's DPP panel overlays the catalogue and lists the batches on it, so
  // it mounts once the rows exist — not in front of a skeleton, and never
  // instead of the catalogue. If the catalogue itself changed (a search, a page,
  // a filter) the panel's papers describe a page that is gone: re-read it.
  if (onDppTests()) {
    const host = document.getElementById("dppTestsNotice");
    if (!host) showDppTests();
    else if (host.classList.contains("hide")) host.dataset.sig = catalogSig();
    else if (host.dataset.sig !== catalogSig()) {
      host.remove();
      showDppTests();
    }
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

// Back/forward and a second click on the nav entry both land here. The panel is
// mounted over the catalogue, so "leave" only means dropping it again.
window.addEventListener("hashchange", () => {
  if (!onDppTests()) {
    document.getElementById("dppTestsNotice")?.remove();
    return;
  }
  const host = document.getElementById("dppTestsNotice");
  if (host) {
    host.classList.remove("hide");
    return;
  }
  // Arriving before the catalogue has answered: let `load` mount it afterwards.
  if (!state.list?.length) load();
  else showDppTests();
});

load();
