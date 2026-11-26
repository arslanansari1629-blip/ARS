/* =========================================================================
   ArsVibe — application shell
   -------------------------------------------------------------------------
   Turns the ten flat pages into one coherent app: a persistent sidebar, a top
   bar with search and account, and a consistent content column.

   Written as progressive enhancement. Every page already works without it —
   the shell adds structure, it does not own any page's data. If this module
   fails to load, each page falls back to the nav it shipped with.
   ========================================================================= */

import "./device.js"; // Auto-Fit: <html data-device> fits the layout to this screen
import "./brain-widget.js"; // the Site Brain's face rides along
import { getSession, recentBatches, getPrefs, setPref, esc } from "./app.js";
import { favouriteCount } from "./favourites.js";

const page = (document.body && document.body.dataset.page) || "home";

const NAV = [
  {
    key: "browse",
    title: "Browse",
    items: [
      { id: "home", href: "/", label: "Home", icon: "home" },
      { id: "batches", href: "/batches.html", label: "All batches", icon: "grid" },
      { id: "allen", href: "/allen.html", label: "Allen", icon: "grid" },
      { id: "live", href: "/live.html", label: "Live classes", icon: "live" },
      { id: "search", href: "#search", label: "Search", icon: "search", kbd: "⌘K" },
    ],
  },
  {
    key: "study",
    title: "Study",
    items: [
      { id: "favourites", href: "/favourites.html", label: "Favourites", icon: "heart", badge: "fav" },
      { id: "downloads", href: "/downloads.html", label: "Downloads", icon: "download" },
      { id: "library", href: "/library.html", label: "My Library", icon: "bookmark" },
      { id: "dashboard", href: "/dashboard.html", label: "Dashboard", icon: "chart" },
      { id: "leaderboard", href: "/leaderboard.html", label: "Leaderboard", icon: "trophy" },
    ],
  },
  {
    key: "practice",
    title: "Practice",
    items: [
      { id: "dpp", href: "/dpp.html", label: "DPP tests", icon: "target" },
      { id: "live2", href: "/live.html", label: "Live now", icon: "live" },
      { id: "leaderboard2", href: "/leaderboard.html", label: "Leaderboard", icon: "trophy" },
      { id: "chat", href: "/chat.html", label: "Study Hall chat", icon: "chat" },
    ],
  },
  {
    key: "languages",
    title: "Language",
    items: [
      { id: "hinglish", href: "/batches.html?lang=Hinglish", label: "Hinglish", icon: "globe" },
      { id: "bilingual", href: "/batches.html?lang=Bilingual", label: "Bilingual", icon: "globe" },
      { id: "gujrati", href: "/batches.html?lang=Gujrati", label: "Gujarati", icon: "globe" },
      { id: "kannada", href: "/batches.html?lang=Kannada", label: "Kannada", icon: "globe" },
      { id: "telugu", href: "/batches.html?lang=Telugu", label: "Telugu", icon: "globe" },
    ],
  },
  {
    key: "sort",
    title: "Sort",
    items: [
      { id: "newest", href: "/batches.html?sort=newest", label: "Newest first", icon: "clock" },
      { id: "az", href: "/batches.html?sort=name", label: "Name (A–Z)", icon: "list" },
    ],
  },
];

const ICONS = {
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10.5V20h11v-9.5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.6-3.6"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  download: '<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0Z"/><path d="M8 5H5v2a3 3 0 0 0 3 3"/><path d="M16 5h3v2a3 3 0 0 1-3 3"/><path d="M12 13v4M9 20h6"/>',
  chart: '<path d="M4 19V9M10 19V4M16 19v-6M22 19H2"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 2.4 14.4 0 17M12 3.5c-2.4 2.6-2.4 14.4 0 17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  heart: '<path d="M12 20.3 4.9 13.4a4.2 4.2 0 0 1 0-6 4.3 4.3 0 0 1 6 0l1.1 1.1 1.1-1.1a4.3 4.3 0 0 1 6 0 4.2 4.2 0 0 1 0 6Z"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.8A8.5 8.5 0 1 1 21 11.5Z"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  live: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M6 18a9 9 0 0 1 0-12M18 6a9 9 0 0 1 0 12"/>',
  collapse: '<path d="M9 6l-6 6 6 6"/><path d="M21 6v12"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z"/><path d="M12 13v7"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4"/><path d="M12 17h.01"/>',
};

const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;

/* ------------------------------- sidebar --------------------------------- */

function buildSidebar() {
  const aside = document.createElement("aside");
  aside.className = "side";
  aside.id = "side";

  const groups = NAV.map((group) => {
    const items = group.items
      .map((item) => {
        const active = item.id === page ? " active" : "";
        if (item.id === "search") {
          return `<button class="side-link${active}" type="button" data-open-search data-label="${item.label}">
            ${icon(item.icon)}<span>${item.label}</span><kbd>${item.kbd}</kbd>
          </button>`;
        }
        const liveDot = item.icon === "live" ? '<i class="side-live-dot" aria-hidden="true"></i>' : "";
        return `<a class="side-link${active}" href="${item.href}" data-label="${item.label}">${icon(item.icon)}<span>${item.label}</span>${liveDot}${
          item.badge === "fav" ? `<em class="side-count" data-fav-count hidden>0</em>` : ""
        }</a>`;
      })
      .join("");
    return `<details class="side-group" data-group="${group.key}" open>
        <summary class="side-title" aria-label="${group.title}">${group.title}<span class="chev-mark" aria-hidden="true"></span></summary>
        <div class="side-items">${items}</div>
      </details>`;
  }).join("");

  const recent = recentBatches().slice(0, 4);
  const recentBlock = recent.length
    ? `<div class="side-group side-recent">
        <span class="side-title recent-title">Jump back in</span>
        ${recent
          .map(
            (b) => `<a class="side-mini" href="/batch.html?id=${encodeURIComponent(b.id)}" title="${esc(b.name)}">
              ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="side-mini-ph"></span>`}
              <span class="truncate">${esc(b.name)}</span>
            </a>`
          )
          .join("")}
      </div>`
    : "";

  const session = getSession();
  // Same marker the admin page uses, so the door appears only after a visit.
  const isAdmin = (() => {
    try {
      return Boolean(sessionStorage.getItem("arsvibe.admin.token"));
    } catch {
      return false;
    }
  })();

  const hour = new Date().getHours();
  const daypart = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = session ? String(session.name || "Scholar").trim().split(/\s+/)[0] : "Scholar";

  aside.innerHTML = `
    <div class="side-head">
      <a class="side-brand" href="/">
        <img class="brand-img" src="/assets/logo.svg" alt="" width="30" height="30" />
        <span class="side-brand-text">ArsVibe<small>Physics Wallah</small></span>
      </a>
      <button class="side-collapse" type="button" data-side-collapse title="Collapse navigation" aria-label="Collapse navigation">
        ${icon("collapse")}
      </button>
    </div>

    <div class="side-hero">
      <span class="side-hero-kicker">Study OS · DWG AV-01</span>
      <strong>${esc(daypart)}, ${esc(firstName)}</strong>
      <span class="side-hero-sub">Pick up right where you left off.</span>
      <span class="side-hero-rule" aria-hidden="true"></span>
    </div>

    <nav class="side-nav" aria-label="Site">${groups}${recentBlock}</nav>

    <a class="side-live" href="/live.html">
      <span class="side-live-dot" aria-hidden="true"></span>
      <span class="side-live-text"><strong>Live classes</strong><small>See what is on air now</small></span>
      <span class="side-live-arrow" aria-hidden="true">→</span>
    </a>

    <div class="side-foot">
      ${
        session
          ? `<a class="side-who" href="/dashboard.html" title="${esc(session.name)}">
               <span class="avatar">${esc(String(session.name || "A").trim().charAt(0).toUpperCase())}</span>
               <span class="side-who-text"><strong>${esc(session.name)}</strong><span>Open dashboard</span></span>
             </a>`
          : `<a class="side-cta" href="/login.html">
               ${icon("help")}
               <span>Sign in to save progress</span>
             </a>`
      }
      <a class="side-cta" href="${esc("https://t.me/ArsVibe_Main")}" target="_blank" rel="noopener">
        ${icon("spark")}
        <span>Join the study circle</span>
      </a>
      ${
        // A quiet door to the operator panel: no label in the nav, no page in the
        // sitemap, just a small link for whoever already knows it is there.
        isAdmin
          ? `<a class="side-micro side-admin" href="/admin.html" title="Operator panel">DWG AV-01 · admin</a>`
          : `<span class="side-micro">DWG AV-01 · rev 2026</span>`
      }
    </div>`;

  return aside;
}

/* --------------------------------- top bar -------------------------------- */

/**
 * Rebuild the shipped header into a top bar: page context on the left, search
 * and account on the right. The old nav links move to the sidebar, so they are
 * removed here rather than duplicated.
 */
/* ------------------------- notifications centre ---------------------------
   The aryavidya hub puts a bell in the top bar: announcements from the
   batches the student actually opens, newest first, with an unread
   badge and mark-all-read. The data already exists per batch
   (/api/lecture?announcements=1) — this only gathers it. Read state is
   one timestamp in prefs; anything newer is unread. Cosmetic layer:
   if every fetch fails the bell simply stays quiet. */

const NOTIF_SEEN_KEY = "notifSeenAt";

function buildNotifications(actions) {
  if (!actions || document.getElementById("notifBtn")) return;
  const wrap = document.createElement("div");
  wrap.className = "notif-wrap";
  wrap.innerHTML = `
    <button class="notif-btn" id="notifBtn" type="button" aria-label="Notifications" aria-expanded="false">
      ${icon("bell")}<span class="notif-badge" id="notifBadge" hidden>0</span>
    </button>
    <div class="notif-panel" id="notifPanel" hidden role="dialog" aria-label="Notifications">
      <div class="notif-head">
        <strong>Notifications</strong>
        <button class="notif-read" id="notifRead" type="button">Mark all read</button>
      </div>
      <div class="notif-list" id="notifList"><p class="tiny dim notif-empty">Loading updates from your batches…</p></div>
    </div>`;
  actions.parentNode.insertBefore(wrap, actions);

  const btn = wrap.querySelector("#notifBtn");
  const panel = wrap.querySelector("#notifPanel");
  const list = wrap.querySelector("#notifList");
  const badge = wrap.querySelector("#notifBadge");
  let items = [];
  let loaded = false;

  const seenAt = () => Date.parse(getPrefs()[NOTIF_SEEN_KEY] || "") || 0;
  const paintBadge = () => {
    const unread = items.filter((i) => Date.parse(i.createdAt || "") > seenAt()).length;
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? "9+" : String(unread);
  };
  const paintList = () => {
    if (!items.length) {
      list.innerHTML = `<p class="tiny dim notif-empty">No updates yet — open a batch and its announcements will land here.</p>`;
      return;
    }
    const seen = seenAt();
    list.innerHTML = items
      .slice(0, 20)
      .map((i) => {
        const fresh = Date.parse(i.createdAt || "") > seen ? " is-new" : "";
        const when = i.createdAt ? new Date(i.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
        return `<a class="notif-item${fresh}" href="/batch.html?id=${encodeURIComponent(i.batchId)}">
          <strong>${esc(i.heading || "Update")}</strong>
          <span>${esc(String(i.message || "").slice(0, 110))}</span>
          <em>${esc(i.batchName || "")}${when ? ` · ${when}` : ""}</em>
        </a>`;
      })
      .join("");
  };
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const batches = recentBatches().slice(0, 3);
    if (!batches.length) { paintList(); return; }
    const results = await Promise.allSettled(
      batches.map(async (b) => {
        const res = await fetch(`/api/lecture?batch=${encodeURIComponent(b.id)}&announcements=1`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        return (data.items || []).map((i) => ({ ...i, batchId: b.id, batchName: b.name || "" }));
      })
    );
    items = results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
    paintBadge();
    paintList();
  };

  btn.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) load();
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !wrap.contains(e.target)) {
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    }
  });
  wrap.querySelector("#notifRead").addEventListener("click", () => {
    setPref(NOTIF_SEEN_KEY, new Date().toISOString());
    paintBadge();
    paintList();
  });
  load();
}

function buildTopbar() {
  const header = document.getElementById("nav");
  if (!header) return null;

  const inner = header.querySelector(".nav-inner");
  if (!inner) return null;

  // The sidebar carries navigation on desktop; the hamburger still opens it on
  // small screens.
  const toggle = inner.querySelector("#navToggle");
  if (toggle) toggle.setAttribute("aria-label", "Open navigation");

  const links = inner.querySelector("#navLinks");
  if (links) links.classList.add("nav-links-legacy");

  const brand = inner.querySelector(".brand");
  if (brand) brand.classList.add("brand-compact");

  const actions = inner.querySelector(".nav-actions");
  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "topbar-search";
  searchBtn.setAttribute("data-open-search", "");
  searchBtn.innerHTML = `${icon("search")}<span>Search batches</span><kbd>⌘K</kbd>`;
  searchBtn.addEventListener("click", () => openSearch());

  if (actions) actions.parentNode.insertBefore(searchBtn, actions);
  else inner.appendChild(searchBtn);
  buildNotifications(actions || inner);
  buildThemeToggle(actions || inner);

  header.classList.add("topbar");
  return header;
}

/** Open the command palette built by ui.js, if present. */
function openSearch() {
  const backdrop = document.getElementById("cmdk");
  const field = document.getElementById("cmdkField");
  if (!backdrop || !field) {
    window.location.assign("/batches.html");
    return;
  }
  backdrop.hidden = false;
  field.focus();
}

/* ------------------------- opening animation ----------------------------- */

/**
 * The curtain: a 1.6 s brand splash the first time the shell mounts in a
 * session. Paper field, the mark drawing itself, the wordmark staggering
 * up, a vermilion rule sweeping under it — then the whole sheet lifts.
 *
 * Deliberately conservative: once per session, never on the home page
 * (its opening sheet is the front door's own ceremony), never for
 * reduced-motion readers, click to skip, and a hard failsafe removal so
 * the splash can never be the reason a page is unreachable.
 */
function playSplash() {
  if (page === "home") return;
  try {
    if (sessionStorage.getItem("arsvibe.splash") === "1") return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    sessionStorage.setItem("arsvibe.splash", "1");
  } catch {
    return;
  }
  const el = document.createElement("div");
  el.className = "splash";
  el.id = "splash";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <div class="splash-core">
      <img class="splash-mark" src="/assets/logo.svg" alt="" width="72" height="72" />
      <div class="splash-word" aria-hidden="true">${"ArsVibe".split("").map((c) => `<span>${c}</span>`).join("")}</div>
      <div class="splash-tag">Physics Wallah · Study OS</div>
      <div class="splash-bar"><i></i></div>
    </div>`;
  document.body.appendChild(el);
  let gone = false;
  const done = () => {
    if (gone) return;
    gone = true;
    el.classList.add("splash-out");
    setTimeout(() => el.remove(), 700);
  };
  el.addEventListener("click", done);
  setTimeout(done, 1750);
  setTimeout(() => el.remove(), 3200);
}

/* --------------------------------- assembly ------------------------------- */

/* --------------------------- experience layer ----------------------------
   The advanced-chrome round: dark theme, keyboard shortcuts, scroll
   progress, connection state and the PWA install door. Every piece is
   a progressive enhancement layered on the frame — remove the whole
   block and the site is exactly what it was, only lighter-coloured. */

/** Apply the saved theme (or the OS one) before anything paints. */
function applyTheme() {
  const saved = getPrefs().theme;
  const dark = saved ? saved === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return dark;
}

function buildThemeToggle(actions) {
  if (!actions || document.getElementById("themeBtn")) return;
  const btn = document.createElement("button");
  btn.className = "notif-btn theme-btn";
  btn.id = "themeBtn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Toggle dark theme");
  const paint = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    btn.textContent = dark ? "☀️" : "🌙";
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  };
  btn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    setPref("theme", dark ? "dark" : "light");
    paint();
  });
  paint();
  actions.parentNode.insertBefore(btn, actions);
}

function buildExperience() {
  /* Scroll progress hairline + back-to-top. */
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.id = "scrollProgress";
  document.body.appendChild(bar);
  const top = document.createElement("button");
  top.className = "to-top";
  top.id = "toTop";
  top.type = "button";
  top.textContent = "↑";
  top.title = "Back to top";
  top.hidden = true;
  top.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.body.appendChild(top);
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    (window.requestAnimationFrame || ((fn) => fn()))(() => {
      ticking = false;
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, h.scrollTop / max) : 0})`;
      top.hidden = h.scrollTop < 600;
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* Connection state: a quiet pill that only speaks when it must. */
  const net = document.createElement("div");
  net.className = "net-pill";
  net.id = "netPill";
  net.hidden = true;
  document.body.appendChild(net);
  const paintNet = () => {
    const off = navigator.onLine === false;
    net.hidden = !off;
    net.textContent = off ? "📴 Offline — saved notes and downloads still open" : "";
    if (!off && net.dataset.wasOff) {
      net.hidden = false;
      net.textContent = "✅ Back online";
      setTimeout(() => { net.hidden = true; }, 2600);
    }
    net.dataset.wasOff = off ? "1" : "";
  };
  window.addEventListener("online", paintNet);
  window.addEventListener("offline", paintNet);
  paintNet();

  /* Keyboard: ? opens the shortcut sheet; g then a letter travels. */
  const sheet = document.createElement("div");
  sheet.className = "keys-sheet";
  sheet.id = "keysSheet";
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="keys-card" role="dialog" aria-label="Keyboard shortcuts">
      <div class="row between"><strong>Keyboard shortcuts</strong>
      <button class="notif-read" id="keysClose" type="button">Close ✕</button></div>
      <div class="keys-grid">
        <span><kbd>⌘K</kbd> Search batches</span>
        <span><kbd>?</kbd> This sheet</span>
        <span><kbd>g</kbd> then <kbd>h</kbd> Home</span>
        <span><kbd>g</kbd> then <kbd>b</kbd> Batches</span>
        <span><kbd>g</kbd> then <kbd>l</kbd> Live classes</span>
        <span><kbd>g</kbd> then <kbd>d</kbd> DPP tests</span>
        <span><kbd>g</kbd> then <kbd>p</kbd> Dashboard</span>
        <span><kbd>t</kbd> Dark / light theme</span>
        <span><kbd>Space</kbd>/<kbd>k</kbd> Play · pause (player)</span>
        <span><kbd>←</kbd><kbd>→</kbd> Seek 10s (player)</span>
        <span><kbd>,</kbd> <kbd>.</kbd> Frame step (player, paused)</span>
        <span><kbd>f</kbd> Fullscreen (player)</span>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.hidden = true; });
  sheet.querySelector("#keysClose").addEventListener("click", () => { sheet.hidden = true; });

  const GO = { h: "/", b: "/batches.html", l: "/live.html", d: "/dpp.html", p: "/dashboard.html" };
  let gAt = 0;
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "?") { sheet.hidden = !sheet.hidden; return; }
    if (e.key === "Escape") { sheet.hidden = true; return; }
    if (e.key.toLowerCase() === "t" && !document.getElementById("video")) {
      document.getElementById("themeBtn")?.click();
      return;
    }
    if (e.key.toLowerCase() === "g") { gAt = Date.now(); return; }
    if (gAt && Date.now() - gAt < 900 && GO[e.key.toLowerCase()]) {
      gAt = 0;
      window.location.assign(GO[e.key.toLowerCase()]);
    }
  });

  /* Instant navigation: the moment a finger or cursor commits to a
     same-origin link (pointerdown beats click by ~100ms), fetch the
     page into the HTTP cache so the click lands on warm bytes. Hover
     prefetch already exists in ui.js; this covers touch, where there
     is no hover. One prefetch per URL per page, documents only. */
  const prefetched = new Set();
  document.addEventListener("pointerdown", (e) => {
    const a = e.target?.closest?.("a[href]");
    if (!a) return;
    const url = new URL(a.getAttribute("href"), window.location.href);
    if (url.origin !== window.location.origin) return;
    if (!/\.html$|^\/$/.test(url.pathname)) return;
    const key = url.pathname + url.search;
    if (prefetched.has(key)) return;
    prefetched.add(key);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = key;
    document.head.appendChild(link);
  }, { passive: true });

  /* Resume chip: the last lecture you left mid-way, one tap back in,
     on every page except the player itself. Reads the same library +
     position keys the home rail reads; dismisses for the session. */
  try {
    if (!document.getElementById("video") && sessionStorage.getItem("arsvibe.resume.hide") !== "1") {
      const lib = JSON.parse(localStorage.getItem("arsvibe.library") || "{}");
      const lectures = Array.isArray(lib.lectures) ? lib.lectures : [];
      const last = lectures
        .map((l) => ({ ...l, pos: Number(localStorage.getItem(`pos:${l.id}`) || 0) }))
        .filter((l) => l.pos > 12 && l.id && l.batch)
        .sort((a, b) => b.pos - a.pos)[0];
      if (last) {
        const chip = document.createElement("div");
        chip.className = "resume-chip";
        chip.id = "resumeChip";
        const href = `/watch.html?batch=${encodeURIComponent(last.batch)}&subject=${encodeURIComponent(last.subject || "")}&id=${encodeURIComponent(last.id)}&title=${encodeURIComponent(last.title || "Lecture")}`;
        chip.innerHTML = `
          <a class="resume-chip-main" href="${href}">
            <span class="resume-chip-play">▶</span>
            <span class="resume-chip-text"><strong>${esc(last.title || "Lecture")}</strong>
            <em>Resume at ${Math.floor(last.pos / 60)}:${String(last.pos % 60).padStart(2, "0")}</em></span>
          </a>
          <button class="resume-chip-x" type="button" aria-label="Dismiss">✕</button>`;
        chip.querySelector(".resume-chip-x").addEventListener("click", () => {
          sessionStorage.setItem("arsvibe.resume.hide", "1");
          chip.remove();
        });
        document.body.appendChild(chip);
      }
    }
  } catch { /* storage unavailable: no chip, no noise */ }

  /* Install door: appears only when the browser offers it. */
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    if (document.getElementById("installBtn")) return;
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm install-btn";
    btn.id = "installBtn";
    btn.type = "button";
    btn.textContent = "⬇ Install app";
    btn.title = "Install ArsVibe as an app";
    btn.addEventListener("click", async () => {
      btn.remove();
      try { await e.prompt(); } catch { /* the browser declined */ }
    });
    document.querySelector(".side-foot")?.appendChild(btn);
  });
}

function mount() {
  applyTheme();
  if (document.getElementById("side")) return;

  // The sign-in screen and the bare error page get the atmosphere, not the app
  // frame: a sidebar there would imply a signed-in session that does not exist.
  const hasChrome = Boolean(document.querySelector(".nav"));
  if (!hasChrome) {
    document.body.classList.add("bare");
    return;
  }

  playSplash();

  buildExperience();
  const aside = buildSidebar();
  document.body.insertBefore(aside, document.body.firstChild);
  document.body.classList.add("has-shell");

  // Collapsed rail: a preference, not a per-page state, so it survives
  // navigation. Read before paint-ish (the module runs at the end of the body).
  if (getPrefs().sideRail) document.body.classList.add("side-rail");

  // The rail is a one-way door unless the head reopens it: at 68px the head is
  // the only thing left on screen, so that is where the way back has to live.
  const head = aside.querySelector(".side-head");
  const setRail = (rail) => {
    document.body.classList.toggle("side-rail", rail);
    setPref("sideRail", rail);
    if (!head) return;
    // aria-expanded describes the nav panel, which is open when not railed.
    head.setAttribute("aria-expanded", String(!rail));
    head.setAttribute("aria-label", rail ? "Expand sidebar" : "Collapse sidebar");
    if (rail) {
      head.setAttribute("role", "button");
      head.tabIndex = 0;
    } else {
      head.removeAttribute("role");
      head.removeAttribute("tabindex");
    }
  };
  setRail(document.body.classList.contains("side-rail"));

  aside.querySelector("[data-side-collapse]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    setRail(!document.body.classList.contains("side-rail"));
  });

  head?.addEventListener("click", (e) => {
    if (!document.body.classList.contains("side-rail")) return;
    if (e.target.closest("button")) return;
    // Collapsed, the brand is a 68px glyph in a row that means "expand me",
    // not "go home", so swallow the navigation and open the panel.
    e.preventDefault();
    setRail(false);
  });

  head?.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("side-rail")) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setRail(false);
  });

  // Remember which groups the reader folded shut.
  const folded = getPrefs().sideFolded || [];
  if (Array.isArray(folded) && folded.length) {
    for (const key of folded) {
      const group = aside.querySelector(`details[data-group="${key}"]`);
      if (group) group.open = false;
    }
  }
  aside.querySelectorAll("details.side-group").forEach((group) => {
    group.addEventListener("toggle", () => {
      const closed = [...aside.querySelectorAll("details.side-group")]
        .filter((g) => !g.open)
        .map((g) => g.dataset.group);
      setPref("sideFolded", closed);
    });
  });

  // The favourites count lives on the link itself. It is repainted from the
  // store on load, on every heart anywhere on the page, and when another tab
  // changes the list.
  const favCount = aside.querySelector("[data-fav-count]");
  const paintFavCount = () => {
    if (!favCount) return;
    const n = favouriteCount();
    favCount.textContent = String(n);
    favCount.hidden = n === 0;
  };
  paintFavCount();
  document.addEventListener("favourites:change", paintFavCount);

  buildTopbar();

  // A scrim for the mobile drawer.
  const scrim = document.createElement("div");
  scrim.className = "side-scrim";
  scrim.addEventListener("click", () => document.body.classList.remove("nav-open"));
  document.body.appendChild(scrim);

  document.getElementById("navToggle")?.addEventListener("click", () => {
    document.body.classList.toggle("nav-open");
  });

  // One handler for every search affordance on the page.
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-open-search]");
    if (trigger) {
      e.preventDefault();
      openSearch();
    }
    const link = e.target.closest(".side-link, .side-mini");
    if (link) document.body.classList.remove("nav-open");
  });
}

mount();

/* ------------------------------------------------------------------
   Instant navigation (site-wide engineering): teach the browser to
   prepare the next page before the click lands.

   Chromium gets Speculation Rules — same-origin pages prerender in
   a hidden tab on hover (moderate eagerness) and swap in instantly.
   Every other engine gets the classic trick with the same trigger:
   a <link rel="prefetch"> the first time a link is hovered or
   touched. External links, downloads and the API are never warmed:
   prerendering must not spend a student's data on pages they may
   never open, so data-saver and 2G sit this out entirely.
   ------------------------------------------------------------------ */
(function instantNav() {
  try {
    const conn = navigator.connection || {};
    if (conn.saveData || /^(slow-)?2g$/.test(conn.effectiveType || "")) return;
    const warm = new Set();
    const prepare = (href) => {
      if (!href || warm.has(href)) return;
      warm.add(href);
      const l = document.createElement("link");
      l.rel = "prefetch";
      l.href = href;
      document.head.appendChild(l);
    };
    if (HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")) {
      const rules = document.createElement("script");
      rules.type = "speculationrules";
      rules.textContent = JSON.stringify({
        prerender: [
          {
            where: {
              and: [
                { href_matches: "/*" },
                { not: { href_matches: "/api/*" } },
                { not: { selector_matches: "[download], [data-no-prerender]" } },
              ],
            },
            eagerness: "moderate",
          },
        ],
      });
      document.head.appendChild(rules);
      return; // the browser schedules prerenders itself
    }
    document.addEventListener(
      "pointerover",
      (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const u = new URL(a.getAttribute("href"), location.href);
        if (u.origin === location.origin && !u.pathname.startsWith("/api/")) prepare(u.pathname + u.search);
      },
      { passive: true }
    );
  } catch {
    /* instant nav is an optimisation, never a dependency */
  }
})();

/* ------------------------------------------------------------------
   Adaptive Performance Engine (site-wide): the site reads the
   device it is running on and chooses how much spectacle it may
   afford — flagship phones get the full aurora, a 2 GB phone on a
   draining battery gets the same content with the fireworks off.

   Signals: connection class + data-saver, deviceMemory,
   hardwareConcurrency, battery level/charging. The verdict lands
   on <html data-perf="ultra|balanced|lite"> (CSS throttles blur
   and decorative motion in the lower tiers), animations pause
   while the tab is hidden, and on strong devices the catalogue is
   warmed during idle time so the batches page opens instantly.
   ------------------------------------------------------------------ */
(function perfEngine() {
  try {
    const rootEl = document.documentElement;
    const conn = navigator.connection || {};
    const mem = Number(navigator.deviceMemory || 4);
    const cores = Number(navigator.hardwareConcurrency || 4);
    const slowNet = Boolean(conn.saveData) || /^(slow-)?2g$|^3g$/.test(conn.effectiveType || "");
    let tier = "ultra";
    if (conn.saveData || /^(slow-)?2g$/.test(conn.effectiveType || "") || mem <= 2 || cores <= 2) tier = "lite";
    else if (slowNet || mem <= 4 || cores <= 4) tier = "balanced";
    const apply = (t) => {
      rootEl.dataset.perf = t;
      window.ArsVibePerf = { tier: t, mem, cores, effectiveType: conn.effectiveType || "" };
    };
    apply(tier);
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        const check = () => {
          if (!b.charging && b.level <= 0.2) apply("lite");
        };
        check();
        b.addEventListener("levelchange", check);
        b.addEventListener("chargingchange", check);
      }).catch(() => {});
    }
    // Nothing animates for an audience of zero.
    const onVis = () => rootEl.classList.toggle("page-hidden", document.hidden);
    document.addEventListener("visibilitychange", onVis);
    onVis();
    // Idle warm-up (strong devices, fast networks only): the
    // catalogue JSON and the heaviest style asset will be wanted
    // within the next click or two — fetch them while the CPU is
    // bored instead of when the student is waiting.
    if (tier === "ultra" && !slowNet && "requestIdleCallback" in window) {
      requestIdleCallback(
        () => {
          fetch("/api/batches", { credentials: "same-origin" }).catch(() => {});
        },
        { timeout: 4000 }
      );
    }
  } catch {
    /* adaptation is an optimisation, never a dependency */
  }
})();
