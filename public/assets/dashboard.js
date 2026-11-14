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
import { progress, nextMilestone } from "./progress.js";

mountChrome("dashboard");

/**
 * XP and the streak, painted before the session check.
 *
 * They are a record of this browser, not of an account, so they are true for a
 * signed-out visitor too — and waiting for the sign-in redirect would flash an
 * empty band at exactly the student who has the most to show.
 */
function paintProgress() {
  const p = progress();
  const byId = (id) => document.getElementById(id);
  const total = byId("xpTotal");
  if (!total) return;

  total.textContent = p.xp.toLocaleString("en-IN");
  byId("xpLevel").textContent = `Level ${p.level} · ${p.title}`;
  const bar = byId("xpBar");
  bar.setAttribute("aria-valuenow", String(p.percent));
  bar.setAttribute("aria-valuetext", `${p.into} of ${p.span} XP to level ${p.level + 1}`);
  byId("xpBarFill").style.width = `${p.percent}%`;

  const next = nextMilestone(p.xp);
  byId("xpNext").textContent = next
    ? `${p.into} / ${p.span} XP into this level · ${next.remaining.toLocaleString("en-IN")} XP to “${next.label}”`
    : `${p.into} / ${p.span} XP into this level · every milestone cleared`;

  byId("streakCurrent").textContent = p.streak.current;
  byId("streakNote").textContent = p.streak.atRisk
    ? `At risk: no paper yet today.`
    : p.streak.studiedToday
      ? `Today counts. Longest: ${p.streak.longest}.`
      : "Mark a paper to start a streak.";

  byId("streakWeek").innerHTML = p.week
    .map(
      (d) => `
      <li class="sw-day${d.active ? " on" : ""}${d.isToday ? " today" : ""}" title="${d.day} — ${d.dpp} paper${d.dpp === 1 ? "" : "s"}">
        <span class="sw-dot" aria-hidden="true"></span>
        <span class="sw-label">${new Date(d.day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "narrow" })}</span>
      </li>`
    )
    .join("");
}

paintProgress();
window.addEventListener("progress:change", paintProgress);

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
   * nothing on the dashboard ever read it, so the lecture list was a set of
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
        const href = `/watch.html?batch=${encodeURIComponent(l.batch)}&subject=${encodeURIComponent(
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
        <a class="history-row" href="/watch.html?batch=${encodeURIComponent(l.batch)}&subject=${encodeURIComponent(
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
