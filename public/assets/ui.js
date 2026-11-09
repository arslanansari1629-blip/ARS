/* =========================================================================
   ArsVibe — UI enhancements (progressive)
   -------------------------------------------------------------------------
   Everything here is additive: if it fails, the page still works.
   - nav elevation on scroll
   - reveal-on-scroll for content blocks
   - ⌘K / Ctrl-K command palette that searches the batch catalogue
   ========================================================================= */

import { searchBatches } from "./data.js";
import { esc, debounce } from "./app.js";

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
