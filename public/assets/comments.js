/* =========================================================================
   Class discussion — comments for this lecture, shared through the site.
   -------------------------------------------------------------------------
   The thread lives server-side (route=comments on the utility route, the
   twelve-function budget again) so a classroom sees one thread. It polls
   gently — 20 s, and only while the tab is visible — and says honestly in
   the header when the thread is instance-memory rather than shared.
   ========================================================================= */

const lectureId = new URLSearchParams(location.search).get("id") || "";
const log = document.getElementById("commentsLog");
const input = document.getElementById("commentInput");
const nameEl = document.getElementById("commentName");
const sendBtn = document.getElementById("commentSend");
const countEl = document.getElementById("commentsCount");
const noteEl = document.getElementById("commentsNote");

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (iso) => {
  const s = Math.max(1, (Date.now() - Date.parse(iso || "")) / 1000 || 1);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

try {
  const saved = localStorage.getItem("arsvibe.name") || "";
  if (nameEl && saved) nameEl.value = saved;
} catch { /* ignore */ }

function render(comments, store) {
  if (!log) return;
  if (countEl) countEl.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
  if (noteEl && store) {
    noteEl.textContent = store === "memory"
      ? "Discussion is warming up — this thread is per-instance until shared storage is attached."
      : "Doubts and discussion for this lecture, from everyone studying here.";
  }
  log.innerHTML = comments.length
    ? comments.map((c) => `
      <div class="comment-row">
        <span class="comment-avatar" aria-hidden="true">${esc((c.name || "S").slice(0, 1).toUpperCase())}</span>
        <div class="comment-main">
          <div class="comment-head"><strong>${esc(c.name)}</strong><span class="tiny dim">${ago(c.at)}</span></div>
          <p>${esc(c.text)}</p>
        </div>
        <button type="button" class="comment-like" data-like="${esc(c.id)}" title="Helpful">❤ ${c.likes || ""}</button>
      </div>`).join("")
    : `<p class="tiny dim">No comments yet — ask the first doubt.</p>`;
}

async function load() {
  if (!lectureId) return;
  try {
    const res = await fetch(`/api/token?route=comments&lecture=${encodeURIComponent(lectureId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (data?.success) render(data.comments || [], data.store);
  } catch { /* a failed poll changes nothing */ }
}

async function post() {
  const text = (input?.value || "").trim();
  if (!text || !lectureId) return;
  const name = (nameEl?.value || "").trim();
  try { localStorage.setItem("arsvibe.name", name); } catch { /* ignore */ }
  if (sendBtn) sendBtn.disabled = true;
  try {
    const res = await fetch("/api/token?route=comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lecture: lectureId, name, text }),
    });
    const data = await res.json().catch(() => null);
    if (data?.success) {
      if (input) input.value = "";
      render(data.comments || [], data.store);
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

if (log && lectureId) {
  load();
  setInterval(() => { if (!document.hidden) load(); }, 20000);
  sendBtn?.addEventListener("click", post);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); post(); }
  });
  log.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-like]");
    if (!btn) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/token?route=comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lecture: lectureId, like: btn.dataset.like }),
      });
      const data = await res.json().catch(() => null);
      if (data?.success) render(data.comments || [], data.store);
    } catch { btn.disabled = false; }
  });
}
