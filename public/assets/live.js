/* =========================================================================
   Live classes — today's schedule across batches, kept fresh.
   -------------------------------------------------------------------------
   The per-batch today engine already exists server-side
   (GET /api/batch?today=1): this page is its front door. Sources are the
   batches the student actually studies (library + recents) or, on the
   other tab, the catalogue's front page. Classes render as Live /
   Starting soon / Earlier with a ticking countdown, and the whole board
   re-reads itself every minute — live is a moving target.
   ========================================================================= */

import { mountChrome, esc, recentBatches } from "./app.js";
import { getLibrary } from "./library.js";
import { loadCatalog } from "./data.js";

mountChrome("live");

const grids = {
  live: document.getElementById("liveNow"),
  soon: document.getElementById("liveSoon"),
  done: document.getElementById("liveDone"),
};
const stamp = document.getElementById("liveStamp");
const countEl = document.getElementById("liveCount");
let scope = "mine";
let classes = [];

const watchUrl = (c) =>
  `/watch.html?batch=${encodeURIComponent(c.batch)}&subject=${encodeURIComponent(c.subjectSlug)}&id=${encodeURIComponent(c.id)}&title=${encodeURIComponent(c.title)}`;

function countdown(c) {
  const start = Date.parse(c.start || "");
  if (!start) return "";
  const ms = start - Date.now();
  if (ms <= 0) return "";
  const m = Math.floor(ms / 60000);
  if (m >= 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  if (m >= 1) return `in ${m}m`;
  return "starting now";
}

function card(c) {
  const live = c.status === "live";
  const badge = c.cancelled
    ? `<span class="pill">Cancelled</span>`
    : live
      ? `<span class="pill live-pill"><span class="live-dot"></span> LIVE</span>`
      : c.status === "upcoming"
        ? `<span class="pill pill-brand">${countdown(c) || c.startClock}</span>`
        : `<span class="pill">Ended ${c.endClock || ""}</span>`;
  const cta = c.cancelled
    ? ""
    : live || c.hasStream
      ? `<a class="btn ${live ? "btn-primary" : "btn-ghost"} btn-sm" href="${watchUrl(c)}">${live ? "▶ Join live" : "Watch recording"}</a>`
      : `<span class="tiny dim">Stream appears when the class starts</span>`;
  return `
    <article class="card live-card">
      <div class="row between">
        ${badge}
        <span class="tiny dim">${esc(c.startClock || "")}${c.endClock ? ` – ${esc(c.endClock)}` : ""} IST</span>
      </div>
      <h3 class="live-title">${esc(c.title)}</h3>
      <p class="tiny muted">${esc(c.subject || "")}${c.teacher ? ` · ${esc(c.teacher)}` : ""}</p>
      <p class="tiny dim">${esc(c.batchName || "")}${c.chapter ? ` · ${esc(c.chapter)}` : ""}</p>
      <div class="live-cta">${cta}</div>
    </article>`;
}

function render() {
  const by = (st) => classes.filter((c) => c.status === st && !c.cancelled);
  const cancelled = classes.filter((c) => c.cancelled);
  const live = by("live"), soon = by("upcoming"), done = [...by("done"), ...cancelled];
  countEl.textContent = String(live.length);
  grids.live.innerHTML = live.length ? live.map(card).join("") : `<p class="tiny dim live-empty">Nothing is live this minute — the next class is below.</p>`;
  grids.soon.innerHTML = soon.length ? soon.map(card).join("") : `<p class="tiny dim live-empty">No more classes scheduled today for this selection.</p>`;
  grids.done.innerHTML = done.length ? done.map(card).join("") : `<p class="tiny dim live-empty">Nothing earlier today.</p>`;
}

async function batchIds() {
  if (scope === "popular") {
    try {
      const page = await loadCatalog(1);
      return (page?.batches || []).slice(0, 6).map((b) => ({ id: b.id, name: b.name }));
    } catch {
      return [];
    }
  }
  const seen = new Map();
  for (const b of [...(getLibrary().batches || []), ...recentBatches()]) {
    if (b?.id && !seen.has(b.id)) seen.set(b.id, { id: b.id, name: b.name || "" });
  }
  return [...seen.values()].slice(0, 8);
}

async function load() {
  const batches = await batchIds();
  if (!batches.length) {
    classes = [];
    render();
    stamp.textContent = scope === "mine"
      ? "Open a batch or two and your classes will gather here."
      : "The catalogue could not be read just now.";
    return;
  }
  const results = await Promise.allSettled(
    batches.map(async (b) => {
      const res = await fetch(`/api/batch?today=1&id=${encodeURIComponent(b.id)}`);
      const data = await res.json().catch(() => null);
      const rows = Array.isArray(data?.today?.classes) ? data.today.classes : Array.isArray(data?.classes) ? data.classes : [];
      return rows.map((c) => ({ ...c, batch: b.id, batchName: b.name || data?.name || "" }));
    })
  );
  classes = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  render();
  stamp.textContent = `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · ${batches.length} batch${batches.length === 1 ? "" : "es"}`;
}

document.querySelectorAll(".live-scope").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".live-scope").forEach((b) => b.classList.toggle("active", b === btn));
    scope = btn.dataset.scope;
    load();
  })
);

load();
setInterval(() => { if (!document.hidden) load(); }, 60000);
// Countdowns tick locally; statuses flip on the minute refresh above.
setInterval(render, 30000);
