/* Home landing (NextHope-style): the page is complete without this
   module — cards are anchors, counts have printed fallbacks, the
   tickers are CSS. Everything here is garnish: live counts from the
   real catalogues and the All / Live chip filter. Any failure is
   silent by design; the printed numbers stay honest enough. */

const $ = (s) => document.querySelector(s);
const fmtK = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k+` : String(n);

/* ---- chip filter ---- */
(() => {
  const grid = $("#platformsGrid");
  if (!grid) return;
  const chips = [...document.querySelectorAll("[data-pfilter]")];
  const cards = [...grid.querySelectorAll(".platform-card")];
  const countEl = $("#platformCount");
  const paintCount = () => {
    const n = cards.filter((c) => !c.classList.contains("hide")).length;
    if (countEl) countEl.textContent = String(n);
  };
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.classList.toggle("on", c === chip));
      const f = chip.dataset.pfilter;
      cards.forEach((card) => {
        card.classList.toggle("hide", f !== "all" && card.dataset.status !== f);
      });
      paintCount();
    });
  });
})();

/* ---- live counts ---- */
(() => {
  const get = (url) =>
    fetch(url, { headers: { Accept: "application/json" } }).then((r) => r.json()).catch(() => null);
  get("/api/batches?facets=1").then((d) => {
    const total = d?.prices?.total || d?.total || 0;
    if (!(total > 0)) return;
    const card = $("#platformPwCount");
    if (card) card.textContent = fmtK(total);
    const stat = $("#nhStatPw");
    if (stat) stat.textContent = total.toLocaleString("en-IN");
    const proof = $("#nhLiveCount");
    if (proof) proof.textContent = total.toLocaleString("en-IN");
  });
  get("/api/allen?view=batches").then((d) => {
    const total = d?.total || (Array.isArray(d?.items) ? d.items.length : 0);
    if (!(total > 0)) return;
    const card = $("#platformAllenCount");
    if (card) card.textContent = String(total);
    const stat = $("#nhStatAllen");
    if (stat) stat.textContent = String(total);
  });
})();
