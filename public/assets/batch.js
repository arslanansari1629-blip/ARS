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
 * Mounted once and kept, because the walk over the batch's chapters is the expensive
 * part — switching to Announcements and back must not start it again. The subjects
 * it needs are the batch's own, so it waits for them.
 */
let dppPanel = null;
let dppPanelBatch = "";

function dppHost() {
  let host = document.getElementById("dppPanel");
  if (!host) {
    host = document.createElement("div");
    host.id = "dppPanel";
    host.className = "dpp-panel";
    tabBody.appendChild(host);
  }
  return host;
}

function renderDpp() {
  const host = dppHost();
  if (!batch) {
    host.innerHTML = emptyState("Loading the batch", "The papers appear once its subjects do.");
    return;
  }
  if (!batch.subjects || !batch.subjects.length) {
    host.innerHTML = emptyState(
      "No subjects to walk",
      "A DPP lives under a chapter, and this batch lists none yet."
    );
    return;
  }
  // One panel per batch: a re-render of the page must not leave a second walk
  // running against the same catalogue.
  if (dppPanel && dppPanelBatch === batch.id) return;
  dppPanelBatch = batch.id;
  dppPanel = mountDppPanel(host, { batch: batch.id, subjects: batch.subjects });
}

function setTab(next) {
  tab = next;
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  if (tab !== "dpp") {
    // Leave the list alone but drop the host, so returning repaints it without
    // walking the catalogue again.
    tabBody.querySelector("#dppPanel")?.remove();
  }
  if (tab === "subjects") renderSubjects();
  if (tab === "dpp") renderDpp();
  if (tab === "about") renderAbout();
  if (tab === "announcements") renderAnnouncements();
}

document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => setTab(btn.dataset.tab))
);

// A link can open the DPP tab directly (`/batch?id=…#dpp`), the way a chapter's
// `#dpp` opens its DPP list — the same fragment means the same thing on both pages.
if ((location.hash || "").replace("#", "").toLowerCase() === "dpp") {
  setTab("dpp");
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
