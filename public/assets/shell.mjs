/* =========================================================================
   ArsVibe — application shell
   -------------------------------------------------------------------------
   Turns the ten flat pages into one coherent app: a persistent sidebar, a top
   bar with search and account, and a consistent content column.

   Written as progressive enhancement. Every page already works without it —
   the shell adds structure, it does not own any page's data. If this module
   fails to load, each page falls back to the nav it shipped with.
   ========================================================================= */

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
      { id: "search", href: "#search", label: "Search", icon: "search", kbd: "⌘K" },
    ],
  },
  {
    key: "study",
    title: "Study",
    items: [
      { id: "favourites", href: "/favourites.html", label: "Favourites", icon: "heart", badge: "fav" },
      { id: "library", href: "/library.html", label: "My Library", icon: "bookmark" },
      { id: "dashboard", href: "/dashboard.html", label: "Dashboard", icon: "chart" },
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
  chart: '<path d="M4 19V9M10 19V4M16 19v-6M22 19H2"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 2.4 14.4 0 17M12 3.5c-2.4 2.6-2.4 14.4 0 17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  heart: '<path d="M12 20.3 4.9 13.4a4.2 4.2 0 0 1 0-6 4.3 4.3 0 0 1 6 0l1.1 1.1 1.1-1.1a4.3 4.3 0 0 1 6 0 4.2 4.2 0 0 1 0 6Z"/>',
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
        return `<a class="side-link${active}" href="${item.href}" data-label="${item.label}">${icon(item.icon)}<span>${item.label}</span>${
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

    <nav class="side-nav" aria-label="Site">${groups}${recentBlock}</nav>

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

/* --------------------------------- assembly ------------------------------- */

function mount() {
  if (document.getElementById("side")) return;

  // The sign-in screen and the bare error page get the atmosphere, not the app
  // frame: a sidebar there would imply a signed-in session that does not exist.
  const hasChrome = Boolean(document.querySelector(".nav"));
  if (!hasChrome) {
    document.body.classList.add("bare");
    return;
  }

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
