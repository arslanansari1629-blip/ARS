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
import { progress } from "./progress.js";

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

/* The study hub: streak, XP and in-progress count for a returning student.
   All of it already exists in progress.js/library — the front door just
   never showed it. First-time visitors see nothing here (no fake zeros). */
/* Live & today on the front door: the same per-batch today read the
   live page uses, gathered for the batches this student actually
   opens. Quiet when there is nothing to say — no batches opened yet,
   or no classes today, means no strip and no empty hole. */
(async function homeLive() {
  const section = document.getElementById("homeLiveSection");
  const grid = document.getElementById("homeLiveGrid");
  if (!section || !grid) return;
  const batches = recentBatches().slice(0, 3);
  if (!batches.length) return;
  const results = await Promise.allSettled(
    batches.map(async (b) => {
      const res = await fetch(`/api/batch?today=1&id=${encodeURIComponent(b.id)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => null);
      const rows = Array.isArray(data?.today?.classes) ? data.today.classes : [];
      return rows.map((c) => ({ ...c, batch: b.id, batchName: b.name || "" }));
    })
  );
  const classes = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
  if (!classes.length) return;
  const watch = (c) =>
    `/watch.html?batch=${encodeURIComponent(c.batch)}&subject=${encodeURIComponent(c.subjectSlug || "")}&id=${encodeURIComponent(c.id || "")}&title=${encodeURIComponent(c.title || "")}`;
  grid.innerHTML = classes
    .slice(0, 6)
    .map((c) => {
      const live = c.status === "live";
      const badge = c.cancelled
        ? `<span class="pill">Called off</span>`
        : live
          ? `<span class="pill live-pill"><span class="live-dot"></span> LIVE</span>`
          : c.status === "upcoming"
            ? `<span class="pill pill-brand">${esc(c.startClock || "Today")}</span>`
            : `<span class="pill">Ended ${esc(c.endClock || "")}</span>`;
      const cta = c.cancelled
        ? ""
        : live || c.hasStream
          ? `<a class="btn ${live ? "btn-primary" : "btn-ghost"} btn-sm" href="${watch(c)}">${live ? "▶ Join live" : "Watch recording"}</a>`
          : `<span class="tiny dim">Stream appears when the class starts</span>`;
      return `<article class="card live-card">
        <div class="row between">${badge}<span class="tiny dim">${esc(c.startClock || "")} IST</span></div>
        <h3 class="live-title">${esc(c.title || "Class")}</h3>
        <p class="tiny muted">${esc(c.subject || "")}${c.batchName ? ` · ${esc(c.batchName)}` : ""}</p>
        <div class="live-cta">${cta}</div>
      </article>`;
    })
    .join("");
  section.hidden = false;
})();

(function studyHub() {
  const section = document.getElementById("hubSection");
  if (!section) return;
  try {
    const p = progress();
    const lectures = getLibrary().lectures || [];
    const inProgress = lectures.filter((l) => Number(localStorage.getItem(`pos:${l.id}`) || 0) > 12).length;
    if (!p.xp && !p.streak.current && !inProgress) return;
    section.hidden = false;
    document.getElementById("hubStreak").textContent = `${p.streak.current} day streak`;
    document.getElementById("hubStreakNote").textContent = p.streak.studiedToday ? "Today counts ✓" : "One DPP keeps it alive";
    document.getElementById("hubXp").textContent = `${p.xp.toLocaleString("en-IN")} XP`;
    document.getElementById("hubLevel").textContent = `Level ${p.level} · ${p.title}`;
    document.getElementById("hubBarFill").style.width = `${p.percent}%`;
    document.getElementById("hubProgress").textContent = inProgress ? `${inProgress} lecture${inProgress === 1 ? "" : "s"} in progress` : "Nothing in progress";
  } catch {
    /* a broken hub must never break the home page */
  }
})();

/* Picked for you: the goal hiding inside the batches you already open,
   searched back against the live catalogue. */
(async function recommendations() {
  const section = document.getElementById("recoSection");
  const grid = document.getElementById("recoGrid");
  if (!section || !grid) return;
  const names = [
    ...recentBatches().map((b) => b.name || ""),
    ...(getLibrary().batches || []).map((b) => b.name || ""),
  ].join(" ");
  const goal = GOALS.map((g) => g[2]).find((q) => new RegExp(`\\b${q}\\b`, "i").test(names));
  if (!goal) return;
  try {
    const found = await searchBatches(goal);
    const rows = (found?.batches || found || []).filter((b) => b && b.id).slice(0, 4);
    if (!rows.length) return;
    section.hidden = false;
    grid.innerHTML = rows.map(batchCard).join("");
    wireFavourites();
  } catch {
    /* recommendations are a garnish, never a failure */
  }
})();

/* Voice search: say the batch name instead of typing it (where supported). */
(function voiceSearch() {
  const btn = document.getElementById("voiceSearchBtn");
  const input = document.getElementById("heroSearchInput");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!btn || !input || !SR) return;
  btn.hidden = false;
  btn.addEventListener("click", () => {
    const rec = new SR();
    rec.lang = "en-IN";
    btn.textContent = "🔴";
    rec.onresult = (e) => {
      input.value = e.results[0][0].transcript || "";
      document.getElementById("heroSearch")?.requestSubmit();
    };
    rec.onend = () => (btn.textContent = "🎙");
    rec.onerror = () => (btn.textContent = "🎙");
    try { rec.start(); } catch { btn.textContent = "🎙"; }
  });
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

/* ---- Choose Platform: chip filter + live counts ----------------
   The cards are plain anchors, so the platforms open even if this
   module never runs; everything here is garnish. Counts are asked
   once, quietly, and any failure leaves the printed fallback. */
(() => {
  const grid = document.querySelector("#platformsGrid");
  if (!grid) return;
  const chips = [...document.querySelectorAll("[data-pfilter]")];
  const cards = [...grid.querySelectorAll(".platform-card")];
  const countEl = document.querySelector("#platformCount");
  const paintCount = () => {
    const n = cards.filter((c) => !c.classList.contains("hide")).length;
    if (countEl) countEl.textContent = String(n);
  };
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.toggle("on", c === chip));
      const f = chip.dataset.pfilter;
      cards.forEach((card) => {
        card.classList.toggle("hide", f !== "all" && card.dataset.status !== f);
      });
      paintCount();
    });
  });
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k+` : String(n));
  fetch("/api/batches?facets=1", { headers: { Accept: "application/json" } })
    .then((r) => r.json())
    .then((d) => {
      const total = d?.prices?.total || d?.total || 0;
      const el = document.querySelector("#platformPwCount");
      if (el && total > 0) el.textContent = fmt(total);
    })
    .catch(() => {});
  fetch("/api/allen?view=batches", { headers: { Accept: "application/json" } })
    .then((r) => r.json())
    .then((d) => {
      const total = d?.total || (Array.isArray(d?.items) ? d.items.length : 0);
      const el = document.querySelector("#platformAllenCount");
      if (el && total > 0) el.textContent = String(total);
    })
    .catch(() => {});
})();
