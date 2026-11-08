/* Dashboard — greeting, stats, recent batches, continue watching */

import {
  mountChrome,
  requireSession,
  signOut,
  esc,
  fmtRelative,
  emptyState,
} from "./app.js";
import { getLibrary } from "./library.js";

mountChrome("dashboard");

const session = requireSession();
if (session) {
  document.getElementById("greeting").textContent = `Welcome back, ${session.name.split(" ")[0]} 👋`;
  document.getElementById("profileLine").textContent = `${session.email} · joined ${new Date(
    session.joinedAt || Date.now()
  ).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;

  document.getElementById("signOutBtn").addEventListener("click", () => {
    signOut();
    location.href = "/";
  });

  const lib = getLibrary();

  document.getElementById("statBatches").textContent = lib.batches.length;
  document.getElementById("statLectures").textContent = lib.lectures.length;
  document.getElementById("statDocs").textContent = lib.docs.length;

  document.getElementById("recentList").innerHTML = lib.batches.length
    ? lib.batches
        .slice(0, 6)
        .map(
          (b) => `
        <a class="history-row" href="/batch.html?id=${encodeURIComponent(b.id)}">
          ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<img alt="" />`}
          <span class="grow">
            <span class="tiny" style="font-weight:700;display:block">${esc(b.name)}</span>
            <span class="tiny dim">${esc(fmtRelative(new Date(b.at).toISOString()))}</span>
          </span>
          <svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
        </a>`
        )
        .join("")
    : emptyState("No batches yet", "Open a batch to see it here.", `<a class="btn btn-primary btn-sm" href="/batches.html">Browse</a>`);

  document.getElementById("historyList").innerHTML = lib.lectures.length
    ? lib.lectures
        .slice(0, 8)
        .map(
          (l) => `
        <a class="history-row" href="/lecture.html?batch=${encodeURIComponent(l.batch)}&subject=${encodeURIComponent(
            l.subject
          )}&id=${encodeURIComponent(l.id)}&title=${encodeURIComponent(l.title || "Lecture")}">
          ${l.thumbnail ? `<img src="${esc(l.thumbnail)}" alt="" loading="lazy" onerror="this.remove()" />` : `<img alt="" />`}
          <span class="grow">
            <span class="tiny" style="font-weight:700;display:block" >${esc(l.title || "Lecture")}</span>
            <span class="tiny dim">${esc(l.chapter || "")}</span>
          </span>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand-2)" stroke-width="2"><path d="M8 5v14l11-7z"/></svg>
        </a>`
        )
        .join("")
    : emptyState("Nothing in progress", "Start a lecture and it shows up here.");
}
