/* =========================================================================
   Watch notes — timestamped notes & bookmarks for one lecture.
   -------------------------------------------------------------------------
   A companion module, deliberately not part of the player: it borrows the
   <video> element's clock, nothing else. Notes live in this browser under
   notes:<lectureId> — the same local-first pattern as the player's own
   pos:<id> — so they cost no request and survive reloads. Clicking a note
   seeks; the player never has to know this file exists.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const lectureId = params.get("id") || "";
const KEY = `notes:${lectureId}`;
const video = document.getElementById("video");
const listEl = document.getElementById("notesList");
const input = document.getElementById("noteInput");
const addBtn = document.getElementById("noteAdd");
const markBtn = document.getElementById("noteMark");
const stamp = document.getElementById("noteStamp");

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function load() {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(rows) ? rows.filter((n) => n && Number.isFinite(n.t)) : [];
  } catch {
    return [];
  }
}
function save(rows) {
  try { localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 200))); } catch { /* storage full/blocked: notes are a courtesy */ }
}

function render() {
  if (!listEl) return;
  const rows = load().sort((a, b) => a.t - b.t);
  listEl.innerHTML = rows.length
    ? rows.map((n, i) => `
      <div class="note-row">
        <button type="button" class="note-seek" data-i="${i}" title="Jump to ${fmt(n.t)}">${fmt(n.t)}</button>
        <span class="note-text">${n.text ? esc(n.text) : "<em>Bookmark</em>"}</span>
        <button type="button" class="note-del" data-i="${i}" aria-label="Delete note">✕</button>
      </div>`).join("")
    : `<p class="tiny dim">No notes yet. Pause at the moment that matters, write what clicked, and it is one tap away forever.</p>`;
}

function add(text) {
  if (!video) return;
  const rows = load();
  rows.push({ t: Math.floor(video.currentTime || 0), text: String(text || "").trim(), at: Date.now() });
  save(rows);
  render();
}

if (video && listEl && lectureId) {
  render();
  const paintStamp = () => { if (stamp) stamp.textContent = fmt(video.currentTime); };
  video.addEventListener("timeupdate", paintStamp);
  paintStamp();

  addBtn?.addEventListener("click", () => {
    add(input?.value || "");
    if (input) input.value = "";
    input?.focus();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addBtn?.click(); }
  });
  markBtn?.addEventListener("click", () => add(""));
  listEl.addEventListener("click", (e) => {
    const seek = e.target.closest(".note-seek");
    const del = e.target.closest(".note-del");
    const rows = load().sort((a, b) => a.t - b.t);
    if (seek) {
      const n = rows[Number(seek.dataset.i)];
      if (n) { video.currentTime = n.t; video.play?.().catch(() => {}); }
    }
    if (del) {
      rows.splice(Number(del.dataset.i), 1);
      save(rows);
      render();
    }
  });
}
