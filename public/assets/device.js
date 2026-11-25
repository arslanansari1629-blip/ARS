/**
 * Device Auto-Fit — the site measures the screen it is actually on and
 * fits itself to it, instead of guessing from a user-agent string.
 *
 * One classification drives everything: `phone`, `tablet`, `laptop` or
 * `desktop`, written to `<html data-device>` (with `data-orientation`
 * and `data-touch` beside it). CSS keys its layout off those attributes,
 * so the same page is a one-column, thumb-reach layout on a phone and a
 * wide multi-column layout on a laptop — and when the screen changes
 * (rotation, window drag, fold), the classification is recomputed and
 * the layout follows. Nothing is reloaded; the attributes move and the
 * styles are already there.
 *
 * `--app-height` is the visible viewport height in pixels, kept current
 * through rotation and mobile URL-bar show/hide, so anything sized to
 * "the screen" means *this* screen, not the one in a `100vh` guess.
 */

/** The form factor for a screen of this size and pointer. Pure: tested. */
export function classifyDevice({ width = 1280, height = 800, coarse = false } = {}) {
  const short = Math.min(width, height);
  if (width < 640 || (coarse && short < 500)) return "phone";
  if (width < 1100) return "tablet";
  if (width < 1650) return "laptop";
  return "desktop";
}

function coarsePointer() {
  try {
    return Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  } catch {
    return false;
  }
}

function current() {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 800;
  const coarse = coarsePointer();
  return {
    device: classifyDevice({ width: w, height: h, coarse }),
    orientation: w >= h ? "landscape" : "portrait",
    touch: coarse ? "coarse" : "fine",
    height: Math.round(window.visualViewport?.height || h),
  };
}

function apply() {
  const root = document.documentElement;
  const now = current();
  const changed = root.dataset.device !== now.device;
  root.dataset.device = now.device;
  root.dataset.orientation = now.orientation;
  root.dataset.touch = now.touch;
  root.style.setProperty("--app-height", `${now.height}px`);
  if (changed) {
    try {
      window.dispatchEvent(new CustomEvent("arsvibe:device", { detail: now }));
    } catch { /* an odd embedding without events: the attributes still moved */ }
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  apply();
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  };
  window.addEventListener("resize", queue, { passive: true });
  window.addEventListener("orientationchange", queue, { passive: true });
  window.visualViewport?.addEventListener("resize", queue, { passive: true });
}
