/* =========================================================================
   Service-worker registration, shared by every page.

   Kept deliberately tiny and defensive: registering a worker is an enhancement,
   and a site that breaks because a worker would not register is a worse site
   than one with no worker at all. Nothing here is awaited by page code.
   ========================================================================= */

const SW_URL = "/sw.js";
const BUILD = "v1";

/**
 * Register, and surface a pending update instead of silently serving a stale
 * page until every tab is closed.
 */
export async function registerWorker({ onUpdate } = {}) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  // A worker only makes sense over https (or localhost). On any other origin the
  // registration would throw, so it is skipped rather than caught and hidden.
  const secure = location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!secure) return null;

  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });

    const offer = (worker) => {
      if (typeof onUpdate === "function") onUpdate(worker);
    };

    // A worker that was already waiting when this page loaded (the person
    // opened the site in a second tab mid-deploy).
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // `controller` is null on the very first install: there is nobody to
        // update, so asking the page to reload would be noise.
        if (installing.state === "installed" && navigator.serviceWorker.controller) offer(installing);
      });
    });

    return reg;
  } catch {
    return null;
  }
}

/** Ask the waiting worker to take over, then reload into the new build. */
export function applyUpdate(worker) {
  if (!worker) return;
  worker.postMessage({ type: "skip-waiting" });
  // A reload is what actually swaps the shell a person is looking at.
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", once, { once: true });
  // If `controllerchange` never fires (an older browser), do not hang: reload
  // anyway. The new worker is installed and will control the next load.
  setTimeout(once, 1200);
}

/** Ask the worker to keep a file for offline use, before it is needed. */
export function cacheForOffline(url) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return false;
  sw.postMessage({ type: "cache-url", url: String(url) });
  return true;
}

/** True when a worker is registered and controlling this page. */
export function offlineReady() {
  return Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
}

export const serviceWorkerVersion = BUILD;
