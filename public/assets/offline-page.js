/* Offline fallback — retry, and recover on its own when the network returns */

const retry = document.getElementById("retry");
const back = () => {
  // A reload is the honest action here: the browser decides whether the
  // network came back, not this page.
  location.reload();
};
retry?.addEventListener("click", back);

// Come back on our own when the connection returns, so the person is not
// left staring at a page that started working a minute ago.
addEventListener("online", () => {
  retry.textContent = "Back online — reloading…";
  setTimeout(back, 600);
});

// Say whether the browser believes it has a connection. `navigator.onLine` is
// not proof of reachability — a captive portal reports "online" — so it is
// stated as a hint and never as the reason the page could not load.
const wrap = document.querySelector(".off-wrap");
const paint = () => {
  if (!wrap) return;
  const online = navigator.onLine !== false;
  wrap.dataset.hint = online ? "online" : "no-network";
  if (online) {
    retry.textContent = "Try again";
  }
};
paint();
addEventListener("online", paint);
addEventListener("offline", paint);
