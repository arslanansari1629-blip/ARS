/* The DPP panel — every practice paper in a batch, in one place.
 *
 * The papers live three levels down: a batch has subjects, a subject has chapters,
 * a chapter has a `DppNotes` tab with the PDFs. Reaching one therefore meant
 * batch → subject → chapter → DPP tab → Practice, five taps, and nothing anywhere
 * said how many papers the batch actually has.
 *
 * This panel walks that tree once and lists the papers flat, with a Practice button
 * on each — the same link a chapter builds, so the practice page opens the paper
 * with the chapter it came from still known (which is what its "back" button needs).
 *
 * The walk is progressive and bounded on purpose. A batch can hold a dozen subjects
 * of a dozen chapters, and a phone must not wait for all of it: papers appear as each
 * chapter answers, the count grows in the header, and a subject that will not answer
 * is reported without stopping the rest.
 */

import { esc } from "./app.js";

/** How many chapters may be walked at once. Upstream rate-limits bursts. */
const CONCURRENCY = 3;

/** Stop after this many chapters unless the reader asks for more. */
const FIRST_PASS = 36;

/** A practice attempt's last score is kept here by `/dpp` when it submits. */
const resultKey = (url) => `arsvibe.dpp.result.${url}`;

function lastResult(url) {
  try {
    const raw = localStorage.getItem(resultKey(url));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const percent = Number(saved?.percent);
    if (!Number.isFinite(percent)) return null;
    return {
      percent,
      correct: Number(saved.correct) || 0,
      scored: Number(saved.scored) || 0,
      at: Number(saved.at) || 0,
    };
  } catch {
    return null;
  }
}

/** The practice link for one paper, carrying everything the page needs to go back. */
export function practiceHref(paper) {
  const params = new URLSearchParams({
    paper: paper.url,
    dpp: paper.url,
    name: paper.title || "DPP",
    batch: paper.batch || "",
    subject: paper.subjectSlug || "",
    chapter: paper.chapterId || "",
    chapterName: paper.chapter || "",
  });
  return `/dpp.html?${params.toString()}`;
}

const pdfHref = (paper) => `/api/media?url=${encodeURIComponent(paper.url)}`;

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `The catalogue answered ${res.status}.`);
  }
  return body;
}

/**
 * Walk a batch's subjects and chapters, collecting DPP papers.
 *
 * `onPaper` is called as each paper is found, so the list can fill in while the walk
 * is still running — a reader should not stare at a skeleton while eleven chapters
 * are fetched. `shouldStop` lets a newer walk (the reader typed a search, or pressed
 * "load more") retire this one instead of racing it.
 */
export async function walkBatch({ batch, subjects, limit, onPaper, onProgress, shouldStop }) {
  const queue = [];
  for (const subject of subjects) {
    queue.push({
      subjectSlug: subject.slug || subject.id,
      subjectName: subject.name || "",
    });
  }

  let scanned = 0;
  let found = 0;
  const errors = [];
  let stopped = false;

  // Subjects are walked one at a time and their chapters in parallel, so a single
  // subject contributes all its papers together — which is how a reader looks for
  // them ("the units chapter's papers").
  for (const subject of queue) {
    if (stopped) break;
    if (scanned >= limit) break;

    let chapters = [];
    try {
      const out = await getJson(
        `/api/contents?batch=${encodeURIComponent(batch)}&subject=${encodeURIComponent(subject.subjectSlug)}`
      );
      chapters = out.chapters || out.items || [];
    } catch (err) {
      errors.push(`${subject.subjectName || "A subject"}: ${err.message}`);
      onProgress?.({ scanned, found, errors, done: false });
      continue;
    }

    // The catalogue reports each chapter's own DPP count as `exercises` — on a real
    // batch, "Units and Measurement" says 11 and the "Only PDF" chapters say 0. So the
    // chapters that actually hold papers are walked first, which is the difference
    // between the list filling in three seconds and filling in twenty-five: a subject
    // can carry 35 chapters and only a handful of them have DPPs.
    const useful = chapters.filter(
      (c) =>
        (Number(c.exercises) || 0) > 0 ||
        (Number(c.dpps) || 0) > 0 ||
        (Number(c.videos) || 0) > 0 ||
        (Number(c.notes) || 0) > 0
    );
    const rank = (c) => -(Number(c.exercises) || Number(c.dpps) || 0);
    const pool = (useful.length ? useful : chapters)
      .slice()
      .sort((a, b) => rank(a) - rank(b) || (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0))
      .filter(() => scanned < limit);

    for (let i = 0; i < pool.length; i += CONCURRENCY) {
      if (stopped || scanned >= limit) break;
      const slice = pool.slice(i, i + CONCURRENCY);
      const answers = await Promise.all(
        slice.map(async (chapter) => {
          try {
            const out = await getJson(
              `/api/contents?batch=${encodeURIComponent(batch)}` +
                `&subject=${encodeURIComponent(subject.subjectSlug)}` +
                `&topic=${encodeURIComponent(chapter.id)}&type=DppNotes`
            );
            return { chapter, out };
          } catch (err) {
            return { chapter, error: err.message };
          }
        })
      );

      for (const { chapter, out, error } of answers) {
        scanned += 1;
        if (error) {
          errors.push(`${chapter.name}: ${error}`);
          continue;
        }
        for (const item of out.items || []) {
          for (const doc of item.docs || []) {
            if (!doc.url) continue;
            found += 1;
            onPaper?.({
              url: doc.url,
              title: (doc.topic || item.title || doc.name || "DPP").trim(),
              file: doc.name || "",
              date: item.date || "",
              chapter: chapter.name || "",
              chapterId: chapter.id || "",
              subjectName: subject.subjectName,
              subjectSlug: subject.subjectSlug,
              batch,
            });
          }
        }
      }
      onProgress?.({ scanned, found, errors, done: false });
      if (shouldStop?.()) {
        stopped = true;
        break;
      }
    }
  }

  onProgress?.({ scanned, found, errors, done: true });
  return { scanned, found, errors, stopped };
}

/** "DPP 11" out of "Units and Measurement : DPP 11 (of lec 13) || …". */
function shortName(title) {
  const text = String(title || "").trim();
  const dpp = text.match(/\bDPP\s*[-:]?\s*(\d+)/i);
  if (dpp) return `DPP ${dpp[1]}`;
  return text.split(/\s*[|·]\s*/)[0].slice(0, 40) || "DPP";
}

function fmt(paper) {
  const stamp = Date.parse(paper.date);
  if (!Number.isFinite(stamp)) return "";
  return new Date(stamp).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Build the panel inside `host`.
 *
 * `subjects` is the batch's own subject list, so the panel needs no extra call to
 * know what to walk. Returns a small handle so the page can re-mount it.
 */
export function mountDppPanel(host, { batch, subjects = [], limit = FIRST_PASS } = {}) {
  if (!host) return null;

  const papers = [];
  const seen = new Set();
  let generation = 0;
  let query = "";
  let subjectFilter = "";
  let walkLimit = limit;
  let scanning = false;
  let progress = { scanned: 0, found: 0, errors: [], done: false };

  const listOf = () => {
    const needle = query.trim().toLowerCase();
    return papers.filter((paper) => {
      if (subjectFilter && paper.subjectSlug !== subjectFilter) return false;
      if (!needle) return true;
      return `${paper.title} ${paper.chapter} ${paper.subjectName} ${paper.file}`
        .toLowerCase()
        .includes(needle);
    });
  };

  host.innerHTML = `
    <div class="dpp-panel-head">
      <div>
        <span class="eyebrow">Practice</span>
        <h2>DPP tests in this batch</h2>
        <p class="muted tiny" id="dppPanelNote" role="status">Looking for papers…</p>
      </div>
      <div class="dpp-panel-tools">
        <label class="dpp-panel-search">
          <span class="sr-only">Search papers</span>
          <input type="search" id="dppPanelSearch" placeholder="Search papers, chapters…" autocomplete="off" />
        </label>
        <select id="dppPanelSubject" class="dpp-panel-select" aria-label="Filter by subject">
          <option value="">All subjects</option>
        </select>
      </div>
    </div>

    <div class="dpp-panel-strip" id="dppPanelStrip"></div>
    <div class="dpp-panel-list" id="dppPanelList">
      <div class="list">${Array.from({ length: 5 })
        .map(() => `<div class="skeleton sk-row"></div>`)
        .join("")}</div>
    </div>
    <div class="row mt-3" id="dppPanelMore"></div>
  `;

  const note = host.querySelector("#dppPanelNote");
  const listEl = host.querySelector("#dppPanelList");
  const stripEl = host.querySelector("#dppPanelStrip");
  const moreEl = host.querySelector("#dppPanelMore");
  const searchEl = host.querySelector("#dppPanelSearch");
  const subjectEl = host.querySelector("#dppPanelSubject");

  for (const subject of subjects) {
    const slug = subject.slug || subject.id;
    if (!slug) continue;
    const option = document.createElement("option");
    option.value = slug;
    option.textContent = subject.name || slug;
    subjectEl.appendChild(option);
  }

  function renderStrip() {
    if (!papers.length) {
      stripEl.innerHTML = "";
      return;
    }
    const attempted = papers.filter((paper) => lastResult(paper.url)).length;
    const subjectsWithPapers = new Set(papers.map((paper) => paper.subjectSlug)).size;
    stripEl.innerHTML = `
      <span class="pill pill-brand">${papers.length} paper${papers.length === 1 ? "" : "s"}</span>
      <span class="pill">${subjectsWithPapers} subject${subjectsWithPapers === 1 ? "" : "s"}</span>
      <span class="pill">${attempted} attempted</span>
      ${progress.done ? "" : `<span class="pill pill-live">still looking…</span>`}
    `;
  }

  function renderList() {
    const rows = listOf();
    renderStrip();

    if (!papers.length) {
      if (!progress.done) {
        listEl.innerHTML = `<div class="list">${Array.from({ length: 4 })
          .map(() => `<div class="skeleton sk-row"></div>`)
          .join("")}</div>`;
        return;
      }
      listEl.innerHTML = `
        <div class="empty-state">
          <p><strong>No DPP papers found in this batch.</strong></p>
          <p class="tiny muted">${
            progress.errors.length
              ? `${progress.errors.length} chapter${progress.errors.length === 1 ? "" : "s"} could not be read: ${esc(
                  progress.errors[0]
                )}`
              : "The catalogue lists no DPP attachments here yet. Lecture notes are still on the chapter pages."
          }</p>
        </div>`;
      return;
    }

    if (!rows.length) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p><strong>No paper matches “${esc(query || subjectEl.selectedOptions[0]?.textContent || "")}”.</strong></p>
          <p class="tiny muted">Clear the search to see all ${papers.length} papers.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = `<div class="list dpp-panel-rows">${rows
      .map((paper, index) => {
        const last = lastResult(paper.url);
        const tone = last ? (last.percent >= 60 ? "is-ok" : "is-bad") : "";
        return `
        <article class="dpp-panel-row fade-up" data-url="${esc(paper.url)}" style="--i:${index}">
          <div class="dpp-panel-main">
            <div class="row gap-1 wrap">
              <span class="pill pill-brand">${esc(shortName(paper.title))}</span>
              <span class="pill">${esc(paper.subjectName || "Subject")}</span>
              ${last ? `<span class="pill ${tone}">${last.percent}% last time</span>` : ""}
            </div>
            <h3 class="mt-2">${esc(paper.chapter || paper.title || "DPP")}</h3>
            <p class="tiny muted">
              ${esc(paper.file || paper.title || "")}${paper.date ? ` · ${esc(fmt(paper))}` : ""}
            </p>
          </div>
          <div class="dpp-panel-actions">
            <a class="btn btn-primary btn-sm" href="${esc(practiceHref(paper))}"
               data-practice="${esc(paper.url)}">${last ? "Retry" : "Practice"}</a>
            <a class="btn btn-ghost btn-sm" href="${esc(pdfHref(paper))}" target="_blank" rel="noopener">PDF</a>
          </div>
        </article>`;
      })
      .join("")}</div>`;
  }

  function renderNote() {
    if (scanning) {
      note.textContent = papers.length
        ? `${papers.length} paper${papers.length === 1 ? "" : "s"} so far, reading ${progress.scanned} chapter${
            progress.scanned === 1 ? "" : "s"
          }…`
        : "Looking for papers…";
      return;
    }
    if (!papers.length) {
      note.textContent = progress.errors.length
        ? "The catalogue did not list any papers this time."
        : "This batch carries no DPP papers.";
      return;
    }
    note.textContent = `${papers.length} paper${papers.length === 1 ? "" : "s"} from ${progress.scanned} chapter${
      progress.scanned === 1 ? "" : "s"
    }${progress.errors.length ? ` · ${progress.errors.length} could not be read` : ""}. Press Practice on any of them.`;
  }

  function renderMore() {
    if (scanning || progress.done === false) {
      moreEl.innerHTML = "";
      return;
    }
    moreEl.innerHTML = `<button class="btn btn-ghost btn-sm" id="dppPanelLoadMore">Look at more chapters</button>`;
    moreEl.querySelector("#dppPanelLoadMore")?.addEventListener("click", () => {
      walkLimit += FIRST_PASS;
      start();
    });
  }

  function refresh() {
    renderNote();
    renderList();
    renderMore();
  }

  async function start() {
    const mine = ++generation;
    scanning = true;
    refresh();

    await walkBatch({
      batch,
      subjects,
      limit: walkLimit,
      shouldStop: () => generation !== mine,
      onPaper: (paper) => {
        if (generation !== mine) return;
        if (seen.has(paper.url)) return;
        seen.add(paper.url);
        papers.push(paper);
        // Painted per paper, not per chapter: the first papers should appear in the
        // first second, not after the eleventh chapter answers.
        renderNote();
        renderList();
      },
      onProgress: (next) => {
        if (generation !== mine) return;
        progress = { ...progress, ...next };
        renderNote();
        renderStrip();
      },
    });

    if (generation !== mine) return;
    scanning = false;
    progress = { ...progress, done: true };
    refresh();
  }

  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    renderList();
  });
  subjectEl.addEventListener("change", () => {
    subjectFilter = subjectEl.value;
    renderList();
  });

  // A practice page opened from this panel comes back here; the score it saved is
  // read on the next render, so "Retry · 62% last time" is honest after a round trip.
  window.addEventListener("focus", () => renderList());

  if (!subjects.length) {
    host.querySelector("#dppPanelList").innerHTML = `
      <div class="empty-state">
        <p><strong>This batch lists no subjects.</strong></p>
        <p class="tiny muted">There is nothing to walk, so there are no papers to practise.</p>
      </div>`;
    note.textContent = "";
    scanning = false;
    return { start: () => {}, papers: () => papers };
  }

  start();
  return { start, papers: () => papers };
}
