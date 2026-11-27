/* /vidyakul — the frame around the mirrored Vidyakul app.
   Garnish only: pass a shared batch link through (?batch=…), offer
   refresh and fullscreen. The platform itself needs no JS here. */
const frame = document.getElementById("vkFrame");
const note = document.getElementById("vkNote");
const stage = document.getElementById("vkStage");

const shared = new URLSearchParams(location.search).get("batch");
if (frame && shared) {
  frame.src = `/vidyakul-app/?batch=${encodeURIComponent(shared)}`;
}
frame?.addEventListener("load", () => {
  if (note) note.textContent = "Vidyakul platform taiyaar hai — batch chunno aur Let's Study dabao.";
});
document.getElementById("vkReload")?.addEventListener("click", () => {
  if (!frame) return;
  if (note) note.textContent = "Platform refresh ho raha hai…";
  frame.src = frame.src;
});
document.getElementById("vkFull")?.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage?.requestFullscreen?.().catch(() => {});
});
