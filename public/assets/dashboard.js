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
import { favouriteCount } from "./favourites.js";

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
  document.getElementById("statFavs").textContent = favouriteCount();

  /**
   * Resume rail + watch time.
   *
   * The player saves its position under `pos:<lectureId>` every few seconds;
   * nothing on the dashboard ever read it, so "Continue watching" was a list of
   * lectures with no idea how far in you were. Reading the same keys costs no
   * request and is always current, because the player writes them.
   */
  const fmtLeft = (sec) => {
    const m = Math.round(sec / 60);
    if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m left`;
    return `${m}m left`;
  };

  let watched = 0;
  const resumable = [];
  for (const l of lib.lectures) {
    const pos = Number(localStorage.getItem(`pos:${l.id}`) || 0);
    watched += pos;
    if (pos > 12) resumable.push({ ...l, pos });
  }
  // Longest-watched first: that is the lecture actually in progress.
  resumable.sort((a, b) => b.pos - a.pos);

  document.getElementById("statWatch").textContent =
    watched >= 3600
      ? `${Math.floor(watched / 3600)}h ${Math.round((watched % 3600) / 60)}m`
      : `${Math.round(watched / 60)}m`;

  const band = document.getElementById("resumeBand");
  const rail = document.getElementById("resumeRail");
  if (band && rail && resumable.length) {
    band.hidden = false;
    rail.innerHTML = resumable
      .slice(0, 6)
      .map((l) => {
        const href = `/lecture.html?batch=${encodeURIComponent(l.batch)}&subject=${encodeURIComponent(
          l.subject
        )}&id=${encodeURIComponent(l.id)}&title=${encodeURIComponent(l.title || "Lecture")}`;
        return `
          <a class="resume-card" href="${href}">
            <span class="resume-thumb">
              ${l.thumbnail ? `<img src="${esc(l.thumbnail)}" alt="" loading="lazy" onerror="this.remove()" />` : `<span class="resume-ph">▶</span>`}
              <span class="resume-at">${Math.round(l.pos / 60)}m in</span>
            </span>
            <span class="resume-text">
              <strong>${esc(l.title || "Lecture")}</strong>
              <span class="tiny dim">${esc(l.chapter || l.subject || "")}</span>
            </span>
            <span class="resume-go">Resume</span>
          </a>`;
      })
      .join("");
  }

  document.getElementById("recentList").innerHTML = lib.batches.length
    ? lib.batches
        .slice(0, 6)
        .map(
          (b) => `
        <a class="history-row" href="/batch.html?id=${encodeURIComponent(b.id)}">
          ${b.image ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />` : `<img alt="" />`}
          <span class="grow">
            <span class="tiny strong-block">${esc(b.name)}</span>
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
            <span class="tiny strong-block">${esc(l.title || "Lecture")}</span>
            <span class="tiny dim">${esc(l.chapter || "")}</span>
          </span>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand-2)" stroke-width="2"><path d="M8 5v14l11-7z"/></svg>
        </a>`
        )
        .join("")
    : emptyState("Nothing in progress", "Start a lecture and it shows up here.");
}
