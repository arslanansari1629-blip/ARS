/* Next Toppers platform page: catalogue → course folder tree →
   player, all from /api/nexttopper. The page is honest about the
   three upstream truths the drill-down can meet: a folder can be
   empty (say so, no retry loop), a leaf can be a PDF/test (say what
   it is), and a video can be VdoCipher-sealed (say that too). */

const $ = (s) => document.querySelector(s);
const api = (qs) => fetch(`/api/nexttopper?${qs}`, { headers: { Accept: "application/json" } }).then((r) => r.json());
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SAVED_KEY = "arsvibe.nt.saved.v1";
const POS_KEY = (id) => `arsvibe.nt.pos.${id}`;
const saved = new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"));
const persistSaved = () => localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));

let courses = [];
let classFilter = "All";
let savedOnly = false;
let course = null; // current course record
let folderPath = [{ id: "0", name: "Root" }];
let folderItems = [];
let hls = null;

/* ---------------- catalogue ---------------- */

function paintSavedCounts() {
  $("#ntSavedCount").textContent = String(saved.size);
  $("#ntStatSaved").textContent = String(saved.size);
}

function renderChips() {
  const classes = ["All", ...new Set(courses.map((c) => c.class).filter(Boolean))];
  $("#ntClassChips").innerHTML = classes
    .map((c) => `<button class="nt-chip${c === classFilter ? " on" : ""}" data-class="${esc(c)}" type="button">${esc(c)}</button>`)
    .join("");
  $("#ntClassChips").querySelectorAll("[data-class]").forEach((b) =>
    b.addEventListener("click", () => {
      classFilter = b.dataset.class;
      renderChips();
      renderGrid();
    })
  );
}

function cardHtml(c) {
  const isSaved = saved.has(c.id);
  return `<article class="nt-card" data-open="${esc(c.id)}" tabindex="0" role="button" aria-label="Open ${esc(c.title)}">
    ${c.thumbnail ? `<img class="nt-thumb" src="${esc(c.thumbnail)}" alt="" loading="lazy" />` : ""}
    <span class="nt-kind">${esc(c.class)} · Next Toppers</span>
    <strong>${esc(c.title)}</strong>
    <span class="nt-meta">${c.archive ? "2025-26 Archive · " : ""}Lectures · Notes · Tests</span>
    <button class="nt-save${isSaved ? " on" : ""}" data-save="${esc(c.id)}" type="button">${isSaved ? "★ Saved" : "☆ Save"}</button>
  </article>`;
}

function renderGrid() {
  const q = ($("#ntSearch").value || "").toLowerCase();
  const list = courses.filter(
    (c) =>
      (classFilter === "All" || c.class === classFilter) &&
      (!savedOnly || saved.has(c.id)) &&
      (!q || c.title.toLowerCase().includes(q))
  );
  $("#ntStatus").textContent = list.length
    ? `${list.length} Next Toppers batch${list.length === 1 ? "" : "es"}${classFilter !== "All" ? ` · ${classFilter}` : ""}`
    : "No batches match — search ya filter badal ke dekho.";
  $("#ntGrid").innerHTML = list.length ? list.map(cardHtml).join("") : `<div class="nt-empty">Kuch nahi mila.<br/>Doosra search try karo.</div>`;
  $("#ntGrid").querySelectorAll("[data-open]").forEach((el) => {
    const open = () => openCourse(el.dataset.open);
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-save]")) return;
      open();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open();
    });
  });
  $("#ntGrid").querySelectorAll("[data-save]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.save;
      saved.has(id) ? saved.delete(id) : saved.add(id);
      persistSaved();
      paintSavedCounts();
      renderGrid();
    })
  );
}

async function loadCatalogue() {
  $("#ntGrid").innerHTML = Array.from({ length: 8 }, () => `<div class="nt-skel"></div>`).join("");
  try {
    const d = await api("view=batches");
    if (!d.success || !Array.isArray(d.items) || !d.items.length) throw new Error(d.error || "empty");
    courses = d.items;
    $("#ntStatTotal").textContent = String(d.total || courses.length);
    $("#ntStatClasses").textContent = String(new Set(courses.map((c) => c.class)).size);
    renderChips();
    renderGrid();
  } catch {
    $("#ntStatus").textContent = "Next Toppers catalogue abhi answer nahi kar raha — thodi der mein phir try karo.";
    $("#ntGrid").innerHTML = `<div class="nt-empty">Catalogue load nahi hua.<br/>Connection check karke page refresh karo.</div>`;
  }
}

/* ---------------- course / folder tree ---------------- */

function show(section) {
  for (const id of ["#ntCatalogue", "#ntCourse", "#ntWatch"]) $(id).hidden = id !== section;
}

function renderCrumbs() {
  $("#ntCrumbs").innerHTML = folderPath
    .map((f, i) =>
      i === folderPath.length - 1
        ? `<span class="here">${esc(f.name)}</span>`
        : `<button type="button" data-crumb="${i}">${esc(f.name)}</button><span class="sep">›</span>`
    )
    .join(" ");
  $("#ntCrumbs").querySelectorAll("[data-crumb]").forEach((b) =>
    b.addEventListener("click", () => {
      const at = Number(b.dataset.crumb);
      folderPath = folderPath.slice(0, at + 1);
      loadFolder();
    })
  );
}

function countsText(item) {
  if (!item.counts) return "";
  const { folders, videos, pdfs, tests } = item.counts;
  const bits = [];
  if (folders) bits.push(`${folders} folders`);
  if (videos) bits.push(`${videos} videos`);
  if (pdfs) bits.push(`${pdfs} PDFs`);
  if (tests) bits.push(`${tests} tests`);
  return bits.join(" · ");
}

function itemHtml(item) {
  const icon = item.kind === "folder" ? "📁" : item.kind === "pdf" ? "📄" : item.kind === "test" ? "📝" : "▶️";
  const meta =
    item.kind === "folder"
      ? countsText(item) || "Folder"
      : item.kind === "test"
        ? "Mock test"
        : item.kind === "pdf"
          ? "PDF notes"
          : [item.duration && item.duration !== "0" ? esc(item.duration) : "", item.live ? "Live" : "Lecture"].filter(Boolean).join(" · ");
  return `<article class="nt-card" data-item="${esc(item.id)}" tabindex="0" role="button" aria-label="${esc(item.title)}">
    ${item.thumbnail ? `<img class="nt-thumb" src="${esc(item.thumbnail)}" alt="" loading="lazy" />` : ""}
    <span class="nt-kind">${icon} ${esc(item.kind)}</span>
    <strong>${esc(item.title)}</strong>
    <span class="nt-meta">${esc(meta)}</span>
  </article>`;
}

async function loadFolder() {
  renderCrumbs();
  const folder = folderPath[folderPath.length - 1];
  $("#ntContentStatus").textContent = "Loading…";
  $("#ntContent").innerHTML = Array.from({ length: 6 }, () => `<div class="nt-skel"></div>`).join("");
  try {
    const d = await api(`view=content&course=${encodeURIComponent(course.id)}&folder=${encodeURIComponent(folder.id)}`);
    if (!d.success) {
      folderItems = [];
      $("#ntContent").innerHTML = `<div class="nt-empty">${esc(
        d.empty ? "Is folder mein abhi kuch nahi hai — upstream khaali hai." : "Content answer nahi kar raha — wapas aake phir try karo."
      )}</div>`;
      $("#ntContentStatus").textContent = "";
      return;
    }
    folderItems = d.items;
    $("#ntContentStatus").textContent = `${d.total} item${d.total === 1 ? "" : "s"}`;
    $("#ntContent").innerHTML = folderItems.map(itemHtml).join("");
    $("#ntContent").querySelectorAll("[data-item]").forEach((el) => {
      const item = folderItems.find((x) => x.id === el.dataset.item);
      const act = () => item && openItem(item);
      el.addEventListener("click", act);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") act();
      });
    });
  } catch {
    $("#ntContentStatus").textContent = "";
    $("#ntContent").innerHTML = `<div class="nt-empty">Content load nahi hua — connection check karo.</div>`;
  }
}

async function openCourse(id) {
  course = courses.find((c) => c.id === id) || { id, title: `Course ${id}`, thumbnail: "", class: "" };
  folderPath = [{ id: "0", name: "Root" }];
  show("#ntCourse");
  $("#ntCourseTitle").textContent = course.title;
  $("#ntCourseMeta").textContent = [course.class, "Next Toppers"].filter(Boolean).join(" · ");
  const thumb = $("#ntCourseThumb");
  if (course.thumbnail) {
    thumb.src = course.thumbnail;
    thumb.hidden = false;
  } else thumb.hidden = true;
  $("#ntOverview").hidden = true;
  window.scrollTo({ top: 0 });
  // Overview is garnish: the folder tree must not wait on it.
  loadFolder();
  try {
    const d = await api(`view=details&course=${encodeURIComponent(course.id)}`);
    const desc = d?.course?.description?.trim();
    if (d.success && desc) {
      const el = $("#ntOverview");
      el.textContent = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (el.textContent) el.hidden = false;
      if (d.course.title) $("#ntCourseTitle").textContent = d.course.title;
    }
  } catch {
    /* overview is garnish */
  }
}

/* ---------------- playback ---------------- */

function stopPlayer() {
  const v = $("#ntVideo");
  try {
    v.pause();
    v.removeAttribute("src");
    v.load();
  } catch {
    /* already stopped */
  }
  if (hls) {
    try {
      hls.destroy();
    } catch {
      /* gone */
    }
    hls = null;
  }
  const f = $("#ntFrame");
  f.hidden = true;
  f.removeAttribute("src");
  v.hidden = false;
}

async function openItem(item) {
  if (item.kind === "folder") {
    folderPath = [...folderPath, { id: item.id, name: item.title }];
    loadFolder();
    return;
  }
  if (item.kind === "pdf") {
    $("#ntContentStatus").textContent = "PDF ka address la rahe hain…";
    try {
      const d = await api(
        `view=play&course=${encodeURIComponent(course.id)}&content=${encodeURIComponent(item.id)}&file=${encodeURIComponent(item.fileUrl || "")}`
      );
      if (!d.success || !(d.proxyUrl || d.url)) throw new Error(d.error || "no address");
      window.open(d.proxyUrl || d.url, "_blank", "noopener");
      $("#ntContentStatus").textContent = "";
    } catch (err) {
      $("#ntContentStatus").textContent = `Is PDF ka address nahi mila: ${err.message}`;
    }
    return;
  }
  if (item.kind === "test") {
    $("#ntContentStatus").textContent = "Tests abhi ArsVibe par nahi chalte — yeh sirf listing hai.";
    return;
  }
  // video
  show("#ntWatch");
  stopPlayer();
  $("#ntWatchTitle").textContent = item.title;
  $("#ntWatchMeta").textContent = [course?.title, item.duration && item.duration !== "0" ? item.duration : ""].filter(Boolean).join(" · ");
  $("#ntWatchNote").textContent = "Stream taiyaar kar rahe hain…";
  $("#ntUpNext").innerHTML = folderItems
    .filter((x) => x.kind === "video" && x.id !== item.id)
    .map(itemHtml)
    .join("");
  $("#ntUpNext").querySelectorAll("[data-item]").forEach((el) => {
    const next = folderItems.find((x) => x.id === el.dataset.item);
    el.addEventListener("click", () => next && openItem(next));
  });
  window.scrollTo({ top: 0 });
  try {
    const d = await api(
      `view=play&course=${encodeURIComponent(course.id)}&content=${encodeURIComponent(item.id)}&file=${encodeURIComponent(item.fileUrl || "")}&vdc=${encodeURIComponent(item.vdcId || "")}`
    );
    if (!d.success) throw new Error(d.error || "no stream");
    const v = $("#ntVideo");
    if (d.kind === "youtube") {
      const m = d.url.match(/(?:v=|youtu\.be\/)([\w-]{6,})/);
      v.hidden = true;
      const f = $("#ntFrame");
      f.src = m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : d.url;
      f.hidden = false;
      $("#ntWatchNote").textContent = "YouTube lecture";
      return;
    }
    const src = d.proxyUrl || d.url;
    if (d.kind === "hls" && window.Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(src);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    } else {
      v.src = src;
      v.play().catch(() => {});
    }
    // Resume where this lecture was left (Allen/PW parity).
    const at = Number(localStorage.getItem(POS_KEY(item.id)) || 0);
    if (at > 5) v.addEventListener("loadedmetadata", () => (v.currentTime = at), { once: true });
    v.ontimeupdate = () => {
      if (v.currentTime > 5 && !v.ended) localStorage.setItem(POS_KEY(item.id), String(Math.floor(v.currentTime)));
    };
    v.onended = () => localStorage.removeItem(POS_KEY(item.id));
    $("#ntWatchNote").textContent = item.live ? "Live / recorded lecture" : "Lecture ready hai";
  } catch (err) {
    $("#ntWatchNote").textContent = `Yeh lecture abhi play nahi ho raha: ${err.message}`;
  }
}

/* ---------------- wiring ---------------- */

$("#ntSearch").addEventListener("input", renderGrid);
$("#ntSavedTab").addEventListener("click", () => {
  savedOnly = !savedOnly;
  $("#ntSavedTab").classList.toggle("on", savedOnly);
  renderGrid();
});
$("#ntBack").addEventListener("click", () => show("#ntCatalogue"));
$("#ntWatchBack").addEventListener("click", () => {
  stopPlayer();
  show("#ntCourse");
});
paintSavedCounts();
loadCatalogue();
