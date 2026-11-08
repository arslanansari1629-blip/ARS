/* Favourites page — the batches that were hearted, and nothing else */

import { mountChrome, esc, money, emptyState, toast } from "./app.js";
import { getLibrary } from "./library.js";
import {
  listFavourites,
  favouriteCount,
  clearFavourites,
  heartButton,
  wireFavourites,
} from "./favourites.js";

mountChrome("favourites");

const body = document.getElementById("body");
const clearBtn = document.getElementById("clearFavBtn");

function card(b) {
  const thumb = b.image
    ? `<img src="${esc(b.image)}" alt="" loading="lazy" onerror="this.remove()" />`
    : `<span class="placeholder">${esc((b.name || "PW").slice(0, 2).toUpperCase())}</span>`;
  return `
    <a class="batch-card fade-up" href="/batch.html?id=${encodeURIComponent(b.id)}">
      <div class="batch-thumb">
        ${thumb}
        ${b.feeTotal ? "" : `<span class="free">Free</span>`}
        ${heartButton(b)}
      </div>
      <div class="batch-body">
        <div class="batch-title">${esc(b.name)}</div>
        <div class="batch-sub">${esc(b.byName || "Physics Wallah batch")}</div>
        <div class="batch-meta">
          ${b.language ? `<span class="pill">${esc(b.language)}</span>` : ""}
          <span class="pill pill-brand">${esc(money(b.feeTotal))}</span>
        </div>
      </div>
    </a>`;
}

function render() {
  const list = listFavourites();
  clearBtn.hidden = list.length === 0;

  if (!list.length) {
    body.innerHTML = emptyState(
      "No favourites yet",
      "Look for the heart on any batch card — on the home page, the catalogue, or your library — and it will be kept here.",
      `<a class="btn btn-primary btn-sm" href="/batches.html">Browse batches</a>`
    );
    return;
  }

  body.innerHTML = `
    <p class="tiny muted mb-3">${list.length} batch${list.length === 1 ? "" : "es"} · newest first</p>
    <div class="grid grid-batches">${list.map(card).join("")}</div>`;
}

clearBtn?.addEventListener("click", () => {
  clearFavourites();
  toast("Favourites cleared");
  render();
});

// The hearts on this page are self-updating, so re-render after a toggle so a
// removed batch actually leaves the list.
wireFavourites({ onChange: () => render() });
document.addEventListener("favourites:change", () => {
  if (document.querySelector(".fav-btn")) render();
});

render();

// A shelf of recently opened batches keeps the page useful when it is empty.
const recent = getLibrary().batches.slice(0, 4);
if (!favouriteCount() && recent.length) {
  body.insertAdjacentHTML(
    "beforeend",
    `<h2 class="h-sm mt-6">Recently opened</h2>
     <div class="grid grid-batches mt-3">${recent.map(card).join("")}</div>`
  );
}
