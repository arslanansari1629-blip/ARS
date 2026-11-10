/* =========================================================================
   Offline boot: registration, an update prompt, and a connection pip.

   This is the one module every page loads last. It owns three small things and
   nothing else, because a page that already works should never wait on it:

     · registers the service worker (so notes and PDFs survive a lost signal),
     · offers a reload when a new build is waiting (rather than letting a
       deploy sit invisible behind a cached shell),
     · shows a quiet "offline" pip when the connection drops, and hides it
       again when the connection returns.
   ========================================================================= */

import { registerWorker, applyUpdate } from "./sw-register.js";

const UPDATE_DISMISSED = "swUpdateDismissed";

/* ------------------------------- the pip --------------------------------- */

let pip = null;

function makePip() {
  if (pip) return pip;
  pip = document.createElement("div");
  pip.className = "net-pip";
  pip.setAttribute("role", "status");
  pip.setAttribute("aria-live", "polite");
  pip.hidden = true;
  document.body.appendChild(pip);
  return pip;
}

function paintPip() {
  const offline = navigator.onLine === false;
  const el = makePip();
  el.hidden = !offline;
  el.dataset.state = offline ? "offline" : "online";
  el.textContent = offline ? "Offline — saved lectures still play" : "";
}

/* ---------------------------- the update row ----------------------------- */

let updateRow = null;

function offerUpdate(worker) {
  // Do not nag: a dismissal is remembered for the session, not forever, so the
  // next deploy still gets a chance to say so.
  try {
    if (sessionStorage.getItem(UPDATE_DISMISSED) === "1") return;
  } catch {
    /* storage blocked: showing the row is still correct */
  }
  if (updateRow) return;

  updateRow = document.createElement("div");
  updateRow.className = "update-row";
  updateRow.setAttribute("role", "status");
  updateRow.innerHTML =
    `<span class="update-dot" aria-hidden="true"></span>` +
    `<span class="grow">A newer version of ArsVibe is ready.</span>` +
    `<button class="btn btn-primary btn-sm" type="button" data-act="reload">Refresh</button>` +
    `<button class="btn btn-ghost btn-sm" type="button" data-act="later">Later</button>`;
  document.body.appendChild(updateRow);

  updateRow.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "reload") {
      act.textContent = "Refreshing…";
      act.disabled = true;
      applyUpdate(worker);
      return;
    }
    try {
      sessionStorage.setItem(UPDATE_DISMISSED, "1");
    } catch {
      /* nothing to remember with */
    }
    updateRow.remove();
    updateRow = null;
  });
}

/* -------------------------------- booting -------------------------------- */

export async function boot({ update = true } = {}) {
  paintPip();
  // Qualified on purpose: a bare `addEventListener` resolves against the global
  // object, which does not carry it in every embedding (test harnesses, SSR
  // shims, some in-app webviews). `window` is the thing that owns the event.
  window.addEventListener("online", paintPip);
  window.addEventListener("offline", paintPip);

  if (!update) return null;
  const reg = await registerWorker({ onUpdate: offerUpdate });
  return reg;
}

/** Pages that already imported this module but want the boot on their terms. */
if (typeof document !== "undefined" && document.readyState !== "loading") {
  boot().catch(() => {});
} else if (typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => boot().catch(() => {}), { once: true });
}
