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

/* --------------------------- maintenance wall ---------------------------- */

/**
 * The visitor's half of the maintenance switch.
 *
 * Pages are static files: when the operator turns the site off, the HTML
 * still exists, so the *wall* is what a visitor meets — a full-screen
 * notice over a page whose APIs have all stopped answering anyway (the
 * server-side gate is the half with teeth). It polls the public status
 * read every minute, and the moment the switch flips back it reloads the
 * page, because the honest way to "come back" is a fresh load, not
 * un-hiding a half-initialised app.
 *
 * The admin panel is exempt by construction: the operator must always be
 * able to reach the switch that turns this off.
 */
const MAINTENANCE_URL = "/api/admin?action=maintenance";
const MAINTENANCE_POLL_MS = 60 * 1000;
let wall = null;
let wallTimer = null;

function isAdminSurface() {
  try {
    return window.location.pathname.replace(/\/+$/, "").endsWith("/admin");
  } catch {
    return false;
  }
}

function raiseWall(message) {
  if (wall) {
    const p = wall.querySelector("[data-wall-message]");
    if (p && message) p.textContent = message;
    return;
  }
  wall = document.createElement("div");
  wall.className = "maintenance-wall";
  wall.setAttribute("role", "alertdialog");
  wall.setAttribute("aria-label", "Site under maintenance");
  wall.innerHTML =
    `<div class="maintenance-card">` +
    `<div class="maintenance-badge" aria-hidden="true">🛠️</div>` +
    `<h1>Site is under maintenance</h1>` +
    `<p data-wall-message></p>` +
    `<p class="maintenance-note">This page checks automatically — it will come back on its own when the work is done.</p>` +
    `</div>`;
  wall.querySelector("[data-wall-message]").textContent =
    message || "We're doing a bit of maintenance right now. Please check again in a few minutes.";
  document.body.appendChild(wall);
  document.body.classList.add("maintenance-on");
  // Stop the page behind the wall from being scrolled or tabbed into.
  document.body.style.overflow = "hidden";
}

function lowerWall() {
  if (!wall) return;
  wall.remove();
  wall = null;
  document.body.classList.remove("maintenance-on");
  document.body.style.overflow = "";
  window.location.reload();
}

async function checkMaintenance() {
  try {
    const res = await fetch(MAINTENANCE_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const m = data && data.maintenance;
    if (m && m.on) raiseWall(m.message);
    else if (wall) lowerWall();
  } catch {
    /* the wall is a courtesy layer; a failed check changes nothing */
  }
}

function watchMaintenance() {
  if (isAdminSurface()) return;
  checkMaintenance();
  if (wallTimer) return;
  wallTimer = window.setInterval(checkMaintenance, MAINTENANCE_POLL_MS);
}

/* -------------------------------- booting -------------------------------- */

export async function boot({ update = true } = {}) {
  paintPip();
  watchMaintenance();
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
