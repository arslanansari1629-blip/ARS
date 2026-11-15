/* =========================================================================
   ArsVibe — UI enhancements (progressive)
   -------------------------------------------------------------------------
   Everything here is additive: if it fails, the page still works.
   - nav elevation on scroll
   - reveal-on-scroll for content blocks
   - ⌘K / Ctrl-K command palette that searches the batch catalogue
   ========================================================================= */

import { searchBatches } from "./data.js";
import { esc, debounce, getPrefs, setPref } from "./app.js";

const reduceMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------- nav shadow ------------------------------- */

const nav = document.getElementById("nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 12);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

/* --------------------------- reveal on scroll ----------------------------- */

if (!reduceMotion && typeof IntersectionObserver === "function") {
  const targets = document.querySelectorAll(
    ".section-head, .feature, .cta-banner, .hero-stats, .detail-grid, .card"
  );
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("revealed");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  targets.forEach((el, i) => {
    // Stagger siblings so a grid cascades in instead of popping at once.
    el.style.setProperty("--reveal-delay", `${Math.min(i % 8, 8) * 40}ms`);
    el.classList.add("reveal");
    io.observe(el);
  });
}

/* ----------------------------- command palette ---------------------------- */

/**
 * A search-first overlay: ⌘K anywhere, type three characters, open a batch.
 * This is the "advanced UI" that saves the most time — the site has 14k batches
 * and the header search only lives on the home page.
 */
function mountPalette() {
  if (document.getElementById("cmdk")) return;

  const root = document.createElement("div");
  root.id = "cmdk";
  root.className = "cmdk-backdrop";
  root.hidden = true;
  root.innerHTML = `
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="Search batches">
      <div class="cmdk-input">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="cmdkField" type="text" placeholder="Search 14,000+ batches…" autocomplete="off" spellcheck="false" />
        <kbd>esc</kbd>
      </div>
      <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="Matching batches"></div>
      <p class="sr-only" id="cmdkStatus" role="status" aria-live="polite"></p>
      <div class="cmdk-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span class="dim">Live catalogue search</span>
      </div>
    </div>`;
  document.body.appendChild(root);

  const field = root.querySelector("#cmdkField");
  const list = root.querySelector("#cmdkList");
  const status = root.querySelector("#cmdkStatus");
  let results = [];
  let active = 0;

  /* `aria-modal` is a promise: focus must be trapped inside the dialog while it
     is open, and handed back to whatever opened it when it closes. Without
     this, tabbing from the search field walks the page behind the overlay —
     visible to a keyboard user as a cursor moving over a blocked screen. */
  let returnFocus = null;

  const open = () => {
    returnFocus = document.activeElement;
    root.hidden = false;
    field.value = "";
    field.focus();
    paint([]);
  };

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    const back = returnFocus;
    returnFocus = null;
    // Only return focus if the caller is still a real element on the page.
    if (back && typeof back.focus === "function" && document.contains(back)) back.focus();
  };

  // Keep Tab inside the dialog. The list is links, the foot is hints, so the
  // only reliably focusable stops are the field and the items.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || root.hidden) return;
    const stops = [field, ...list.querySelectorAll(".cmdk-item")];
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function paint(items) {
    results = items;
    active = 0;
    if (!items.length) {
      list.innerHTML = `<div class="cmdk-empty tiny dim">Keep typing to search the live catalogue…</div>`;
      if (status) status.textContent = "";
      return;
    }
    if (status) {
      status.textContent = `${items.length} batch${items.length === 1 ? "" : "es"} match`;
    }
    list.innerHTML = items
      .slice(0, 8)
      .map(
        (b, i) => `
        <a class="cmdk-item${i === 0 ? " on" : ""}" role="option" aria-selected="${i === 0}" href="/batch.html?id=${encodeURIComponent(b.id)}" data-i="${i}">
          ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="cmdk-ph"></span>`}
          <span class="grow truncate">${esc(b.name)}</span>
          <span class="pill">${esc(b.language || "PW")}</span>
        </a>`
      )
      .join("");
  }

  function highlight(next) {
    if (!results.length) return;
    active = (next + results.length) % results.length;
    list.querySelectorAll(".cmdk-item").forEach((el, i) => {
      el.classList.toggle("on", i === active);
      el.setAttribute("aria-selected", String(i === active));
    });
    list.querySelectorAll(".cmdk-item")[active]?.scrollIntoView({ block: "nearest" });
  }

  const run = debounce(async (term) => {
    if (!term || term.trim().length < 2) return paint([]);
    list.innerHTML = `<div class="cmdk-empty tiny dim">Searching…</div>`;
    try {
      const out = await searchBatches(term.trim());
      paint((out && out.batches) || []);
    } catch {
      list.innerHTML = `<div class="cmdk-empty tiny dim">Search failed — open the batches page instead.</div>`;
    }
  }, 220);

  field.addEventListener("input", () => run(field.value));
  field.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(active - 1);
    } else if (e.key === "Enter") {
      const hit = results[active];
      if (hit) {
        e.preventDefault();
        window.location.assign(`/batch.html?id=${encodeURIComponent(hit.id)}`);
      }
    }
  });

  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (root.hidden) open();
      else close();
      return;
    }
    if (!root.hidden && e.key === "Escape") close();
    // "/" as a quick open, but never while typing in a field.
    if (e.key === "/" && !typing && root.hidden) {
      e.preventDefault();
      open();
    }
  });

  return { open, close };
}

mountPalette();

/* A visible affordance: the palette is useless if nobody knows it exists. */
if (nav) {
  const actions = nav.querySelector(".nav-actions");
  if (actions && !actions.querySelector(".cmdk-trigger")) {
    const btn = document.createElement("button");
    btn.className = "cmdk-trigger";
    btn.type = "button";
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><span>Search</span><kbd>⌘K</kbd>`;
    btn.addEventListener("click", () => {
      const field = document.getElementById("cmdkField");
      const backdrop = document.getElementById("cmdk");
      if (!field || !backdrop) return;
      backdrop.hidden = false;
      field.focus();
    });
    actions.prepend(btn);
  }
}

/* ================= Round 2: accents, instruments, shortcuts ================= */

/* ---- accent picker: four auroras, one persisted choice ---- */
const ACCENTS = ["aurora", "ocean", "emerald", "sunset"];
function applyAccent(name) {
  const accent = ACCENTS.includes(name) ? name : "aurora";
  document.documentElement.dataset.accent = accent;
  document.querySelectorAll(".accent-dot").forEach((d) =>
    d.classList.toggle("active", d.dataset.accent === accent)
  );
}
applyAccent(getPrefs().accent || "aurora");
if (nav) {
  const actions = nav.querySelector(".nav-actions");
  if (actions && !actions.querySelector(".accent-picker")) {
    const picker = document.createElement("div");
    picker.className = "accent-picker";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "Accent theme");
    picker.innerHTML = ACCENTS.map(
      (a) => `<button type="button" class="accent-dot" data-accent="${a}" title="${a[0].toUpperCase() + a.slice(1)} accent" aria-label="${a} accent"></button>`
    ).join("");
    picker.addEventListener("click", (e) => {
      const dot = e.target.closest("[data-accent]");
      if (!dot) return;
      setPref("accent", dot.dataset.accent);
      applyAccent(dot.dataset.accent);
    });
    actions.appendChild(picker);
  }
}

/* ---- reading progress hairline + back-to-top ---- */
const progressBar = document.createElement("div");
progressBar.className = "scroll-progress";
progressBar.setAttribute("aria-hidden", "true");
document.body.appendChild(progressBar);
const toTop = document.createElement("button");
toTop.className = "to-top";
toTop.type = "button";
toTop.setAttribute("aria-label", "Back to top");
toTop.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
document.body.appendChild(toTop);
toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" }));
let ticking = false;
window.addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    progressBar.style.width = `${max > 0 ? Math.min(100, (scrollY / max) * 100) : 0}%`;
    toTop.classList.toggle("show", scrollY > 700);
    ticking = false;
  });
}, { passive: true });

/* ---- keyboard shortcuts: ? for the map, g+key to travel ---- */
const SHORTCUTS = [
  ["⌘K / /", "Search the catalogue"],
  ["g then h", "Home"],
  ["g then b", "All batches"],
  ["g then f", "Favourites"],
  ["g then l", "My Library"],
  ["g then d", "Dashboard"],
  ["g then w", "Downloads"],
  ["?", "This shortcut map"],
  ["Esc", "Close dialogs"],
];
const GO = { h: "/", b: "/batches.html", f: "/favourites.html", l: "/library.html", d: "/dashboard.html", w: "/downloads.html" };
let kbdOverlay = null;
function closeShortcuts() { kbdOverlay?.remove(); kbdOverlay = null; }
function openShortcuts() {
  if (kbdOverlay) return closeShortcuts();
  kbdOverlay = document.createElement("div");
  kbdOverlay.className = "kbd-overlay";
  kbdOverlay.innerHTML = `<div class="card kbd-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <h3>Keyboard shortcuts</h3>
    ${SHORTCUTS.map(([k, label]) => `<div class="kbd-row"><span>${label}</span><span class="kbd-keys">${k.split(" / ").map((x) => `<kbd>${x}</kbd>`).join("")}</span></div>`).join("")}
    <p class="tiny dim" style="margin-top:12px">Press <kbd>Esc</kbd> or click anywhere to close.</p>
  </div>`;
  kbdOverlay.addEventListener("click", closeShortcuts);
  document.body.appendChild(kbdOverlay);
}
let gPending = false, gTimer = 0;
window.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
  if (e.key === "Escape") closeShortcuts();
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "?") { e.preventDefault(); openShortcuts(); return; }
  if (gPending && GO[e.key.toLowerCase()]) {
    gPending = false;
    clearTimeout(gTimer);
    window.location.href = GO[e.key.toLowerCase()];
    return;
  }
  if (e.key.toLowerCase() === "g") {
    gPending = true;
    clearTimeout(gTimer);
    gTimer = setTimeout(() => (gPending = false), 800);
  }
});

/* ---- focus timer: a small pomodoro that lives in the nav ---- */
(function focusTimer() {
  if (!nav) return;
  const actions = nav.querySelector(".nav-actions");
  if (!actions || actions.querySelector(".focus-chip")) return;
  const chip = document.createElement("button");
  chip.className = "focus-chip";
  chip.type = "button";
  chip.title = "Focus timer";
  chip.innerHTML = `⏱ <span data-focus-label>Focus</span>`;
  actions.appendChild(chip);

  const pop = document.createElement("div");
  pop.className = "focus-pop card";
  pop.hidden = true;
  pop.innerHTML = `
    <div class="focus-time" data-f-time>25:00</div>
    <div class="focus-presets">
      ${[15, 25, 50].map((m) => `<button type="button" class="goal-chip" data-f-preset="${m}">${m}m</button>`).join("")}
    </div>
    <div class="focus-actions">
      <button type="button" class="btn btn-primary btn-sm" data-f-toggle>Start</button>
      <button type="button" class="btn btn-ghost btn-sm" data-f-reset>Reset</button>
    </div>
    <p class="tiny dim" data-f-count></p>`;
  document.body.appendChild(pop);

  let total = 25 * 60, left = total, timer = null;
  const label = chip.querySelector("[data-focus-label]");
  const timeEl = pop.querySelector("[data-f-time]");
  const toggle = pop.querySelector("[data-f-toggle]");
  const countEl = pop.querySelector("[data-f-count]");
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const todayCount = () => {
    try { return JSON.parse(localStorage.getItem("arsvibe.focus") || "{}"); } catch { return {}; }
  };
  const paint = () => {
    timeEl.textContent = fmt(left);
    label.textContent = timer ? fmt(left) : "Focus";
    const day = new Date().toISOString().slice(0, 10);
    countEl.textContent = `${todayCount()[day] || 0} focus session${(todayCount()[day] || 0) === 1 ? "" : "s"} today`;
  };
  const stop = () => { clearInterval(timer); timer = null; toggle.textContent = "Start"; paint(); };
  const done = () => {
    stop();
    left = total;
    const store = todayCount();
    const day = new Date().toISOString().slice(0, 10);
    store[day] = (store[day] || 0) + 1;
    try { localStorage.setItem("arsvibe.focus", JSON.stringify(store)); } catch { /* ignore */ }
    paint();
    import("./app.js").then(({ toast }) => toast("⏱ Focus session complete — nice work. Take a breath.")).catch(() => {});
  };
  toggle.addEventListener("click", () => {
    if (timer) return stop();
    toggle.textContent = "Pause";
    timer = setInterval(() => { left -= 1; if (left <= 0) done(); else paint(); }, 1000);
    paint();
  });
  pop.querySelector("[data-f-reset]").addEventListener("click", () => { stop(); left = total; paint(); });
  pop.querySelectorAll("[data-f-preset]").forEach((b) =>
    b.addEventListener("click", () => { stop(); total = Number(b.dataset.fPreset) * 60; left = total; paint(); })
  );
  chip.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    if (!pop.hidden) {
      const r = chip.getBoundingClientRect();
      pop.style.top = `${r.bottom + 10}px`;
      pop.style.right = `${Math.max(10, innerWidth - r.right)}px`;
    }
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== chip && !chip.contains(e.target)) pop.hidden = true;
  });
  paint();
})();

/* ---- hover prefetch: pages arrive before the click lands ---- */
(function hoverPrefetch() {
  const seen = new Set();
  document.addEventListener("pointerover", (e) => {
    const a = e.target.closest?.('a[href^="/"]');
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("/api") || seen.has(href)) return;
    seen.add(href);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    document.head.appendChild(link);
  }, { passive: true });
})();
