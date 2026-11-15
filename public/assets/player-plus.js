/* =========================================================================
   Player Plus — theatre mode, ambient glow, and note markers.
   -------------------------------------------------------------------------
   A companion to the player, like watch-notes.js: it borrows the <video>
   clock and the scrubber's geometry and owns nothing else. If this module
   fails, the lecture plays exactly as before.
   ========================================================================= */

const video = document.getElementById("video");
const wrap = document.getElementById("playerRoot");
const track = document.querySelector(".scrubber-track");
const lectureId = new URLSearchParams(location.search).get("id") || "";

/* ---- ambient glow: the screen lights the room a little ---- */
if (wrap) wrap.classList.add("has-ambient");

/* ---- theatre mode: the lecture takes the whole width ---- */
const actions = document.querySelector(".now-actions");
if (actions && !document.getElementById("theatreBtn")) {
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost btn-sm";
  btn.id = "theatreBtn";
  btn.type = "button";
  btn.textContent = "Theatre";
  btn.title = "Widen the player (t)";
  actions.appendChild(btn);
  const toggle = () => {
    const on = document.body.classList.toggle("theatre");
    btn.textContent = on ? "Exit theatre" : "Theatre";
    try { localStorage.setItem("arsvibe.theatre", on ? "1" : ""); } catch { /* ignore */ }
  };
  btn.addEventListener("click", toggle);
  try {
    if (localStorage.getItem("arsvibe.theatre") === "1") toggle();
  } catch { /* ignore */ }
  window.addEventListener("keydown", (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "");
    if (!typing && e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) toggle();
  });
}

/* ---- note markers: your notes, drawn on the scrubber ---- */
function paintMarkers() {
  if (!track || !video || !lectureId) return;
  const duration = Number(video.duration) || 0;
  track.querySelectorAll(".note-marker").forEach((m) => m.remove());
  if (!duration) return;
  let rows = [];
  try {
    rows = JSON.parse(localStorage.getItem(`notes:${lectureId}`) || "[]");
  } catch {
    return;
  }
  for (const n of Array.isArray(rows) ? rows : []) {
    if (!Number.isFinite(n?.t)) continue;
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "note-marker";
    dot.style.left = `${Math.min(100, (n.t / duration) * 100)}%`;
    dot.title = n.text ? `${Math.floor(n.t / 60)}:${String(Math.floor(n.t % 60)).padStart(2, "0")} — ${n.text}` : "Bookmark";
    dot.setAttribute("aria-label", dot.title);
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      video.currentTime = n.t;
      video.play?.().catch(() => {});
    });
    track.appendChild(dot);
  }
}
if (video && track) {
  video.addEventListener("loadedmetadata", paintMarkers);
  window.addEventListener("storage", (e) => {
    if (e.key === `notes:${lectureId}`) paintMarkers();
  });
  // Notes are written by a sibling module in the same tab (no storage event
  // fires for same-tab writes), so repaint on a gentle cadence while paused
  // or playing — three DOM nodes, not a render loop.
  setInterval(paintMarkers, 4000);
  paintMarkers();
}
