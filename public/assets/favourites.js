/* =========================================================================
   ArsVibe — favourites
   -------------------------------------------------------------------------
   A batch the reader wants to come back to. Kept on this device, no account
   needed, and migrated from the previous brand key so nobody loses a list to
   a rename.

   The store is deliberately tiny and synchronous: every card on the page
   asks `isFavourite(id)` while it renders, so this must never await anything.
   ========================================================================= */

const CURRENT = "arsvibe.favourites";
const LEGACY = "eduvibe.favourites";

/** [{ id, name, image, language, byName, feeTotal, at }] */
function read() {
  try {
    if (localStorage.getItem(CURRENT) === null) {
      const old = localStorage.getItem(LEGACY);
      if (old !== null) localStorage.setItem(CURRENT, old);
    }
    const list = JSON.parse(localStorage.getItem(CURRENT) || "[]");
    return Array.isArray(list) ? list.filter((b) => b && b.id) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(CURRENT, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* private mode: the heart still works for this page view */
  }
  // Any view already on screen should agree with the store immediately.
  document.dispatchEvent(new CustomEvent("favourites:change", { detail: { list } }));
}

export function listFavourites() {
  return read();
}

export function favouriteCount() {
  return read().length;
}

export function isFavourite(id) {
  if (!id) return false;
  return read().some((b) => b.id === id);
}

/**
 * Add or remove. Only the fields a card needs are stored: a favourite is a
 * bookmark, not a copy of the catalogue record.
 */
export function toggleFavourite(batch) {
  if (!batch || !batch.id) return false;
  const list = read();
  const exists = list.some((b) => b.id === batch.id);
  if (exists) {
    write(list.filter((b) => b.id !== batch.id));
    return false;
  }
  write([
    {
      id: String(batch.id),
      name: batch.name || "Untitled batch",
      image: batch.image || "",
      language: batch.language || "",
      byName: batch.byName || "",
      feeTotal: batch.feeTotal ?? null,
      at: Date.now(),
    },
    ...list,
  ]);
  return true;
}

export function clearFavourites() {
  write([]);
}

/**
 * The heart itself.
 *
 * Rendered inside batch cards, which are anchors: the button is what gets
 * clicked, so it stops the navigation it would otherwise trigger.
 */
export function heartButton(batch = {}) {
  const id = batch.id || "";
  const name = batch.name || "";
  const on = isFavourite(id);
  // The card's identity rides on the button so the delegated handler can save
  // a favourite without a second catalogue fetch.
  return `
    <button class="fav-btn${on ? " on" : ""}" type="button"
      data-fav="${escapeAttr(id)}"
      data-fav-name="${escapeAttr(name)}"
      data-fav-image="${escapeAttr(batch.image || "")}"
      data-fav-language="${escapeAttr(batch.language || "")}"
      data-fav-by="${escapeAttr(batch.byName || "")}"
      data-fav-fee="${batch.feeTotal == null ? "" : escapeAttr(batch.feeTotal)}"
      aria-pressed="${on}"
      aria-label="${on ? "Remove" : "Add"} ${escapeAttr(name || "this batch")} ${on ? "from" : "to"} favourites"
      title="${on ? "Remove from favourites" : "Add to favourites"}">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path d="M12 20.3 4.9 13.4a4.2 4.2 0 0 1 0-6 4.3 4.3 0 0 1 6 0l1.1 1.1 1.1-1.1a4.3 4.3 0 0 1 6 0 4.2 4.2 0 0 1 0 6Z" />
      </svg>
    </button>`;
}

function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * One delegated click handler for every heart on the page.
 *
 * Delegation matters here: the catalogue re-renders its grids on filter and
 * pagination, so per-card listeners would be re-bound (and leaked) on every
 * paint. The handler repaints just the heart it owns.
 */
export function wireFavourites({ onChange } = {}) {
  if (window.__favWired) {
    if (onChange) window.__favListeners.push(onChange);
    return;
  }
  window.__favWired = true;
  window.__favListeners = onChange ? [onChange] : [];

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fav]");
    if (!btn) return;
    // The heart lives inside a link to the batch: never follow it.
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.fav;
    const now = toggleFavourite({
      id,
      name: btn.dataset.favName || "",
      image: btn.dataset.favImage || "",
      language: btn.dataset.favLanguage || "",
      byName: btn.dataset.favBy || "",
      feeTotal: btn.dataset.favFee ? Number(btn.dataset.favFee) : null,
    });
    btn.classList.toggle("on", now);
    btn.setAttribute("aria-pressed", String(now));
    btn.setAttribute("aria-label", `${now ? "Remove from" : "Add to"} favourites`);
    btn.setAttribute("title", now ? "Remove from favourites" : "Add to favourites");
    if (now) {
      btn.classList.remove("pop");
      // restart the animation on a re-add
      void btn.offsetWidth;
      btn.classList.add("pop");
    }
    for (const fn of window.__favListeners) {
      try {
        fn(now);
      } catch {
        /* a listener must never break the toggle */
      }
    }
  });

  // Keep the count in the sidebar honest when another tab changes the list.
  window.addEventListener("storage", (e) => {
    if (e.key !== CURRENT) return;
    document.dispatchEvent(new CustomEvent("favourites:change", { detail: { list: read() } }));
  });
}
