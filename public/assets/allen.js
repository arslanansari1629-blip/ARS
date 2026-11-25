/**
 * The Allen platform page: batch catalogue → subjects → lectures →
 * playback, entirely over /api/allen. PW and Allen never share a
 * code path here — Allen batch codes are not PW ids, and this page
 * keeps them that way.
 */
const $ = (s) => document.querySelector(s);
const savedKey = "arsvibe.allen.saved.v1";
const historyKey = "arsvibe.allen.history.v1";

let all = [];
let exam = "All";
let showSaved = false;
let currentCode = "";
let hls = null;

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
};
const saved = () => readJson(savedKey, []);
const isSaved = (code) => saved().includes(code);
function toggleSaved(code) {
  const list = saved().filter((c) => c !== code);
  if (!isSaved(code)) list.push(code);
  localStorage.setItem(savedKey, JSON.stringify(list));
  paintSavedCount();
  renderGrid();
}
function paintSavedCount() {
  $("#allenSavedCount").textContent = String(saved().length);
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  return res.json().catch(() => ({ success: false, items: [] }));
}

function card(batch) {
  const el = document.createElement("article");
  el.className = "card batch-card";
  el.innerHTML = `
    ${batch.image ? `<img class="batch-photo" src="${batch.image}" alt="" loading="lazy" />` : ""}
    <div class="batch-card-body">
      <div class="row" style="gap:6px;align-items:center">
        <span class="badge">${batch.exam}</span>
        ${batch.class ? `<span class="tiny dim">${batch.class}</span>` : ""}
        ${batch.live ? `<span class="badge live-badge">LIVE</span>` : ""}
        <span class="tiny dim" style="margin-left:auto">${batch.code}</span>
      </div>
      <h3 class="batch-name">${batch.name}</h3>
      <div class="row" style="gap:8px">
        <button class="btn btn-sm btn-primary" data-explore type="button">Explore</button>
        <button class="btn btn-sm btn-ghost" data-save type="button">${isSaved(batch.code) ? "Saved ✓" : "Save"}</button>
      </div>
    </div>`;
  // Names and codes come from a third-party catalogue: they are data,
  // never markup. Re-fill the text nodes so nothing upstream can inject.
  el.querySelector(".batch-name").textContent = batch.name;
  el.querySelector("[data-explore]").addEventListener("click", () => openBatch(batch));
  el.querySelector("[data-save]").addEventListener("click", () => toggleSaved(batch.code));
  return el;
}

function renderGrid() {
  const term = $("#allenSearch").value.trim().toLowerCase();
  const rows = all.filter((b) => {
    if (showSaved && !isSaved(b.code)) return false;
    if (exam !== "All" && b.exam !== exam) return false;
    if (!term) return true;
    return `${b.name} ${b.code} ${b.class} ${b.exam}`.toLowerCase().includes(term);
  });
  const grid = $("#allenGrid");
  grid.replaceChildren(...rows.map(card));
  $("#allenStatus").textContent = rows.length
    ? `All Batches (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ""})`
    : all.length
      ? "No Allen batches match that filter."
      : "The Allen catalogue is quiet right now — the upstream route may have moved. The section will recover automatically when it answers again.";
}

async function loadCatalogue() {
  paintSavedCount();
  const out = await api("/api/allen?view=batches");
  all = Array.isArray(out.items) ? out.items : [];
  renderGrid();
}

async function openBatch(batch) {
  currentCode = batch.code;
  $("#allenCatalogue").hidden = true;
  $("#allenWatch").hidden = true;
  $("#allenBatch").hidden = false;
  $("#allenBatchName").textContent = batch.name;
  $("#allenBatchMeta").textContent = [batch.class, batch.exam, batch.language, batch.code].filter(Boolean).join(" • ");
  $("#allenSubjects").replaceChildren();
  $("#allenLecturesWrap").hidden = true;
  const out = await api(`/api/allen?view=subjects&code=${encodeURIComponent(batch.code)}`);
  const subjects = Array.isArray(out.items) ? out.items : [];
  const box = $("#allenSubjects");
  if (!subjects.length) {
    box.innerHTML = `<p class="tiny dim">Subjects are not answering upstream for this batch yet.</p>`;
    return;
  }
  box.replaceChildren(
    ...subjects.map((s) => {
      const el = document.createElement("article");
      el.className = "card";
      el.innerHTML = `<h3></h3><p class="tiny dim">${s.lectures ? `${s.lectures} lectures` : "Lectures"}</p><button class="btn btn-sm btn-primary" type="button">Open lectures</button>`;
      el.querySelector("h3").textContent = s.name;
      el.querySelector("button").addEventListener("click", () => openSubject(batch, s));
      return el;
    })
  );
  box.querySelector(".card")?.scrollIntoView({ behavior: "smooth" });
}

async function openSubject(batch, subject) {
  const out = await api(
    `/api/allen?view=lectures&code=${encodeURIComponent(batch.code)}&subject=${encodeURIComponent(subject.id)}`
  );
  const lectures = Array.isArray(out.items) ? out.items : [];
  $("#allenLectureHead").textContent = `${subject.name} — lectures`;
  const list = $("#allenLectures");
  list.replaceChildren(
    ...lectures.map((lec, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.cssText = "gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#3332)";
      row.innerHTML = `<span class="tiny dim">${i + 1}</span><span style="flex:1"></span>${lec.live ? `<span class="badge live-badge">LIVE</span>` : ""}<span class="tiny dim">${lec.duration || ""}</span><button class="btn btn-sm btn-primary" type="button">Watch</button>`;
      row.querySelector("span:nth-child(2)").textContent = lec.title;
      row.querySelector("button").addEventListener("click", () => watch(batch, subject, lec));
      return row;
    })
  );
  if (!lectures.length) list.innerHTML = `<p class="tiny dim">No lectures answered upstream for this subject yet.</p>`;
  $("#allenLecturesWrap").hidden = false;
  $("#allenLecturesWrap").scrollIntoView({ behavior: "smooth" });
}

async function watch(batch, subject, lec) {
  $("#allenBatch").hidden = true;
  $("#allenWatch").hidden = false;
  $("#allenWatchTitle").textContent = lec.title;
  const note = $("#allenWatchNote");
  note.textContent = "Asking the Allen upstream for the stream…";
  const video = $("#allenVideo");
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.removeAttribute("src");
  const out = await api(`/api/allen?view=stream&id=${encodeURIComponent(lec.id)}`);
  if (!out.success || !out.url) {
    note.textContent =
      "Playback is not answering upstream for this lecture yet — Allen streams ride on donated accounts, so some lectures stay dark until an account covers this batch.";
    return;
  }
  const proxied = out.url.startsWith("http")
    ? `/api/media?url=${encodeURIComponent(out.url)}`
    : out.url;
  const history = readJson(historyKey, []);
  history.unshift({ code: batch.code, subject: subject.name, title: lec.title, at: Date.now() });
  localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 50)));
  if (window.Hls && window.Hls.isSupported() && /\.m3u8($|\?)/i.test(proxied)) {
    hls = new window.Hls();
    hls.loadSource(proxied);
    hls.attachMedia(video);
  } else {
    video.src = proxied;
  }
  note.textContent = "";
  video.play().catch(() => {});
}

document.addEventListener("DOMContentLoaded", () => {
  $("#allenSearch").addEventListener("input", renderGrid);
  $("#allenExamChips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-exam]");
    if (!btn) return;
    exam = btn.dataset.exam;
    document.querySelectorAll("#allenExamChips [data-exam]").forEach((b) => {
      b.className = `btn btn-sm ${b.dataset.exam === exam ? "btn-primary" : "btn-ghost"}`;
    });
    renderGrid();
  });
  $("#allenSavedTab").addEventListener("click", () => {
    showSaved = !showSaved;
    renderGrid();
  });
  $("#allenBack").addEventListener("click", () => {
    $("#allenBatch").hidden = true;
    $("#allenCatalogue").hidden = false;
  });
  $("#allenWatchBack").addEventListener("click", () => {
    const video = $("#allenVideo");
    video.pause();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    $("#allenWatch").hidden = true;
    $("#allenBatch").hidden = false;
  });
  loadCatalogue().catch(() => {
    $("#allenStatus").textContent = "The Allen catalogue could not load — check the connection and retry.";
  });
});
