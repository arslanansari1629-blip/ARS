/* Chapter contents: lectures, notes (PDF), DPPs */

import {
  mountChrome,
  esc,
  qs,
  toast,
  emptyState,
  fmtDate,
  setPageMeta,
  clamp,
  ORIGIN,
} from "./app.js";
import { loadContents } from "./data.js";

mountChrome("batches");

const batchId = qs("batch");
const subjectSlug = qs("subject");
const chapterId = qs("chapter");
const chapterName = qs("name");

const body = document.getElementById("body");
const chapterNameEl = document.getElementById("chapterName");
const chapterMeta = document.getElementById("chapterMeta");
const crumbs = document.getElementById("crumbs");
const tabs = document.getElementById("tabs");

let type = "videos";
const cache = new Map();

if (chapterName) {
  chapterNameEl.textContent = chapterName;
  document.title = `${chapterName} — ArsVibe PW`;
  setPageMeta({
    title: `${chapterName} — ArsVibe PW`,
    description: clamp(
      `${chapterName}: lecture list, class notes and daily practice problems (DPPs) in order, with every PDF free to read.`
    ),
    canonical: `${ORIGIN}/chapter?batch=${encodeURIComponent(batchId)}&chapter=${encodeURIComponent(chapterId)}`,
  });
}

if (!batchId || !subjectSlug || !chapterId) {
  body.innerHTML = emptyState("Missing chapter", "Open a chapter from a subject page.", `<a class="btn btn-primary" href="/batches.html">Browse batches</a>`);
} else {
  buildCrumbs();
  load("videos");
}

function buildCrumbs() {
  crumbs.innerHTML = `<a href="/">Home</a> <span>/</span>
    <a href="/batch.html?id=${encodeURIComponent(batchId)}">Batch</a> <span>/</span>
    <a href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subjectSlug)}">Subject</a> <span>/</span>
    <span class="truncate">${esc(chapterName || "Chapter")}</span>`;
}

function watchUrl(item) {
  return `/lecture.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(
    subjectSlug
  )}&id=${encodeURIComponent(item.id)}&title=${encodeURIComponent(item.title)}`;
}

/**
 * Flag whether a lecture actually has something to play.
 *
 * The chapter listing never contains the stream URL (that only comes from
 * `Schedule`), but it does say how the item was published: a `PDF`/`NOTES`
 * entry is material only, and a class without any rendition list or with a
 * pending status has no recording yet. Saying so on the row saves the user a
 * dead click into an empty player.
 */
function streamBadge(item) {
  const type = String(item.lectureType || "").toUpperCase();
  const status = String(item.status || "").toLowerCase();
  const renditions = Array.isArray(item.types) ? item.types : [];
  const hasStream = Boolean(item.videoId) || renditions.length > 0;

  if (/PDF|NOTE|DOC/.test(type)) {
    return `<span class="badge-soon">Notes only</span>`;
  }
  if (hasStream || /^(ready|completed|published)$/.test(status)) {
    return `<span class="badge-live">Video ready</span>`;
  }
  return `<span class="badge-soon">Recording pending</span>`;
}

function videoRow(item, index) {
  return `
    <a class="list-row fade-up" href="${watchUrl(item)}">
      <span class="index">${String(index + 1).padStart(2, "0")}</span>
      <span class="grow">
        <span class="title">${esc(item.title)}</span>
        <span class="meta">
          ${item.date ? `<span>${esc(fmtDate(item.date))}</span>` : ""}
          ${item.duration ? `<span>${esc(item.duration)}</span>` : ""}
          ${item.lectureType ? `<span>${esc(item.lectureType)}</span>` : ""}
          ${streamBadge(item)}
        </span>
      </span>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-2)" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" fill="var(--brand-2)" stroke="none"/></svg>
    </a>`;
}

function docRow(doc) {
  const viewer = `/viewer.html?url=${encodeURIComponent(doc.url)}&name=${encodeURIComponent(doc.name)}`;
  // `data-keep` names the relay URL the worker should store — the same bytes the
  // reader shows, so the copy that is kept is the copy that will open.
  const keep = `/api/media?url=${encodeURIComponent(doc.url)}`;
  return `
    <div class="doc-row fade-up">
      <span class="pdf">PDF</span>
      <span class="grow">
        <span class="name">${esc(doc.name)}</span>
        <span class="meta">${esc(doc.topic || doc.note || "Document")}</span>
      </span>
      <button class="btn btn-ghost btn-sm keep-btn" type="button" data-keep="${esc(keep)}" title="Keep this file on this device" aria-label="Keep ${esc(doc.name)} on this device">Keep</button>
      <a class="btn btn-ghost btn-sm" href="${viewer}" target="_blank" rel="noopener">Open</a>
      <a class="btn btn-ghost btn-sm" href="/api/media?url=${encodeURIComponent(doc.url)}" download>Download</a>
    </div>`;
}

function docItemRow(item) {
  const docs = item.docs || [];
  return `
    <div class="card fade-up pad-sm">
      <div class="row between mb-2">
        <strong class="strong-sm">${esc(item.title)}</strong>
        ${item.date ? `<span class="tiny dim">${esc(fmtDate(item.date))}</span>` : ""}
      </div>
      <div class="list tight">
        ${docs.map(docRow).join("") || `<div class="tiny dim pad-xs">No file attached.</div>`}
      </div>
    </div>`;
}

async function load(nextType) {
  type = nextType;
  tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.type === type));

  if (cache.has(type)) return render(cache.get(type));

  body.innerHTML = `<div class="list">${Array.from({ length: 5 })
    .map(() => `<div class="skeleton sk-row"></div>`)
    .join("")}</div>`;

  try {
    const out = await loadContents(batchId, subjectSlug, chapterId, type);
    cache.set(type, out.items || []);
    render(out.items || []);
  } catch (err) {
    /* An upstream that refuses guest sessions is not a broken page: the chapter
       exists, the lectures are there, and this deployment is simply not allowed
       to list them. Say that, and stay quiet — a red toast for a fact nobody can
       act on reads as "the site is broken", which it is not. */
    if (err && err.auth) {
      body.innerHTML = emptyState(
        "This chapter needs a PW account",
        err.message,
        `<a class="btn btn-ghost btn-sm" href="/batches.html">Browse another batch</a>`
      );
      toast("Physics Wallah is not serving this chapter to guests right now", "info");
      return;
    }
    body.innerHTML = emptyState("Could not load this section", err.message);
    toast(err.message, "error");
  }
}

function render(items) {
  if (!items.length) {
    const label = { videos: "lectures", notes: "notes", DppNotes: "DPPs", DppVideos: "DPP solutions" }[type];
    body.innerHTML = emptyState(`No ${label} yet`, "The source chapter has nothing published in this section.");
    chapterMeta.textContent = "";
    return;
  }

  if (type === "videos" || type === "DppVideos") {
    const label = type === "videos" ? "lectures" : "DPP solution videos";
    // Playability is decided per lecture by the source, not by this list, so
    // link the whole-chapter verification next to the count.
    // The verification sweep is a diagnostic, not a promise. While PW signs
    // nothing for a guest session every lecture resolves as unplayable, so a
    // "verify playback" link here sends people to watch a list of failures and
    // conclude the site is broken. Offer it only as a footnote when a stream has
    // actually resolved at least once this session.
    const check = "";
    chapterMeta.innerHTML = `${items.length} ${label}${
      check ? ` ${check}` : ""
    } · <span class="tiny dim">stream links need a PW account</span>`;

    // A chapter whose lectures all refuse to play still has value: the list is a
    // syllabus and the notes are readable. Say which part works, once, above the
    // list — instead of leaving 148 rows that each fail on click with no warning.
    const notice =
      type === "videos"
        ? `<p class="tiny dim chapter-hint">Lecture titles and order are complete. Playing a lecture needs a signed-in Physics Wallah account — the <strong>Notes</strong> and <strong>DPPs</strong> tabs above are free and open.</p>`
        : "";
    body.innerHTML = `${notice}<div class="list">${items.map(videoRow).join("")}</div>`;
  } else {
    const total = items.reduce((n, i) => n + (i.docs ? i.docs.length : 0), 0);
    chapterMeta.textContent = `${total} PDF${total === 1 ? "" : "s"} available`;
    body.innerHTML = `<div class="list">${items.map(docItemRow).join("")}</div>`;
  }
}

tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  load(btn.dataset.type);
});

/**
 * Keep a notes or DPP file on this device.
 *
 * Delegated from the list, because the rows are re-rendered on every tab change
 * and per-row listeners would be added and thrown away with them. The button
 * reports what the worker actually did — "Kept" only after the cache holds the
 * file, never on the strength of having asked.
 */
body.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-keep]");
  if (!btn) return;
  event.preventDefault();
  if (btn.dataset.busy === "1" || btn.dataset.kept === "1") return;

  const url = btn.dataset.keep;
  // `busy` guards the whole operation, including the wait: a second click while
  // the first is polling would start a second poll against the same file.
  btn.dataset.busy = "1";
  const restore = (label) => {
    btn.textContent = label;
    btn.dataset.busy = "0";
  };

  try {
    const { cacheForOffline, offlineReady } = await import("./sw-register.js");
    if (!offlineReady()) {
      restore("Keep");
      toast("Offline keeping is not available in this browser", "bad");
      return;
    }
    btn.textContent = "Keeping…";
    cacheForOffline(url);

    // Ask the cache, not the worker: the only proof that counts is a stored
    // copy. Six seconds is generous for a few-hundred-KB PDF and short enough
    // that a blocked download is reported rather than left spinning.
    const stored = await waitForCache(url, 6000);
    if (stored) {
      btn.textContent = "Kept";
      btn.dataset.kept = "1";
      btn.disabled = true;
      btn.title = "Saved on this device — opens without a connection";
      toast("Kept on this device — it will open without a connection");
    } else {
      restore("Keep");
      toast("That file could not be kept — it may be too large for this device", "bad");
    }
  } catch {
    restore("Keep");
    toast("That file could not be kept", "bad");
  }
});

/** Poll the Cache API until `url` is stored, or the deadline passes. */
async function waitForCache(url, timeout) {
  if (!("caches" in window)) return false;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await caches.match(url).catch(() => null);
    if (hit) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
