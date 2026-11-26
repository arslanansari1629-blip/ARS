/**
 * The Allen platform page: batches → subjects → chapters → lectures
 * → playback, entirely over /api/allen. Allen batch codes are not
 * PW ids, and the bt_/cr_ drill-down ids never leave this page's
 * own API — PW and Allen share no code path here.
 */
const $ = (s) => document.querySelector(s);
const savedKey = "arsvibe.allen.saved.v1";
const historyKey = "arsvibe.allen.history.v1";

let all = [];
let exam = "All";
let showSaved = false;
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
    <div class="batch-card-body">
      <div class="row" style="gap:6px;align-items:center">
        <span class="badge">${batch.exam}</span>
        ${batch.class ? `<span class="tiny dim">${batch.class}</span>` : ""}
        ${batch.live ? `<span class="badge live-badge">LIVE</span>` : ""}
        <span class="tiny dim" style="margin-left:auto">${batch.code}</span>
      </div>
      <h3 class="batch-name"></h3>
      ${batch.type ? `<p class="tiny dim">${batch.type}${batch.timing ? ` • ${batch.timing}` : ""}</p>` : ""}
      <div class="row" style="gap:8px">
        <button class="btn btn-sm btn-primary" data-explore type="button">Explore</button>
        <button class="btn btn-sm btn-ghost" data-save type="button">${isSaved(batch.code) ? "Saved ✓" : "Save"}</button>
      </div>
    </div>`;
  // Names and codes come from a third-party catalogue: they are data,
  // never markup.
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
  $("#allenGrid").replaceChildren(...rows.map(card));
  $("#allenStatus").textContent = rows.length
    ? `All Batches (${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ""})`
    : all.length
      ? "No Allen batches match that filter."
      : "The Allen catalogue is quiet right now — it will recover on its own when the upstream answers again.";
}

async function loadCatalogue() {
  paintSavedCount();
  const out = await api("/api/allen?view=batches");
  all = Array.isArray(out.items) ? out.items : [];
  renderGrid();
}

async function openBatch(batch) {
  $("#allenCatalogue").hidden = true;
  $("#allenWatch").hidden = true;
  $("#allenBatch").hidden = false;
  $("#allenBatchName").textContent = batch.name;
  $("#allenBatchMeta").textContent = [batch.class, batch.exam, batch.type, batch.code].filter(Boolean).join(" • ");
  $("#allenSubjects").replaceChildren();
  $("#allenTopicsWrap").hidden = true;
  $("#allenLecturesWrap").hidden = true;
  const out = await api(
    `/api/allen?view=subjects&batch=${encodeURIComponent(batch.batchId)}&course=${encodeURIComponent(batch.courseId)}`
  );
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
      el.innerHTML = `<h3></h3><p class="tiny dim">${s.tag || s.badge || "Lectures"}</p><button class="btn btn-sm btn-primary" type="button">Open chapters</button>`;
      el.querySelector("h3").textContent = s.name;
      el.querySelector("button").addEventListener("click", () => openSubject(batch, s));
      return el;
    })
  );
}

async function openSubject(batch, subject) {
  const out = await api(
    `/api/allen?view=topics&batch=${encodeURIComponent(batch.batchId)}&course=${encodeURIComponent(batch.courseId)}&subject=${encodeURIComponent(subject.id)}&taxonomy=${encodeURIComponent(subject.taxonomyId)}`
  );
  const topics = Array.isArray(out.items) ? out.items : [];
  $("#allenTopicHead").textContent = `${subject.name} — chapters`;
  const list = $("#allenTopics");
  list.replaceChildren(
    ...topics.map((t) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.cssText = "gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#3332)";
      row.innerHTML = `<span class="tiny dim">${t.order || ""}</span><span style="flex:1"></span>${t.completed ? `<span class="badge">Completed</span>` : ""}<button class="btn btn-sm btn-primary" type="button">Open chapter</button>`;
      row.querySelector("span:nth-child(2)").textContent = t.name;
      row.querySelector("button").addEventListener("click", () => openTopic(batch, subject, t));
      return row;
    })
  );
  if (!topics.length) list.innerHTML = `<p class="tiny dim">No chapters answered upstream for this subject yet.</p>`;
  $("#allenLecturesWrap").hidden = true;
  $("#allenTopicsWrap").hidden = false;
  $("#allenTopicsWrap").scrollIntoView({ behavior: "smooth" });
}

async function openTopic(batch, subject, topic) {
  const out = await api(
    `/api/allen?view=lectures&batch=${encodeURIComponent(batch.batchId)}&course=${encodeURIComponent(batch.courseId)}&subject=${encodeURIComponent(subject.id)}&taxonomy=${encodeURIComponent(subject.taxonomyId)}&topic=${encodeURIComponent(topic.id)}`
  );
  const lectures = Array.isArray(out.items) ? out.items : [];
  $("#allenLectureHead").textContent = `${topic.name} — lectures`;
  const list = $("#allenLectures");
  list.replaceChildren(
    ...lectures.map((lec, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.cssText = "gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#3332)";
      row.innerHTML = `<span class="tiny dim">${i + 1}</span><span style="flex:1"></span><span class="tiny dim">${lec.date || ""}</span><span class="tiny dim">${lec.duration || ""}</span><button class="btn btn-sm btn-primary" type="button">Watch</button>`;
      row.querySelector("span:nth-child(2)").textContent = lec.subTopics?.length ? `${lec.title} — ${lec.subTopics.join(", ")}` : lec.title;
      row.querySelector("button").addEventListener("click", () => watch(batch, subject, lec));
      return row;
    })
  );
  if (!lectures.length) list.innerHTML = `<p class="tiny dim">No lectures answered upstream for this chapter yet.</p>`;
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
  if (!lec.playUrl) {
    note.textContent = "This lecture carries no play address upstream.";
    return;
  }
  const out = await api(`/api/allen?view=play&play=${encodeURIComponent(lec.playUrl)}`);
  if (!out.success || !out.url) {
    note.textContent =
      "Playback is not answering upstream for this lecture yet — Allen streams ride on donated accounts, so some lectures stay dark until an account covers this batch.";
    return;
  }
  const history = readJson(historyKey, []);
  history.unshift({ code: batch.code, subject: subject.name, title: lec.title, at: Date.now() });
  localStorage.setItem(historyKey, JSON.stringify(history.slice(0, 50)));
  const proxied = `/api/media?url=${encodeURIComponent(out.url)}`;
  if (window.Hls && window.Hls.isSupported() && /\.m3u8($|\?)/i.test(out.url)) {
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
