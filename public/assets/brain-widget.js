/**
 * The Site Brain's face — the little overseer that rides on every page.
 *
 * The watching itself is server-side (scanner, healer, bot watchdog,
 * five-minute heartbeat); this module is only the face: a mood, a
 * hello, and the numbers, polled from the public brain endpoint. It
 * lives in its own module so every page family can carry it — the
 * shell pages import it, the standalone pages (admin, login, open)
 * load it as a script — and so the face can be upgraded without
 * touching the shell.
 *
 * It sits above the back-to-top button, wears a "Brain" label (a pink
 * circle alone was too easy to miss), blinks, and introduces itself
 * once per session so a first-time visitor learns it is there.
 */

function mountBrain() {
  if (!document.body || document.getElementById("brainWidget")) return;
  const el = document.createElement("div");
  el.id = "brainWidget";
  el.className = "brain-widget mood-happy";
  el.innerHTML = `
    <div class="brain-bubble" hidden>
      <strong>🧠 Site Brain</strong>
      <p class="brain-line">Main poori site par nazar rakhe hoon…</p>
      <div class="brain-rows">
        <span>📄 Pages par nazar<b class="brain-r-pages">—</b></span>
        <span>🤖 Bots live<b class="brain-r-bots">—</b></span>
        <span>🛠️ Kul fixes<b class="brain-r-fixes">—</b></span>
        <span>⚠️ Khule errors<b class="brain-r-open">—</b></span>
        <span>🕐 Last check<b class="brain-r-check">—</b></span>
      </div>
      <span class="brain-meta tiny dim"></span>
    </div>
    <button class="brain-face" type="button" aria-label="Site Brain — site ki health">
      <svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
        <path d="M32 6a14 14 0 0 1 13 8 12 12 0 0 1 4 12 13 13 0 0 1-6 15 14 14 0 0 1-22 0 13 13 0 0 1-6-15 12 12 0 0 1 4-12A14 14 0 0 1 32 6z" fill="#ffd9e8" stroke="#ec4899" stroke-width="2.5"/>
        <path d="M22 22c3-3 7-3 10 0M32 22c3-3 7-3 10 0M24 36c2 2 5 2 8 0M34 44c3 1 6 0 8-2" stroke="#ec4899" stroke-width="2" fill="none" stroke-linecap="round"/>
        <circle class="brain-eye" cx="24" cy="30" r="2.6" fill="#7c2d12"/>
        <circle class="brain-eye" cx="40" cy="30" r="2.6" fill="#7c2d12"/>
        <path class="brain-mouth" d="M27 41q5 4 10 0" stroke="#7c2d12" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        <circle cx="18" cy="38" r="3" fill="#f9a8d4" opacity=".65"/>
        <circle cx="46" cy="38" r="3" fill="#f9a8d4" opacity=".65"/>
      </svg>
      <span class="brain-zzz" hidden>💤</span>
      <span class="brain-dot" aria-hidden="true"></span>
    </button>
    <span class="brain-tag">Brain</span>`;
  document.body.appendChild(el);

  const bubble = el.querySelector(".brain-bubble");
  const line = el.querySelector(".brain-line");
  const set = (cls, v) => { const n = el.querySelector(cls); if (n) n.textContent = v; };
  el.querySelector(".brain-face").addEventListener("click", () => {
    bubble.hidden = !bubble.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!el.contains(e.target)) bubble.hidden = true;
  });

  // Introduce itself once per session: a face nobody notices watches
  // nothing. Four seconds, then it folds away on its own.
  try {
    if (!sessionStorage.getItem("arsvibe.brain.met")) {
      sessionStorage.setItem("arsvibe.brain.met", "1");
      setTimeout(() => { bubble.hidden = false; }, 1200);
      setTimeout(() => { bubble.hidden = true; }, 6000);
    }
  } catch { /* private mode: no introduction, still on duty */ }

  const paint = (d) => {
    if (!d || !d.mood) return;
    el.className = `brain-widget mood-${d.mood}`;
    line.textContent = d.line || "";
    set(".brain-r-pages", String(d.pages ?? "—"));
    set(".brain-r-bots", d.bots ? `${d.bots.live}/${d.bots.total}` : "—");
    set(".brain-r-fixes", String(d.fixed ?? "—"));
    set(".brain-r-open", String(d.openErrors ?? "—"));
    set(".brain-r-health", d.health ? `${d.health.score}/100 · ${d.health.grade}` : "—");
    set(".brain-r-check", d.lastTick ? String(d.lastTick).slice(11, 16) : "—");
    set(".brain-meta", d.automation ? "Automation on — error aate hi khud fix karta hoon." : "Automation off hai — admin se on karo.");
    el.querySelector(".brain-zzz").hidden = d.mood !== "sleeping";
  };
  const tick = async () => {
    try {
      const res = await fetch("/api/token?route=brain");
      paint(await res.json());
    } catch { /* offline: the brain keeps its last mood */ }
  };
  tick();
  const brainPoll = setInterval(() => { if (!document.hidden) tick(); }, 90000);
  brainPoll?.unref?.();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBrain);
  } else {
    mountBrain();
  }
}
