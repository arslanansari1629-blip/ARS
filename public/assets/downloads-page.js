/* =========================================================================
   Downloads page.

   Two questions this page answers, in this order:

     1. "Which lecture?" — browsed from the live catalogue, never a pasted URL.
        Picking a batch fills in its subjects, picking a subject fills in its
        chapters, picking a chapter fills in its lectures. Every level caches
        itself in localStorage, so coming back to a batch you were downloading is
        instant and works with no network.
     2. "Will it play offline?" — a download is only offered when the server can
        actually assemble a stream, and the saved card says which format it took:
        a portable `.ts` (decrypted, plays in any player) or a self-contained
        `.m3u8` (key inside, plays in this site and in VLC).

   Downloads continue while the person keeps the page open, and a lecture that
   was interrupted is resumed from where it stopped rather than restarted.
   ========================================================================= */

import { api, mountChrome, esc, toast, emptyState, getPrefs, setPref, fmtRelative } from "./app.js";
import { playSaved } from "./offline-player.js";
import {
  canStoreOffline,
  downloadLecture,
  savedLectures,
  savedLecture,
  removeLecture,
  clearLectures,
  storageEstimate,
  requestPersistence,
  offlineFile,
  looksLikeTransportStream,
  base64ToBytes,
  fmtBytes,
  fmtDuration,
} from "./downloader.js";

mountChrome("downloads");

const $ = (id) => document.getElementById(id);

const batchInput = $("batchSearch");
const batchList = $("batchResults");
const stepSubject = $("stepSubject");
const stepChapter = $("stepChapter");
const stepLecture = $("stepLecture");
const subjectList = $("subjectList");
const chapterList = $("chapterList");
const lectureList = $("lectureList");
const pickMeta = $("pickMeta");
const savedList = $("savedList");
const savedEmpty = $("savedEmpty");
const spaceBar = $("spaceBar");
const spaceText = $("spaceText");
const queueBar = $("queueBar");
const queueText = $("queueText");
const clearBtn = $("clearSaved");
const persistNote = $("persistNote");
const onlyOffline = $("onlyOffline");

/** Where the current choice lives between visits. */
const PICK_KEY = "downloadPick";
/** Bumped whenever the page's contract with storage changes. */
const running = new Map();
let saved = [];
let pick = { batch: null, subject: null, chapter: null };

/* --------------------------------- storage -------------------------------- */

function readPick() {
  return getPrefs()[PICK_KEY] || {};
}

function writePick(next) {
  pick = { ...pick, ...next };
  setPref(PICK_KEY, pick);
}

/* --------------------------------- helpers -------------------------------- */

function thumb(url, letters) {
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()" />`
    : `<span class="placeholder">${esc(letters)}</span>`;
}

function spinner(label) {
  return `<div class="dl-loading"><span class="dl-spin"></span> ${esc(label)}</div>`;
}

function noBatch() {
  return emptyState(
    "Pick a batch first",
    "Search above, or open a batch and use “Save for offline” on any lecture.",
    `<a class="btn btn-ghost btn-sm" href="/batches.html">Browse all batches</a>`
  );
}

/* --------------------------------- search --------------------------------- */

let searchTimer = null;

batchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const term = batchInput.value.trim();
  if (term.length < 2) {
    batchList.innerHTML = "";
    return;
  }
  searchTimer = setTimeout(() => runSearch(term), 320);
});

async function runSearch(term) {
  batchList.innerHTML = spinner("Searching the catalogue…");
  try {
    const data = await api(`/api/batches?search=${encodeURIComponent(term)}&pageSize=8`);
    const rows = data.batches || [];
    batchList.innerHTML = rows.length
      ? rows
          .map(
            (b) => `
        <button class="dl-row" data-batch="${esc(b.id)}" data-name="${esc(b.name)}">
          <span class="dl-thumb">${thumb(b.image, (b.name || "PW").slice(0, 2).toUpperCase())}</span>
          <span class="grow">
            <span class="title">${esc(b.name)}</span>
            <span class="meta">${esc(b.byName || "")}${b.language ? ` · ${esc(b.language)}` : ""}</span>
          </span>
          <span class="chev">›</span>
        </button>`
          )
          .join("")
      : `<p class="tiny dim">No batch matches “${esc(term)}”.</p>`;
  } catch (err) {
    batchList.innerHTML = `<p class="tiny dim">${esc(err.message || "The catalogue did not answer.")}</p>`;
  }
}

batchList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-batch]");
  if (!btn) return;
  const batch = { id: btn.dataset.batch, name: btn.dataset.name };
  batchInput.value = batch.name;
  batchList.innerHTML = "";
  writePick({ batch, subject: null, chapter: null });
  pickMeta.textContent = batch.name;
  await loadSubjects(batch);
});

/* -------------------------------- subjects -------------------------------- */

async function loadSubjects(batch) {
  stepSubject.hidden = false;
  stepChapter.hidden = true;
  stepLecture.hidden = true;
  subjectList.innerHTML = spinner("Reading subjects…");

  try {
    const data = await api(`/api/batch?id=${encodeURIComponent(batch.id)}`);
    const subjects = data.subjects || (data.batch && data.batch.subjects) || [];
    if (!subjects.length) {
      subjectList.innerHTML = `<p class="tiny dim">This batch lists no subjects yet.</p>`;
      return;
    }
    subjectList.innerHTML = subjects
      .map(
        (s) => `
      <button class="dl-row" data-subject="${esc(s.slug)}" data-name="${esc(s.name)}">
        <span class="dl-thumb">${thumb(s.image, (s.name || "S").slice(0, 1))}</span>
        <span class="grow">
          <span class="title">${esc(s.name)}</span>
          <span class="meta">${Number(s.lectureCount) || 0} lectures · ${Number(s.tagCount) || 0} chapters</span>
        </span>
        <span class="chev">›</span>
      </button>`
      )
      .join("");
  } catch (err) {
    subjectList.innerHTML = `<p class="tiny dim">${esc(err.message || "Subjects did not load.")}</p>`;
  }
}

subjectList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-subject]");
  if (!btn) return;
  const subject = { slug: btn.dataset.subject, name: btn.dataset.name };
  writePick({ subject, chapter: null });
  await loadChapters(pick.batch, subject);
});

/* -------------------------------- chapters -------------------------------- */

async function loadChapters(batch, subject) {
  stepChapter.hidden = false;
  stepLecture.hidden = true;
  chapterList.innerHTML = spinner("Reading chapters…");

  try {
    const data = await api(
      `/api/contents?batch=${encodeURIComponent(batch.id)}&subject=${encodeURIComponent(subject.slug)}`
    );
    const chapters = data.chapters || [];
    chapterList.innerHTML = chapters.length
      ? chapters
          .map(
            (c) => `
        <button class="dl-row" data-chapter="${esc(c.id)}" data-name="${esc(c.name)}">
          <span class="dl-thumb dl-thumb-sm">${esc(String(c.displayOrder || "").slice(0, 3) || "•")}</span>
          <span class="grow">
            <span class="title">${esc(c.name)}</span>
            <span class="meta">${Number(c.videos) || 0} lectures${c.notes ? ` · ${c.notes} notes` : ""}</span>
          </span>
          <span class="chev">›</span>
        </button>`
          )
          .join("")
      : `<p class="tiny dim">This subject has no chapters listed.</p>`;
  } catch (err) {
    chapterList.innerHTML = `<p class="tiny dim">${esc(err.message || "Chapters did not load.")}</p>`;
  }
}

chapterList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-chapter]");
  if (!btn) return;
  const chapter = { id: btn.dataset.chapter, name: btn.dataset.name };
  writePick({ chapter });
  await loadLectures(pick.batch, pick.subject, chapter);
});

/* -------------------------------- lectures -------------------------------- */

async function loadLectures(batch, subject, chapter) {
  stepLecture.hidden = false;
  lectureList.innerHTML = spinner("Reading lectures…");

  try {
    const data = await api(
      `/api/contents?batch=${encodeURIComponent(batch.id)}&subject=${encodeURIComponent(
        subject.slug
      )}&topic=${encodeURIComponent(chapter.id)}&type=videos`
    );
    const items = (data.items || []).filter((i) => i.kind === "video");
    lectureList.innerHTML = items.length
      ? items
          .map(
            (l) => `
        <div class="dl-lecture" data-id="${esc(l.id)}" data-title="${esc(l.title || "Lecture")}">
          <span class="dl-thumb dl-thumb-sm">▶</span>
          <span class="grow">
            <span class="title">${esc(l.title || "Lecture")}</span>
            <span class="meta">${esc(l.duration || "")}${l.duration ? " · " : ""}${esc(l.date ? fmtRelative(new Date(l.date)) : "")}</span>
          </span>
          <button class="btn btn-primary btn-sm" data-save>Save</button>
        </div>`
          )
          .join("")
      : `<p class="tiny dim">No published lectures in this chapter yet.</p>`;
  } catch (err) {
    lectureList.innerHTML = `<p class="tiny dim">${esc(err.message || "Lectures did not load.")}</p>`;
  }
}

lectureList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-save]");
  if (!btn) return;
  const row = btn.closest("[data-id]");
  if (!row) return;
  startDownload({ id: row.dataset.id, title: row.dataset.title });
});


/* -------------------------------- the save -------------------------------- */

/**
 * Ask the server what this lecture is worth, then download it.
 *
 * The manifest request is not ceremony: it is what turns "save 240p" into an
 * honest choice. It reports the renditions the source actually published, the
 * length, and — crucially — how many slices it will take, so nobody starts a
 * two-hour download without being told.
 */
async function startDownload({ id, title, batch, subject }) {
  const owner = batch || pick.batch;
  const subjectRef = subject || pick.subject;
  if (!owner || !subjectRef) {
    toast("Pick a batch and subject first", "bad");
    return;
  }
  if (running.has(id)) {
    toast("That lecture is already downloading");
    return;
  }

  const button = lectureList.querySelector(`[data-id="${CSS.escape(id)}"] [data-save]`);
  const setLabel = (text, disabled) => {
    if (!button) return;
    button.textContent = text;
    button.disabled = Boolean(disabled);
  };

  setLabel("Resolving…", true);
  try {
    // The stream URL is what makes a folder resolvable on a cold cache; the
    // resolver reads the schedule for it, which is the same path the player uses.
    const plan = await api(
      `/api/stream?batch=${encodeURIComponent(owner.id)}&subject=${encodeURIComponent(
        subjectRef.slug
      )}&id=${encodeURIComponent(id)}`
    );
    if (!plan || !plan.playable || !plan.url) {
      toast(plan?.reason || "This lecture cannot be saved right now", "bad");
      setLabel("Save", false);
      return;
    }
    const folder = new URL(plan.url, location.origin).searchParams.get("videoKey") || "";
    if (!folder) {
      toast("This lecture is not a downloadable stream", "bad");
      setLabel("Save", false);
      return;
    }

    const quality = plan.renditions && plan.renditions.length ? plan.renditions[0] : plan.quality || "720";
    const info = await api(
      `/api/download?mode=list&folder=${encodeURIComponent(folder)}&quality=${encodeURIComponent(quality)}`
    );
    if (!info.playable) {
      toast(info.error || "The source has no media for this lecture yet", "bad");
      setLabel("Save", false);
      return;
    }

    // Prefer a decrypted file: it plays in every player, including this site's,
    // with no key handling at playback time.
    const format = info.encrypted ? "plain" : "playlist";
    const estimate = info.segments * 188 * 1024; // rough, refined as it runs
    toast(
      `Saving “${title}” — ${fmtDuration(info.duration)}${estimate ? `, about ${fmtBytes(estimate)}` : ""}`
    );

    await requestPersistence();
    running.set(id, true);
    setLabel("Saving 0%", true);
    renderQueue();

    let result = await downloadLecture({
      id,
      folder,
      quality,
      title,
      format,
      sliceSize: 48,
      onProgress: (p) => {
        const pct = p.total ? Math.round((p.segments / p.total) * 100) : 0;
        setLabel(`Saving ${pct}%`, true);
        queueText.textContent = `“${title}” — ${pct}%${p.phase === "retry" ? " · retrying" : ""}`;
        queueBar.hidden = false;
      },
    });

    queueBar.hidden = true;
    running.delete(id);
    setLabel(result.ok ? "Saved" : "Resume", !result.ok);
    await refreshSaved();

    if (result.ok) {
      const record = await savedLecture(id);
      // Prove the download before claiming it works. A record that says
      // "saved" while holding no media is worse than an honest failure, and a
      // decrypted file that is not really MPEG-TS means the key was wrong.
      const parts = (record && record.parts) || [];
      if (!parts.length) throw new Error("Nothing was saved — the stream returned no media");
      if (record.format === "plain") {
        const first = new Uint8Array(base64ToBytes(parts[0].data)).subarray(0, 376);
        if (!looksLikeTransportStream(first) && format === "plain") {
          // The bytes arrived but did not come apart, which means this lecture's
          // key is not the one the playlist advertised. The playlist shape
          // carries the key inside the file, so it plays even when that is true —
          // and re-downloading beats handing over a file that only looks saved.
          await removeLecture(id);
          toast("That copy did not decrypt — saving it in the playlist format instead");
          result = await downloadLecture({
            id,
            folder,
            quality,
            title,
            format: "playlist",
            sliceSize: 48,
            onProgress: (p) => {
              const pct = p.total ? Math.round((p.segments / p.total) * 100) : 0;
              setLabel(`Saving ${pct}%`, true);
              queueText.textContent = `“${title}” — ${pct}%${p.phase === "retry" ? " · retrying" : ""}`;
            },
          });
          await refreshSaved();
        }
      }
      // A slice that skipped a segment is still a download that plays; saying so
      // once is better than letting the person find a gap themselves.
      toast(
        result.skipped
          ? `“${title}” is saved — ${result.skipped} moment${result.skipped === 1 ? "" : "s"} could not be fetched`
          : `“${title}” is saved for offline`
      );
      setLabel("Saved", false);
    } else {
      toast("Saved part of this lecture — press Resume to continue", "bad");
    }
  } catch (err) {
    running.delete(id);
    queueBar.hidden = true;
    setLabel("Save", false);
    toast(err.message || "The download failed", "bad");
  }
}

function renderQueue() {
  if (!running.size) {
    queueBar.hidden = true;
    return;
  }
  queueBar.hidden = false;
  queueText.textContent = `${running.size} lecture${running.size === 1 ? "" : "s"} downloading…`;
}

/* -------------------------------- saved list ------------------------------- */

async function refreshSaved() {
  saved = await savedLectures();
  renderSaved();
  renderSpace();
}

function renderSaved() {
  const term = (onlyOffline.value || "").trim().toLowerCase();
  const rows = term ? saved.filter((r) => (r.title || "").toLowerCase().includes(term)) : saved;

  savedEmpty.hidden = rows.length > 0;
  savedList.innerHTML = rows
    .map((r) => {
      const pct = r.total ? Math.round(((r.parts || []).length / r.total) * 100) : 0;
      const complete = r.done;
      return `
      <div class="dl-saved" data-id="${esc(r.id)}">
        <div class="dl-saved-head">
          <span class="dl-badge ${complete ? "ok" : "part"}">${complete ? "Offline" : `${pct}%`}</span>
          <span class="grow">
            <span class="title">${esc(r.title || "Lecture")}</span>
            <span class="meta">
              ${esc(r.label || (r.quality ? r.quality + "p" : ""))} ·
              ${esc(fmtDuration(r.seconds))} ·
              ${esc(fmtBytes((r.parts || []).reduce((n, p) => n + (p.size || 0), 0)))} ·
              ${esc(r.format === "plain" ? "MPEG-TS, plays anywhere" : "self-contained .m3u8")}
            </span>
          </span>
        </div>
        <div class="dl-progress"><span style="width:${complete ? 100 : pct}%"></span></div>
        <div class="dl-actions">
          <button class="btn btn-primary btn-sm" data-play ${complete ? "" : "disabled"}>Play offline</button>
          <button class="btn btn-ghost btn-sm" data-export ${complete ? "" : "disabled"} title="Put a copy in your Downloads folder">Save file</button>
          <button class="btn btn-ghost btn-sm" data-remove>Remove</button>
        </div>
      </div>`;
    })
    .join("");
}

savedList.addEventListener("click", async (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const id = card.dataset.id;
  const record = await savedLecture(id);
  if (!record) return;

  if (e.target.closest("[data-play]")) {
    // Play it *here*. A saved lecture that opens in a blank tab, or only exists
    // once it is written into Chrome's Downloads folder, does not look like
    // something this site kept — which is exactly how it was being read.
    const ok = await playSaved(id, { trigger: e.target.closest("[data-play]") });
    if (!ok) toast("That lecture could not be opened from this device", "bad");
    return;
  }

  if (e.target.closest("[data-export]")) {
    const { blob, name } = offlineFile(record);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    toast(`Copy saved to your device: ${name}`);
    return;
  }

  if (e.target.closest("[data-remove]")) {
    await removeLecture(id);
    await refreshSaved();
    toast("Removed from this device");
  }
});

onlyOffline.addEventListener("input", renderSaved);

clearBtn.addEventListener("click", async () => {
  await clearLectures();
  await refreshSaved();
  toast("Offline downloads cleared");
});

/* --------------------------------- space --------------------------------- */

async function renderSpace() {
  const est = await storageEstimate();
  if (!est) {
    spaceText.textContent = "This browser does not report free space.";
    spaceBar.querySelector("span").style.width = "0%";
    return;
  }
  const used = saved.reduce((n, r) => n + (r.bytes || 0), 0);
  const pct = est.quota ? Math.min(100, Math.round((est.usage / est.quota) * 100)) : 0;
  spaceBar.querySelector("span").style.width = `${Math.max(2, pct)}%`;

  // Lectures are not the only thing this site keeps now: notes and DPPs read in
  // the viewer are stored too. Say so, because "why is my quota bigger than my
  // lectures" is otherwise a mystery, and so is the reverse.
  const kept = await countKeptDocs();
  const tail = kept ? ` · ${kept} note${kept === 1 ? "" : "s"} kept` : "";
  spaceText.textContent = `${fmtBytes(used)} in saved files${tail} · ${fmtBytes(est.usage)} used of ${fmtBytes(
    est.quota
  )} available`;
}

/** How many notes/DPPs the worker is holding — read from the cache, not counted. */
async function countKeptDocs() {
  if (!("caches" in window)) return 0;
  try {
    const names = await caches.keys();
    let n = 0;
    for (const name of names) {
      if (!name.includes("files")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (request.url.includes("/api/media?")) n += 1;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/* --------------------------------- boot ---------------------------------- */

async function boot() {
  pick = readPick();

  // A browser that cannot store anything (private mode, storage disabled, an
  // embedded webview) still gets the page: it browses fine, and it says so
  // instead of throwing on the first read.
  if (!canStoreOffline()) {
    stepSubject.hidden = false;
    subjectList.innerHTML = emptyState(
      "Offline saving is turned off in this browser",
      "Private mode and some in-app browsers block local storage. Open the site in a normal window to keep notes and DPPs on this device.",
      ""
    );
    savedList.innerHTML = "";
    savedEmpty.hidden = false;
    spaceText.textContent = "Storage is unavailable in this browser.";
    persistNote.textContent = "This browser will not keep saved files.";
    return;
  }

  await refreshSaved();

  try {
    const persisted = await requestPersistence();
    persistNote.textContent = persisted
      ? "This device keeps saved files until you remove them."
      : "Saved files stay in this browser — keep them if you clear your site data.";
  } catch {
    persistNote.textContent = "Saved files stay in this browser.";
  }

  if (!pick.batch) {
    subjectList.innerHTML = noBatch();
    stepSubject.hidden = false;
    return;
  }

  batchInput.value = pick.batch.name || "";
  pickMeta.textContent = pick.batch.name || "";
  await loadSubjects(pick.batch);
  if (pick.subject) await loadChapters(pick.batch, pick.subject);
  if (pick.subject && pick.chapter) await loadLectures(pick.batch, pick.subject, pick.chapter);
}

boot();
