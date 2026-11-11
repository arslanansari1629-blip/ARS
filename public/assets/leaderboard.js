/* Leaderboard — where this student stands, and what the board is worth.
 *
 * Two sources, deliberately separated:
 *
 *   · the left-hand numbers (XP, level, streak, milestones) are computed from
 *     the ledger in this browser, by progress.js. They are always available,
 *     even offline, and they cannot be inflated by editing the board.
 *   · the board itself comes from `GET /api/token?route=board`, which is the
 *     only thing here that knows about other people.
 *
 * The page's job is to make that difference visible rather than confusing: when
 * the route reports a board backed by one instance's memory, the note under the
 * heading says so instead of implying a worldwide ranking.
 */

import { mountChrome, esc, getSession, toast } from "./app.js";
import {
  progress,
  milestones,
  nextMilestone,
  displayName,
  browserId,
  AWARDS,
  PAPER_BONUS,
} from "./progress.js";

mountChrome("leaderboard");

const session = getSession();
const me = browserId();

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ your standing */

function renderMine() {
  const p = progress();

  $("xpTotal").textContent = p.xp.toLocaleString("en-IN");
  $("xpLevel").textContent = `Level ${p.level} · ${p.title}`;
  const bar = $("xpBar");
  bar.setAttribute("aria-valuenow", String(p.percent));
  bar.setAttribute("aria-valuetext", `${p.into} of ${p.span} XP to level ${p.level + 1}`);
  $("xpBarFill").style.width = `${p.percent}%`;

  const next = nextMilestone(p.xp);
  $("xpNext").textContent = next
    ? `${p.into} / ${p.span} XP into this level · ${next.remaining.toLocaleString("en-IN")} XP to “${next.label}”`
    : `${p.into} / ${p.span} XP into this level · every milestone cleared`;

  $("streakCurrent").textContent = p.streak.current;
  $("streakNote").textContent = p.streak.atRisk
    ? `Your ${p.streak.current}-day streak is at risk: no paper yet today.`
    : p.streak.studiedToday
      ? `Today counts. Longest run: ${p.streak.longest} day${p.streak.longest === 1 ? "" : "s"}.`
      : "Mark a paper today to start a streak.";

  $("streakWeek").innerHTML = p.week
    .map(
      (d) => `
      <li class="sw-day${d.active ? " on" : ""}${d.isToday ? " today" : ""}" title="${d.day} — ${d.dpp} paper${d.dpp === 1 ? "" : "s"}, ${d.xp} XP">
        <span class="sw-dot" aria-hidden="true"></span>
        <span class="sw-label">${new Date(d.day + "T00:00:00").toLocaleDateString("en-IN", { weekday: "narrow" })}</span>
        <span class="sr-only">${d.isToday ? "today, " : ""}${d.active ? "studied" : "no paper"}</span>
      </li>`
    )
    .join("");

  $("xpRules").innerHTML = [
    ...Object.values(AWARDS).map(
      (a) => `<li><span>${esc(a.label)}</span><b>+${a.points}</b></li>`
    ),
    `<li><span>each correct answer</span><b>+${PAPER_BONUS.perCorrect}</b></li>`,
    `<li><span>a perfect paper</span><b>+${PAPER_BONUS.perfect}</b></li>`,
  ].join("");

  $("milestones").innerHTML = milestones(p.xp)
    .map(
      (m) => `
      <li class="ms${m.done ? " done" : ""}">
        <span class="ms-mark" aria-hidden="true">${m.done ? "✓" : m.percent + "%"}</span>
        <span class="ms-text"><strong>${esc(m.label)}</strong><span class="tiny dim">${esc(m.hint)}</span></span>
      </li>`
    )
    .join("");

  return p;
}

/* ----------------------------------------------------------------- the board */

function rowHtml(row, mine) {
  const isMe = Boolean(mine) && row.uid === mine;
  return `
    <li class="board-row${isMe ? " me" : ""}" ${isMe ? 'aria-current="true"' : ""}>
      <span class="board-rank">${row.rank}</span>
      <span class="board-name">${esc(row.name)}${isMe ? ' <span class="board-you">you</span>' : ""}</span>
      <span class="board-xp">${row.xp.toLocaleString("en-IN")}</span>
      <span class="board-streak">${row.streak ? `🔥 ${row.streak}` : "—"}</span>
    </li>`;
}

async function publishMine(p) {
  if (!me || !session) return null;
  try {
    const res = await fetch("/api/token?route=board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: me,
        name: displayName(session),
        xp: p.xp,
        level: p.level,
        streak: p.streak.current,
      }),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

async function loadBoard({ from = "refresh" } = {}) {
  const list = $("boardList");
  const note = $("boardNote");
  if (from === "boot") note.textContent = "Loading the board…";

  const p = progress();
  // Publishing on the way in is what keeps this browser's row current: the
  // board never has to be told twice about the same total, and a visit after a
  // week of papers updates the row before it is read back.
  const published = await publishMine(p);

  let data = null;
  try {
    const res = await fetch(`/api/token?route=board&me=${encodeURIComponent(me)}&limit=50`);
    data = await res.json();
  } catch {
    data = null;
  }

  if (!data || !data.success) {
    list.innerHTML = `<li class="board-empty">The board could not be reached just now. Your own XP and streak above are yours, and unaffected.</li>`;
    note.textContent = "Offline — showing your own standing only.";
    return;
  }

  const rows = data.rows || [];
  const mine = data.me?.uid || published?.row?.uid || "";
  list.innerHTML = rows.length
    ? rows.map((row) => rowHtml(row, mine)).join("")
    : `<li class="board-empty">No one has marked a paper yet. The first row is unclaimed.</li>`;

  // The honest label: what the board actually is, in the route's own words.
  const players = Number(data.players) || rows.length;
  note.textContent = data.persistent
    ? `${players} student${players === 1 ? "" : "s"} on the board · shared, ordered by XP`
    : `${players} student${players === 1 ? "" : "s"} in this deployment's memory · attach a store to make the board worldwide`;

  // Rank for the caller, when they are outside the visible page.
  const meRow = data.me;
  if (meRow && !rows.some((r) => r.uid === meRow.uid)) {
    list.insertAdjacentHTML(
      "beforeend",
      `<li class="board-gap" aria-hidden="true">…</li>${rowHtml(meRow, mine)}`
    );
  }
}

/* ---------------------------------------------------------------- wiring */

const p = renderMine();
if (!session) {
  // XP is local, so the numbers above are real without an account — but a row
  // needs a name, and a name needs a sign-in.
  $("boardNote").textContent = "Sign in to put your XP on the board.";
  $("boardList").innerHTML = `<li class="board-empty"><a href="/login.html?next=${encodeURIComponent(
    "/leaderboard.html"
  )}">Sign in</a> to join the board. Your ${p.xp.toLocaleString("en-IN")} XP is already saved on this device.</li>`;
} else {
  loadBoard({ from: "boot" });
}

$("boardRefresh").addEventListener("click", async () => {
  await loadBoard();
  toast("Board refreshed");
});

// An award elsewhere in the page (a fresh paper in another tab) updates the
// standing without a reload.
window.addEventListener("progress:change", () => renderMine());
