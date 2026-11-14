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
import { loadContents, loadKhazana } from "./data.js";

mountChrome("batches");

const batchId = qs("batch");
const subjectSlug = qs("subject");
/**
 * A chapter reached from a Khazana archive.
 *
 * Two ids arrive, because the archive addresses its two levels differently:
 * `chapter` is the chapter **slug** (the topics call needs it) and `cid` is the
 * chapter **id** (the lecture call needs it). In a plain batch they are the same
 * string, so nothing outside `archiveMode` reads `cid`.
 */
const archiveMode = qs("archive") === "1";
const chapterId = qs("chapter");
const chapterRefId = qs("cid") || chapterId;
const chapterName = qs("name");

const TAB_LABELS = {
  videos: "lectures",
  notes: "notes",
  DppNotes: "DPPs",
  DppVideos: "DPP solutions",
};
const subjectHref =
  `/subject.html?batch=${encodeURIComponent(batchId)}` +
  `&subject=${encodeURIComponent(subjectSlug)}` +
  (qs("archive") === "1" ? "&archive=1" : "");

const body = document.getElementById("body");
const chapterNameEl = document.getElementById("chapterName");
const chapterMeta = document.getElementById("chapterMeta");
const crumbs = document.getElementById("crumbs");
const tabs = document.getElementById("tabs");

let type = "videos";

/**
 * In an archive the four tabs collapse to one.
 *
 * A program chapter holds *topics*, and each topic holds its own lectures, notes
 * and DPPs — so "Notes" for the whole chapter is not a list the source can give.
 * Hiding the tabs is honest; leaving them there would make three of four look
 * broken.
 */
if (archiveMode) {
  tabs.querySelectorAll(".tab").forEach((t) => {
    if (t.dataset.type === "videos") return;
    t.hidden = true;
  });
}
/**
 * `type -> { items, partial }`.
 *
 * `partial` is stored *with* the list it describes rather than beside it. It
 * used to be a single module-level flag, so it belonged to whichever tab was
 * rendered last: switching away and back to a cached tab showed the flag left by
 * the previous one. A short notes tab silently stopped warning when it was
 * reopened, and a complete tab could wear another tab's "did not resolve".
 */
const cache = new Map();
/** True when the section being rendered came back shorter than the source said. */
let partial = false;

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
  // Deep links to a tab: `#notes` and `#dp` land on the tab that actually works,
  // which is where the lecture page sends someone whose video cannot play.
  const hash = String(location.hash || "").replace("#", "");
  const wanted = { notes: "notes", dpp: "DppNotes", dp: "DppNotes", videos: "videos" }[hash];
  load(wanted || "videos");
  if (wanted) {
    const tab = [...tabs.querySelectorAll(".tab")].find((t) => t.dataset.type === wanted);
    if (tab) tab.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }
}

function buildCrumbs() {
  crumbs.innerHTML = `<a href="/">Home</a> <span>/</span>
    <a href="/batch.html?id=${encodeURIComponent(batchId)}">Batch</a> <span>/</span>
    <a href="/subject.html?batch=${encodeURIComponent(batchId)}&subject=${encodeURIComponent(subjectSlug)}">Subject</a> <span>/</span>
    <span class="truncate">${esc(chapterName || "Chapter")}</span>`;
}

function watchUrl(item) {
  const base =
    `/watch.html?batch=${encodeURIComponent(batchId)}` +
    `&subject=${encodeURIComponent(subjectSlug)}` +
    `&id=${encodeURIComponent(item.id)}` +
    `&title=${encodeURIComponent(item.title)}`;
  // An archive lecture has no schedule entry, so the player needs to know which
  // topic to read it out of: the contents call is addressed by program + subject
  // slug + chapter slug + topic slug, and all four travel here.
  if (!archiveMode) return base;
  return (
    base +
    `&program=${encodeURIComponent(batchId)}` +
    `&chapter=${encodeURIComponent(chapterId)}` +
    `&topic=${encodeURIComponent(item.topicSlug || qs("topic") || "")}`
  );
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
  // DRM outranks "Video ready": PW flags these recordings Widevine-protected
  // and no signer will mint a relayable link for them, so a green badge here
  // would promise a player that can only ever refuse. Say it on the row, where
  // the decision to click is made — the notes and DPPs on the lecture page
  // still open, so the row itself stays a link.
  if (item.drm) {
    return `<span class="badge-soon">DRM · PW app only</span>`;
  }
  if (hasStream || /^(ready|completed|published)$/.test(status)) {
    return `<span class="badge-live">Video ready</span>`;
  }
  return `<span class="badge-soon">Recording pending</span>`;
}

/**
 * Warm a lecture's stream plan before the click.
 *
 * Resolving a plan is the slow half of opening a lecture (a signer probe,
 * ~1–3 s cold). A pointer resting on a row is intent, and the resolution is
 * idempotent and cached server-side — so ask for it then, fire-and-forget,
 * and the click that follows lands on a warm cache. One warm per lecture per
 * page: hovering down a list must not turn into a probe storm.
 */
const warmed = new Set();
function warmLecture(id) {
  if (!id || warmed.has(id) || archiveMode) return;
  warmed.add(id);
  const url =
    `/api/stream?batch=${encodeURIComponent(batchId)}` +
    `&subject=${encodeURIComponent(subjectSlug)}&id=${encodeURIComponent(id)}`;
  fetch(url).catch(() => {});
}

function videoRow(item, index) {
  return `
    <a class="list-row fade-up" data-lecture="${esc(item.id || "")}" href="${watchUrl(item)}">
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

/**
 * Where "Practice" sends a student.
 *
 * A DPP paper is a real test, not a PDF to read: `/dpp` reads the paper's
 * questions and marks the attempt against its own key. The chapter is passed
 * along so the analysis can send them back to the exact tab they came from.
 */
function practiceUrl(doc) {
  const params = new URLSearchParams({
    // `paper` is the paper's address — the link has always carried it there, and the
    // practice page reads it as such. `dpp` is repeated for the route that names a
    // paper the same way (`/api/pdf?dpp=`), so a link can be pasted into either.
    paper: doc.url || "",
    dpp: doc.url || "",
    name: doc.topic || doc.name || "DPP",
    batch: batchId,
    subject: subjectSlug,
    chapter: chapterId,
    chapterName: chapterName || "",
  });
  return `/dpp.html?${params.toString()}`;
}

function docRow(doc) {
  const viewer = `/viewer.html?url=${encodeURIComponent(doc.url)}&name=${encodeURIComponent(doc.name)}`;
  // `data-keep` names the relay URL the worker should store — the same bytes the
  // reader shows, so the copy that is kept is the copy that will open.
  const keep = `/api/media?url=${encodeURIComponent(doc.url)}`;
  // Only the questions of a DPP tab are a test; a class note is not.
  const practice =
    type === "DppNotes"
      ? `<a class="btn btn-primary btn-sm" href="${esc(practiceUrl(doc))}"
           title="Attempt this paper and get it marked">Practice</a>`
      : "";
  return `
    <div class="doc-row fade-up">
      <span class="pdf">PDF</span>
      <span class="grow">
        <span class="name">${esc(doc.name)}</span>
        <span class="meta">${esc(doc.topic || doc.note || "Document")}</span>
      </span>
      ${practice}
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

/**
 * A Khazana chapter is a list of *topics*, and each topic is where the lectures,
 * notes and DPPs actually live.
 *
 * `renderArchiveTopics` is separate from `render` on purpose: the batch renderer
 * draws *items* (lectures, files) under a chapter, while an archive chapter holds
 * one more level. Forcing them into one function would have meant a branch at the
 * top of every section of it.
 */
async function renderArchiveTopics() {
  body.innerHTML = `<div class="list">${Array.from({ length: 5 })
    .map(() => `<div class="skeleton sk-row"></div>`)
    .join("")}</div>`;

  let topics = [];
  try {
    const out = await loadKhazana(batchId, "topics", {
      subject: subjectSlug,
      chapter: chapterId,
    });
    topics = out.topics || out.items || [];
  } catch (err) {
    chapterMeta.textContent = "The archive did not answer. This is the source, not this site.";
    body.innerHTML = emptyState(
      "Could not load this chapter",
      err.message,
      `<button class="btn btn-primary btn-sm" type="button" data-retry="videos">Try again</button>`
    );
    return;
  }

  if (!topics.length) {
    chapterMeta.textContent = "";
    body.innerHTML = emptyState(
      "No topics in this chapter",
      "The archive lists this chapter but publishes no topics under it yet.",
      `<a class="btn btn-ghost btn-sm" href="${subjectHref}">All chapters in this subject</a>`
    );
    return;
  }

  chapterMeta.innerHTML = `${topics.length} topic${topics.length === 1 ? "" : "s"} · every one holds its own lectures, notes and DPPs`;
  body.innerHTML = `<div class="list">${topics.map(topicRow).join("")}</div>`;
}

/**
 * The lectures and notes inside one archive topic.
 *
 * The call returns both kinds in one list — `Lecture` rows carry a CloudFront
 * video URL, `Concept` rows carry a PDF — so one read fills the whole page. Each
 * lecture row links to the player with the four slugs it needs; each note row
 * links straight to the PDF through the same viewer every other note uses.
 */
async function renderArchiveContents() {
  body.innerHTML = `<div class="list">${Array.from({ length: 5 })
    .map(() => `<div class="skeleton sk-row"></div>`)
    .join("")}</div>`;

  let items = [];
  try {
    const out = await loadKhazana(batchId, "contents", {
      subject: subjectSlug,
      chapter: chapterId,
      topic: qs("topic"),
    });
    items = out.items || [];
  } catch (err) {
    chapterMeta.textContent = "The archive did not answer. This is the source, not this site.";
    body.innerHTML = emptyState(
      "Could not load this topic",
      err.message,
      `<button class="btn btn-primary btn-sm" type="button" data-retry="videos">Try again</button>`
    );
    return;
  }

  if (!items.length) {
    chapterMeta.textContent = "";
    body.innerHTML = emptyState(
      "Nothing published in this topic",
      "The archive lists this topic but has released no lecture or note in it yet.",
      `<a class="btn btn-ghost btn-sm" href="${subjectHref}">All chapters in this subject</a>`
    );
    return;
  }

  const lectures = items.filter((i) => i.kind === "lecture");
  const notes = items.filter((i) => i.kind === "note" && i.fileUrl);

  chapterMeta.innerHTML =
    `${lectures.length} lecture${lectures.length === 1 ? "" : "s"}` +
    (notes.length ? ` · ${notes.length} notes` : "") +
    " · older recordings from the archive";

  body.innerHTML = `<div class="list">${lectures
    .map((l, i) => archiveLectureRow(l, i))
    .join("")}</div>${
    notes.length
      ? `<h2 class="h3 mt-6">Notes and DPPs</h2>
         <div class="list">${notes.map((n, i) => archiveNoteRow(n, i)).join("")}</div>`
      : ""
  }`;
}

/**
 * One archive lecture.
 *
 * `isPurchased: false` is shown, not hidden: the row is real, the video exists,
 * and the reader deserves to know the source may refuse it rather than discover
 * that by clicking. Nothing is filtered out on that flag.
 */
function archiveLectureRow(item, index) {
  const href =
    `/watch.html?batch=${encodeURIComponent(batchId)}` +
    `&subject=${encodeURIComponent(subjectSlug)}` +
    `&id=${encodeURIComponent(item.id)}` +
    `&title=${encodeURIComponent(item.title)}` +
    `&program=${encodeURIComponent(batchId)}` +
    `&chapter=${encodeURIComponent(chapterId)}` +
    `&topic=${encodeURIComponent(qs("topic"))}`;
  const badge = item.videoUrl
    ? `<span class="badge-live">Video ready</span>`
    : `<span class="badge-soon">No video</span>`;
  return `
    <a class="list-row fade-up" href="${href}">
      <span class="index">${String(index + 1).padStart(2, "0")}</span>
      <span class="grow">
        <span class="title">${esc(item.title)}</span>
        <span class="meta">
          ${item.duration ? `<span>${esc(item.duration)}</span>` : ""}
          <span>Archive</span>
          ${badge}
          ${item.isPurchased === false ? `<span class="badge-soon">Source says locked</span>` : ""}
        </span>
      </span>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-2)" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" fill="var(--brand-2)" stroke="none"/></svg>
    </a>`;
}

/** One archive note or DPP → the PDF, through the site's own viewer. */
function archiveNoteRow(item, index) {
  // `viewer.js` reads `url` + `name`; the archive's PDFs are absolute
  // `static.pw.live` links, which it opens without a proxy hop.
  const href =
    `/viewer.html?name=${encodeURIComponent(item.fileName || item.title)}` +
    `&url=${encodeURIComponent(item.fileUrl)}`;
  return `
    <a class="list-row fade-up" href="${href}">
      <span class="index">${String(index + 1).padStart(2, "0")}</span>
      <span class="grow">
        <span class="title">${esc(item.title)}</span>
        <span class="meta"><span>PDF</span><span>Archive</span></span>
      </span>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-2)" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
    </a>`;
}

/** One archive topic → a row that opens its lecture list. */
function topicRow(topic, index) {
  const href =
    `/chapter.html?batch=${encodeURIComponent(batchId)}` +
    `&subject=${encodeURIComponent(subjectSlug)}` +
    `&chapter=${encodeURIComponent(chapterId)}` +
    `&cid=${encodeURIComponent(chapterRefId)}` +
    `&topic=${encodeURIComponent(topic.slug || "")}` +
    `&name=${encodeURIComponent(topic.name)}` +
    `&archive=1`;
  return `
    <a class="list-row chapter-row fade-up" href="${href}">
      <span class="index">${String(index + 1).padStart(2, "0")}</span>
      <span class="grow">
        <span class="title">${esc(topic.displayName || topic.name)}</span>
        <span class="counts">
          ${topic.lectures ? `<span class="count-chip v">${topic.lectures} lectures</span>` : ""}
          ${topic.notes ? `<span class="count-chip n">${topic.notes} notes</span>` : ""}
          ${!topic.lectures && !topic.notes ? `<span class="count-chip">Coming soon</span>` : ""}
        </span>
      </span>
      <svg class="chev" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
    </a>`;
}

async function load(nextType, { refresh = false } = {}) {
  type = nextType;
  // The tab strip is a real tab widget, so it has to say so: `aria-selected` is
  // the only thing a screen reader reads as "this section is open", and the
  // roving `tabindex` is what makes Tab move *past* the strip into the list
  // instead of stopping on all four sections. The panel follows the selection.
  tabs.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.type === type;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
    // -1 on the unselected tabs, not 0: one stop for the whole strip.
    t.tabIndex = on ? 0 : -1;
    // Taken from the element rather than rebuilt from `type`: the ids are
    // `tab-<type>` today, so both spellings work, but reading the tab's own id
    // means the panel cannot end up pointing at an id nobody owns if either
    // side is renamed.
    if (on) body.setAttribute("aria-labelledby", t.id);
  });

  // Retrying an incomplete docs tab must drop the cached (short) answer, or the
  // button would replay the same list and appear to do nothing.
  if (refresh) cache.delete(type);
  if (cache.has(type)) {
    const hit = cache.get(type);
    partial = Boolean(hit.partial);
    return render(hit.items);
  }
  partial = false;

  body.innerHTML = `<div class="list">${Array.from({ length: 5 })
    .map(() => `<div class="skeleton sk-row"></div>`)
    .join("")}</div>`;

  try {
    if (archiveMode) {
      // `topic` in the query means this page is *inside* one topic, so the list is
      // its lectures and notes — not the chapter's topic list.
      return qs("topic") ? renderArchiveContents() : renderArchiveTopics();
    }
    const out = await loadContents(batchId, subjectSlug, chapterId, type);
    // A notes/DPP tab resolves one storage key per attachment. When PW's
    // rate-limited lookup gives up partway, the tab renders a *shorter* list
    // than the chapter really has, with nothing to say so — which reads as
    // "this chapter has 3 notes" when it has 24. Report the gap.
    const d = (out && out.diagnostics) || null;
    // `failed` = an attachment PW would not resolve; `skipped` = we ran out of
    // budget before asking. Either way the list is short of the truth.
    partial = Boolean(d && ((d.failed || 0) > 0 || (d.skipped || 0) > 0));
    cache.set(type, { items: out.items || [], partial });
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
    // Transient (their server, not ours): keep the list reachable.
    const retry = `<button class="btn btn-primary btn-sm" type="button" data-retry="${type}">Try again</button>`;
    // The header must stop claiming to be loading something it has given up on.
    chapterMeta.textContent = "The lecture list did not load — this is Physics Wallah's server, not this site.";
    body.innerHTML = emptyState("Could not load this section", err.message, retry);
    toast(err.message, "error");
  }
}

function render(items) {
  if (!items.length) {
    const label = { videos: "lectures", notes: "notes", DppNotes: "DPPs", DppVideos: "DPP solutions" }[type];
    // An empty tab is not necessarily an empty chapter: a subject lists chapters
    // with 0 lectures / 0 notes / 0 DPPs, and clicking one used to land on a
    // bare "nothing published here" with no way forward. Offer the tabs that do
    // have content, and a route back to the subject.
    const others = Object.keys(TAB_LABELS)
      .filter((t) => cache.has(t) && (cache.get(t).items || []).length)
      .map((t) => `<button class="btn btn-ghost btn-sm" type="button" data-goto="${t}">${
        cache.get(t).items.length
      } ${TAB_LABELS[t]}</button>`);
    const back = `<a class="btn btn-ghost btn-sm" href="${subjectHref}">All chapters in this subject</a>`;
    body.innerHTML = emptyState(
      `No ${label} here`,
      "Physics Wallah publishes nothing in this section of the chapter. The other tabs, or another chapter, may have what you need.",
      [...others, back].join(" ")
    );
    chapterMeta.textContent = "Nothing published in this section.";
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
    chapterMeta.innerHTML = `${items.length} ${label}`;

    // A chapter whose lectures all refuse to play still has value: the list is a
    // syllabus and the notes are readable. Say which part works, once, above the
    // list — instead of leaving 148 rows that each fail on click with no warning.
    // Say what the badges mean, once, above the list. The old line here claimed
    // playback needed an account, which stopped being true and told every student
    // not to bother clicking. The badges already say which rows have a recording;
    // this only has to explain that they are the honest part.
    const notice =
      type === "videos"
        ? `<p class="tiny dim chapter-hint">Rows marked <strong>Video ready</strong> play here. <strong>Recording pending</strong> means Physics Wallah has not published that class's recording yet. The <strong>Notes</strong> and <strong>DPPs</strong> tabs hold the PDFs for both.</p>`
        : "";
    body.innerHTML = `${notice}<div class="list">${items.map(videoRow).join("")}</div>`;
  } else {
    const total = items.reduce((n, i) => n + (i.docs ? i.docs.length : 0), 0);
    chapterMeta.textContent = `${total} PDF${total === 1 ? "" : "s"} available`;
    const gap = partial
      ? `<p class="tiny dim chapter-hint">Some files did not resolve — Physics Wallah limits how fast links can be fetched. <button class="btn btn-ghost btn-sm" type="button" data-retry="${type}">Load the rest</button></p>`
      : "";
    body.innerHTML = `${gap}<div class="list">${items.map(docItemRow).join("")}</div>`;
  }
}

/**
 * Arrow keys move between sections, as every tab strip is expected to.
 *
 * Home/End jump to the ends. The keys are handled here rather than left to the
 * browser because `button` elements do not navigate a group on their own — with
 * `tabindex="-1"` on the unselected tabs, the arrow keys are the *only* way to
 * reach them from the keyboard, so this is not an enhancement.
 */
tabs.addEventListener("keydown", (e) => {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
  const move = keys[e.key];
  if (!move) return;
  e.preventDefault();
  const all = [...tabs.querySelectorAll(".tab")];
  const at = all.indexOf(e.target.closest(".tab"));
  if (at === -1) return;
  const next =
    move === "first" ? 0 : move === "last" ? all.length - 1 : (at + move + all.length) % all.length;
  const target = all[next];
  target.focus();
  load(target.dataset.type);
});

tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  load(btn.dataset.type);
  // Shareable tab URLs: `#notes` reopens the tab that was open when it was copied.
  const hashFor = { notes: "notes", DppNotes: "dpp", videos: "videos", DppVideos: "dpp-videos" };
  if (typeof history !== "undefined" && hashFor[btn.dataset.type]) {
    history.replaceState(null, "", `#${hashFor[btn.dataset.type]}`);
  }
});

/**
 * Keep a notes or DPP file on this device.
 *
 * Delegated from the list, because the rows are re-rendered on every tab change
 * and per-row listeners would be added and thrown away with them. The button
 * reports what the worker actually did — "Kept" only after the cache holds the
 * file, never on the strength of having asked.
 */
// Intent to open a lecture warms its stream plan (see `warmLecture`).
// Delegated like everything else on this list, and on both pointer flavours:
// a mouse resting on a row and a finger touching one are the same signal.
for (const eventName of ["pointerover", "touchstart"]) {
  body.addEventListener(
    eventName,
    (event) => {
      const row = event.target.closest("[data-lecture]");
      if (row) warmLecture(row.dataset.lecture);
    },
    { passive: true }
  );
}

body.addEventListener("click", async (event) => {
  // Retry a section whose upstream call failed, and jump to a tab that has
  // content when the current one is empty. Both are delegation, because the
  // list is re-rendered on every tab change.
  const retryBtn = event.target.closest("[data-retry]");
  if (retryBtn) {
    event.preventDefault();
    load(retryBtn.dataset.retry, { refresh: true });
    return;
  }
  const gotoBtn = event.target.closest("[data-goto]");
  if (gotoBtn) {
    event.preventDefault();
    load(gotoBtn.dataset.goto);
    return;
  }

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
