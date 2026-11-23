/* =========================================================================
   Study Hall — the one chat room for the whole site.
   -------------------------------------------------------------------------
   It rides the same server thread the lecture comments use
   (/api/token?route=comments) with the room id "study-hall", so no new
   backend exists to break: messages are cleaned, capped and stored by
   lib/comments.mjs, and the page states honestly when the store is
   per-instance memory. The hall polls gently while visible, keeps the
   reader pinned to the newest message only if they already were, and
   never eats a half-typed message on a refresh.
   ========================================================================= */

import { mountChrome, esc, getSession, toast } from "./app.js";

mountChrome("chat");

const ROOM = "study-hall";
const list = document.getElementById("chatList");
const form = document.getElementById("chatForm");
const nameEl = document.getElementById("chatName");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("chatSend");
const counter = document.getElementById("chatCounter");
const countEl = document.getElementById("chatCount");
const storeEl = document.getElementById("chatStore");

const session = getSession();
if (nameEl) {
  nameEl.value = session?.name || localStorage.getItem("arsvibe.name") || "";
}
const myName = () => (nameEl?.value || "").trim();

function ago(at) {
  const ms = Date.now() - Date.parse(at || "");
  if (!Number.isFinite(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

let known = new Map();

function render(comments, store) {
  const rows = [...(comments || [])].reverse(); // the hall reads top→bottom, old→new
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  countEl.textContent = `${rows.length} message${rows.length === 1 ? "" : "s"}`;
  storeEl.textContent = store && store !== "memory" ? "· shared hall" : "· live on this server";
  if (!rows.length) {
    list.innerHTML = `<p class="tiny dim chat-empty">The hall is quiet — say the first hello 👋</p>`;
    known = new Map();
    return;
  }
  list.innerHTML = rows
    .map((c) => {
      const mine = myName() && c.name === myName();
      return `<div class="chat-row${mine ? " mine" : ""}">
        <span class="comment-avatar" aria-hidden="true">${esc((c.name || "S").slice(0, 1).toUpperCase())}</span>
        <div class="chat-bubble">
          <div class="comment-head"><strong>${esc(c.name || "Student")}</strong><span class="tiny dim">${ago(c.at)}</span></div>
          <p>${esc(c.text || "")}</p>
          <button class="chat-like" type="button" data-like="${esc(c.id)}" aria-label="Appreciate this message">♥ ${c.likes || ""}</button>
        </div>
      </div>`;
    })
    .join("");
  known = new Map(rows.map((c) => [c.id, c.likes || 0]));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

async function load() {
  try {
    const res = await fetch(`/api/token?route=comments&lecture=${ROOM}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (data?.success) render(data.comments || [], data.store);
  } catch {
    /* the next poll is the retry */
  }
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = (input.value || "").trim();
  if (!text) return;
  const name = myName() || "Student";
  try { localStorage.setItem("arsvibe.name", name); } catch { /* ignore */ }
  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/token?route=comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lecture: ROOM, name, text }),
    });
    const data = await res.json().catch(() => null);
    if (!data?.success) throw new Error(data?.error || "The message did not land");
    input.value = "";
    counter.textContent = "300";
    render(data.comments || [], data.store);
    list.scrollTop = list.scrollHeight;
  } catch (err) {
    toast(err.message || "The message did not land — the hall will still be here", "bad");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

input?.addEventListener("input", () => {
  counter.textContent = String(300 - (input.value || "").length);
});

list?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-like]");
  if (!btn) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/token?route=comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lecture: ROOM, like: btn.dataset.like }),
    });
    const data = await res.json().catch(() => null);
    if (data?.success) render(data.comments || [], data.store);
  } catch { /* appreciation is optional */ } finally {
    btn.disabled = false;
  }
});

/* The hall breathes on its own while it is on screen. */
load();
setInterval(() => { if (!document.hidden) load(); }, 6000);
