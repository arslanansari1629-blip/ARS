/* Batch detail — subjects, announcements, about */

import {
  mountChrome,
  esc,
  money,
  qs,
  toast,
  fmtDate,
  fmtRelative,
  rememberBatch,
  emptyState,
  setPageMeta,
  setStructuredData,
  clamp,
  ORIGIN,
} from "./app.js";
import { trackBatch } from "./library.js";
import { isFavourite, toggleFavourite, wireFavourites } from "./favourites.js";
import { loadBatch as fetchBatchData, loadBatchHeader, loadAnnouncements } from "./data.js";
import { mountDppPanel } from "./dpp-panel.js";
import { mountKhazana, khazanaMarkup } from "./khazana.js";

mountChrome("batches");
wireFavourites();

const batchId = qs("id");
const detailGrid = document.getElementById("detailGrid");
const detailBg = document.getElementById("detailBg");
const crumbName = document.getElementById("crumbName");
const tabBody = document.getElementById("tabBody");

let batch = null;
let tab = "subjects";

if (!batchId) {
  detailGrid.innerHTML = emptyState("No batch selected", "Open a batch from the catalogue.", `<a class="btn btn-primary" href="/batches.html">Browse batches</a>`);
} else {
  // Two requests, deliberately. The hero is painted from the shipped catalogue
  // row (a local lookup, tens of milliseconds), so the page is never a blank
  // skeleton while `/BatchInfo` is slow; the subject list then fills in behind
  // it. Superseded hero renders are ignored so the upstream record always wins.
  loadBatch();
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function renderDetail() {
  document.title = `${batch.name} — ArsVibe PW`;
  // The shareable identity of this page: a link to a batch should preview the
  // batch, not the site.
  setPageMeta({
    title: `${batch.name} — ArsVibe PW`,
    description: clamp(
      `${batch.name}${batch.language ? ` (${batch.language})` : ""} — every subject, chapter and ` +
        `lecture list, with all its class notes and DPPs free to read on ArsVibe.`
    ),
    canonical: `${ORIGIN}/batch?id=${encodeURIComponent(batch.id || qs("id") || "")}`,
    image: batch.image || undefined,
  });
  setStructuredData({
    "@context": "https://schema.org",
    "@type": "Course",
    name: batch.name,
    description: clamp(
      `${batch.name} — every subject, chapter, lecture, class notes and DPP in this Physics Wallah batch.`,
      300
    ),
    url: `${ORIGIN}/batch?id=${encodeURIComponent(batch.id || qs("id") || "")}`,
    image: batch.image || undefined,
    inLanguage: batch.language || "en",
    isAccessibleForFree: true,
    provider: {
      "@type": "EducationalOrganization",
      name: "Physics Wallah",
      url: "https://www.pw.live/",
    },
  });
  crumbName.textContent = batch.name;
  if (batch.image) detailBg.style.backgroundImage = `url("${batch.image}")`;

  const cover = batch.image
    ? `<img src="${esc(batch.image)}" alt="" fetchpriority="high" decoding="async" width="1200" height="675" onerror="this.remove()" />`
    : `<div class="cover-initials">${esc(initials(batch.name))}</div>`;

  detailGrid.innerHTML = `
    <div class="detail-cover">${cover}</div>
    <div class="detail-head">
      <div class="row gap-1">
        ${batch.exam && batch.exam.length ? `<span class="pill pill-brand">${esc(batch.exam.join(" · "))}</span>` : ""}
        ${batch.className ? `<span class="pill">Class ${esc(batch.className)}</span>` : ""}
        ${batch.language ? `<span class="pill">${esc(batch.language)}</span>` : ""}
        ${batch.isFree ? `<span class="pill pill-accent">Free</span>` : ""}
      </div>
      <h1>${esc(batch.name)}</h1>
      <p class="muted">${esc(batch.byName || "Physics Wallah")}</p>
      <div class="detail-meta">
        ${batch.startDate ? `<span class="pill">Starts ${esc(fmtDate(batch.startDate))}</span>` : ""}
        ${batch.endDate ? `<span class="pill">Ends ${esc(fmtDate(batch.endDate))}</span>` : ""}
        ${batch.price ? `<span class="pill pill-brand">${esc(money(batch.price))}</span>` : ""}
        <span class="pill">${batch.subjects.length} subjects</span>
      </div>
      <div class="row mt-2">
        ${batch.subjects.length ? `<button class="btn btn-primary" id="startBtn">Start learning</button>` : ""}
        <button class="btn btn-ghost fav-wide${isFavourite(batch.id) ? " on" : ""}" id="favBatchBtn" type="button"
          aria-pressed="${isFavourite(batch.id)}">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 20.3 4.9 13.4a4.2 4.2 0 0 1 0-6 4.3 4.3 0 0 1 6 0l1.1 1.1 1.1-1.1a4.3 4.3 0 0 1 6 0 4.2 4.2 0 0 1 0 6Z"/></svg>
          <span id="favBatchText">${isFavourite(batch.id) ? "Saved" : "Favourite"}</span>
        </button>
      </div>
    </div>`;

  // The wide favourite button on a batch page speaks the card hearts' language:
  // same store, same event, painted in place instead of re-rendering the page.
  document.getElementById("favBatchBtn")?.addEventListener("click", () => {
    const now = toggleFavourite(batch);
    const btn = document.getElementById("favBatchBtn");
    btn?.classList.toggle("on", now);
    btn?.setAttribute("aria-pressed", String(now));
    const label = document.getElementById("favBatchText");
    if (label) label.textContent = now ? "Saved" : "Favourite";
    toast(now ? "Added to favourites" : "Removed from favourites");
  });

  document.getElementById("startBtn")?.addEventListener("click", () => {
    const first = batch.subjects[0];
    location.href = `/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(first.slug)}&name=${encodeURIComponent(first.name)}`;
  });
}

function renderSubjects() {
  if (!batch.subjects.length) {
    tabBody.innerHTML = emptyState(
      "No subjects published yet",
      "This batch has no subject list published yet. Check back after the next upload."
    );
    return;
  }
  tabBody.innerHTML = `<div class="grid grid-subjects">${batch.subjects
    .map(
      (s) => `
      <a class="subject-card fade-up" href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(s.slug)}&name=${encodeURIComponent(s.name)}">
        ${s.image ? `<img class="icon" src="${esc(s.image)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'icon',textContent:'${esc(initials(s.name))}'}))" />` : `<div class="icon">${esc(initials(s.name))}</div>`}
        <div class="grow">
          <div class="name">${esc(s.name)}</div>
          <div class="sub">${s.lectureCount ? `${s.lectureCount} lectures` : "Open chapter list"}${s.tagCount ? ` · ${s.tagCount} chapters` : ""}</div>
        </div>
        <svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
      </a>`
    )
    .join("")}</div>`;
}

function renderAbout() {
  const parts = [];
  if (batch.shortDescription) parts.push(`<div class="detail-about">${esc(batch.shortDescription)}</div>`);
  if (batch.description) parts.push(`<div class="detail-about mt-3">${esc(batch.description)}</div>`);
  if (batch.banners && batch.banners.length) {
    parts.push(
      `<div class="grid grid-cards mt-4">${batch.banners
        .slice(0, 6)
        .map((b) => `<img class="banner-plate" src="${esc(b)}" alt="" loading="lazy" />`)
        .join("")}</div>`
    );
  }
  tabBody.innerHTML = parts.join("") || emptyState("No description", "The source batch carries no description text.");
}

async function renderAnnouncements() {
  tabBody.innerHTML = `<div class="list">${Array.from({ length: 4 })
    .map(() => `<div class="skeleton sk-row"></div>`)
    .join("")}</div>`;
  try {
    const out = await loadAnnouncements(batchId);
    const items = out.items || [];
    if (!items.length) {
      tabBody.innerHTML = emptyState("No announcements", "This batch has no updates published right now.");
      return;
    }
    tabBody.innerHTML = `<div class="list">${items
      .map(
        (a) => `
        <article class="card pad-row">
          <div class="row between start">
            <div>
              <div class="row gap-1">
                <span class="pill pill-brand">${esc(a.useCase || a.type || "Update")}</span>
                <span class="tiny dim">${esc(fmtRelative(a.createdAt))}</span>
              </div>
              <h3 class="mt-2">${esc(a.heading)}</h3>
              <p class="tiny muted" class="mt-1">${esc(a.message)}</p>
              <p class="tiny dim" class="mt-1">by ${esc(a.author)}</p>
            </div>
            ${a.attachment ? `<a class="btn btn-ghost btn-sm" href="${esc(a.attachment.url)}" target="_blank" rel="noopener">Attachment</a>` : ""}
          </div>
        </article>`
      )
      .join("")}</div>`;
  } catch (err) {
    tabBody.innerHTML = emptyState("Announcements unavailable", err.message);
  }
}

/**
 * The DPP panel: every practice paper in the batch, in one list.
 *
 * Mounted once and kept as a *node*, because two things about it are expensive:
 * the walk over the batch's chapters, and the bindings `mountDppPanel` sets on
 * its search box, subject filter and "show more" control.
 *
 * The first version removed the panel's node when you left the tab and let the
 * next visit build a fresh, empty host. Both the bindings and the papers went
 * with it, so the second visit rendered a blank panel for ever — which is what
 * "the DPP panel is not opening" looks like from outside. Taking the node out
 * of the document and putting the same one back keeps everything: the mount,
 * the search text, the filter, the papers already found, the scroll position.
 */
let dppPanel = null;
let dppPanelBatch = "";
/** The panel's node while it is out of the tab, so a return can re-use it. */
let detachedDpp = null;

/** Puts the kept panel back in the tab, and says whether it had one. */
function reattachDpp() {
  if (!detachedDpp) return false;
  const host = detachedDpp;
  detachedDpp = null;
  if (host.parentElement !== tabBody) tabBody.replaceChildren(host);
  return true;
}

/**
 * The host element for the panel.
 *
 * The tab body is rewritten by every other tab, so a placeholder is created on
 * demand. The *mounted* panel always wins over any placeholder, whether it is in
 * the tab or out of it, so this page can never end up with two.
 */
function dppHost() {
  reattachDpp();
  const existing = document.getElementById("dppPanel");
  if (existing) {
    if (existing.parentElement !== tabBody) tabBody.replaceChildren(existing);
    return existing;
  }
  const host = document.createElement("div");
  host.id = "dppPanel";
  host.className = "dpp-panel";
  tabBody.replaceChildren(host);
  return host;
}

function renderDpp() {
  const mounted = Boolean(dppPanel) && dppPanelBatch === batch?.id;

  if (!batch) {
    // The panel is only replaced with this message when it is not already up:
    // a slow detail call must not wipe a walk that is already running.
    if (!mounted) dppHost().innerHTML = emptyState("Loading the papers", "The batch's subjects are still arriving.");
    else reattachDpp();
    return;
  }

  if (mounted) {
    // Re-use: same node, same bindings, same papers. The walk does not restart.
    reattachDpp();
    return;
  }

  if (!batch.subjects || !batch.subjects.length) {
    dppHost().innerHTML = emptyState(
      "No papers in this batch",
      "A DPP lives under a chapter, and this batch lists no subjects yet. Lecture notes are still on its subject pages."
    );
    return;
  }

  dppPanelBatch = batch.id;
  dppPanel = mountDppPanel(dppHost(), { batch: batch.id, subjects: batch.subjects });
}

function setTab(next) {
  tab = next;
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  if (tab !== "dpp") {
    // Taken out of the document, not discarded: the panel keeps its bindings,
    // its papers and its filters, so coming back is instant and starts no walk.
    const host = document.getElementById("dppPanel");
    if (host && dppPanel) {
      host.remove();
      detachedDpp = host;
    }
  }
  if (tab === "subjects") renderSubjects();
  if (tab === "dpp") renderDpp();
  if (tab === "khazana") renderKhazana();
  if (tab === "about") renderAbout();
  if (tab === "announcements") renderAnnouncements();
}

/**
 * The Khazana tab.
 *
 * Rendered from the pointer the batch payload already carries, so opening the tab
 * costs nothing until there is something to read. A batch without a pointer never
 * makes a request — which is most of the catalogue — and says so in a sentence
 * rather than showing an empty grid.
 */
let khazanaRead = null;

function renderKhazana() {
  const pointer = (batch && batch.khazana && batch.khazana.programId) || "";
  if (!pointer) {
    tabBody.innerHTML = khazanaMarkup({ khazana: { state: "none" } });
    return;
  }
  // Reading it again on every tab switch would spend three upstream probes per
  // click for an answer that cannot change inside a page view.
  if (khazanaRead) {
    tabBody.innerHTML = khazanaMarkup(khazanaRead);
    return;
  }
  tabBody.innerHTML = khazanaMarkup({ khazana: { state: "known" }, reading: true });
  const host = document.createElement("div");
  tabBody.innerHTML = "";
  tabBody.appendChild(host);
  mountKhazana(host, { programId: pointer }).then((out) => {
    khazanaRead = { khazana: (out && out.khazana) || { state: "error" }, subjects: (out && out.subjects) || [] };
    // The reader may have switched tabs while the archive was being read.
    if (tab === "khazana") tabBody.innerHTML = khazanaMarkup(khazanaRead);
  });
}

document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => setTab(btn.dataset.tab))
);

// A link can open the DPP tab directly (`/batch?id=…#dpp`), the way a chapter's
// `#dpp` opens its DPP list — the same fragment means the same thing on both pages.
if ((location.hash || "").replace("#", "").toLowerCase() === "dpp") {
  setTab("dpp");
}
// The same fragment means the same thing here as it does on a chapter: `#khazana`
// opens the archive tab, so a link can point at it.
if ((location.hash || "").replace("#", "").toLowerCase() === "khazana") {
  setTab("khazana");
}

async function loadHeader() {
  const header = await loadBatchHeader(batchId).catch(() => null);
  // If the detailed record beat us here, its render is the better one.
  if (!header || batch) return;
  batch = header.batch;
  renderDetail();
  if (!batch.subjects.length) {
    tabBody.innerHTML = `<div class="list">${Array.from({ length: 4 })
      .map(() => `<div class="skeleton sk-row"></div>`)
      .join("")}</div>`;
  }
}

async function loadBatch() {
  const headerPromise = loadHeader();
  try {
    const out = await fetchBatchData(batchId);
    batch = out.batch;
    batch.subjects = out.subjects || [];
    renderDetail();
    renderSubjects();
    // The subject list comes from a second upstream call that can be
    // rate-limited. Show that plainly instead of an empty-looking page, and
    // point at the source player rather than leaving the reader stuck.
    if (out.degraded || batch.degraded) {
      tabBody.innerHTML = emptyState(
        "Subject list is loading slowly",
        "The lecture index did not answer this time. The batch itself is fine — retry in a moment.",
        `<button class="btn btn-primary" id="retryBatchBtn">Retry</button>`
      );
      document.getElementById("retryBatchBtn")?.addEventListener("click", () => loadBatch());
      return;
    }
    if (tab === "dpp") renderDpp();
    if (tab === "khazana") renderKhazana();
    rememberBatch({ id: batch.id, name: batch.name, image: batch.image });
    trackBatch({ id: batch.id, name: batch.name, image: batch.image });
    document.getElementById("detailGrid").classList.add("fade-up");
    await headerPromise;
  } catch (err) {
    detailGrid.innerHTML = emptyState("Batch unavailable", err.message, `<a class="btn btn-primary" href="/batches.html">Back to batches</a>`);
    tabBody.innerHTML = "";
    toast(err.message, "error");
  }
}
