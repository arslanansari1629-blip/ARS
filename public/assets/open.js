/* =========================================================================
   ArsVibe — the opening sheet
   -------------------------------------------------------------------------
   A title sequence, not a loading screen. Four beats:

     1  the plate traces itself onto the paper
     2  the wordmark is letterspaced in
     3  the catalogue draws itself, one row at a time, with live counts
     4  the title block is stamped in, the sweep crosses, the sheet lifts

   It has two mountings, and one implementation:

     · /open  — the sheet is the page. It plays, then hands over to the
                catalogue with a real navigation.
     · /      — the same sheet is fetched from /open and laid over the front
                door once per session, then lifted to show the catalogue
                underneath. No navigation, no lost scroll position.

   Design rules that decide the code below:

   · The animation never owns the content. Hidden states live behind
     `.open-js`, which this module adds, so the sheet is a finished drawing
     with JavaScript off and again the moment the sequence ends. The home page
     arms a 5s failsafe that removes every trace of the intro if this module
     never arrives.
   · The exit is idempotent and exists in four forms — a link, Esc, a click,
     and the end of the sequence — so a throttled timer in a background tab
     can never strand anyone.
   · Reduced motion is not a degraded sheet: it is the drawing, finished and
     still, with the way out in focus.
   ========================================================================= */

const sheet = document.getElementById("openSheet");
const isStandalone = !!sheet;

const reduceMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const NOW = () => performance.now();

/** How long the sequence runs before the sheet lifts, in ms.
 *
 * The beats themselves are CSS delays measured from the moment the sheet is in
 * the page (see "The opening sheet" at the end of arsvibe.css), so the two
 * cannot drift apart. This timer is only how long the finished drawing is left
 * on screen before it lifts.
 */
const DURATION = 3800;


/** Session flag: the front door has opened once already. */
const PLAYED = "arsvibe.open.played";

function storage(kind) {
  try {
    return kind === "session" ? sessionStorage : localStorage;
  } catch {
    return null;
  }
}

const session = storage("session");
const seen = () => {
  try {
    return session?.getItem(PLAYED) === "1";
  } catch {
    return true; // a storage-less browser gets the site, not the intro
  }
};
const markSeen = () => {
  try {
    session?.setItem(PLAYED, "1");
  } catch {
    /* private mode: the intro simply plays again next time */
  }
};

const params = new URLSearchParams(location.search);
const forced = params.has("open");

/* -------------------------------------------------------------------------
   The sheet's own behaviour
   ---------------------------------------------------------------------- */

/**
 * @param {HTMLElement} el        the sheet element
 * @param {() => void} leave      what "the sequence has finished" means here
 */
function runSheet(el, leave) {
  const doc = document.documentElement;
  const statusEl = el.querySelector("#openStatus");
  const progress = el.querySelector("#openProgress");
  const go = el.querySelector("#openGo");

  let gone = false;
  let raf = 0;

  /* Frame scheduling is written against whatever exists. The sheet is only a
     page; a page that throws because it was rendered somewhere without
     requestAnimationFrame is worse than a page that draws no progress rule. */
  const frameFn = typeof requestAnimationFrame === "function" ? "requestAnimationFrame" : "setTimeout";
  const frame = (fn) => (frameFn === "setTimeout" ? setTimeout(fn, 16) : requestAnimationFrame(fn));
  const unframe = (id) => {
    if (frameFn === "setTimeout") clearTimeout(id);
    else if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  };

  const exit = () => {
    if (gone) return;
    gone = true;
    unframe(raf);
    doc.classList.add("open-done");
    leave();
  };

  doc.classList.add("open-js");

  /* The count, read live.
     The catalogue index ships with the site (14,201 batches), so /api/batches
     answers from memory: one small request, not a crawl. If it fails, the
     number already printed on the sheet stands — the sequence is not worth
     blocking on, and a wrong number would be worse than a stale one. */
  const countUp = async () => {
    const target = el.querySelector("#otBatches");
    if (!target) return;
    let total = 0;
    try {
      const res = await fetch("/api/batches?page=1&limit=1");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      total = Number(data.total) || Number(data.totalBatches) || Number(data.count) || 0;
    } catch {
      /* the shipped floor stands */
    }
    for (const skel of el.querySelectorAll(".ot-skel")) skel.remove();
    if (!(total > 0)) return;

    const from = 0;
    const run = 620;
    const t0 = NOW();
    const step = () => {
      const pct = Math.min(1, (NOW() - t0) / run);
      // ease-out: the figures settle rather than stopping dead
      const eased = 1 - Math.pow(1 - pct, 3);
      target.textContent = Math.round(from + (total - from) * eased).toLocaleString("en-IN");
      if (pct < 1 && !gone) raf = frame(step);
    };
    raf = frame(step);
  };

  /* The clock: a progress rule and the line naming the beat it is on. */

  const watch = () => {
    const t0 = NOW();
    const tick = () => {
      const pct = Math.min(1, (NOW() - t0) / DURATION);
      if (progress) progress.style.transform = `scaleX(${pct})`;
      if (statusEl) {
        const line =
          pct < 0.13
            ? "Tracing the plate"
            : pct < 0.26
              ? "Setting the wordmark"
              : pct < 0.62
                ? "Drawing the catalogue"
                : pct < 0.79
                  ? "Stamping the sheet"
                  : "Opening the site";
        if (statusEl.textContent !== line) statusEl.textContent = line;
      }
      if (pct < 1 && !gone) raf = frame(tick);
    };
    raf = frame(tick);
  };

  /* Every way out.
     The listeners are scoped to the sheet's life: once it has gone they are
     removed, or the ordered list of exits would keep swallowing Space and
     Enter on the catalogue underneath. `location.replace` keeps the opener out
     of the back stack, so Back from the catalogue never replays it. */
  const disposers = [];
  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    disposers.push(() => target.removeEventListener(type, fn));
  };
  const cleanup = () => {
    while (disposers.length) disposers.pop()();
  };
  const leaveOnce = () => {
    const was = gone;
    exit();
    if (!was) cleanup();
  };

  if (go) {
    on(go, "click", (event) => {
      event.preventDefault();
      leaveOnce();
    });
  }
  on(el, "click", (event) => {
    if (event.target.closest("a")) return;
    leaveOnce();
  });
  on(document, "keydown", (event) => {
    if (gone) return;
    if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
      // Never steal a key from a control that is actually being used.
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      event.preventDefault();
      leaveOnce();
    }
  });

  if (reduceMotion) {
    doc.classList.add("open-quiet");
    if (statusEl) statusEl.textContent = "Sheet AV-01 · Rev 2026";
    if (progress) progress.style.transform = "scaleX(1)";
    countUp();
    go?.focus({ preventScroll: true });
    // The still sheet is a page, not a gate: leaving it is the reader's move.
    return;
  }

  watch();
  countUp();
  setTimeout(exit, DURATION);
}

/* -------------------------------------------------------------------------
   The front door: the same sheet, laid over the catalogue
   ---------------------------------------------------------------------- */

/**
 * Fetch the sheet from /open rather than keeping a second copy of its markup.
 * One small cached document, and the two mountings cannot drift apart.
 */
async function loadSheet() {
  const res = await fetch("/open", { headers: { accept: "text/html" } });
  if (!res.ok) throw new Error(String(res.status));
  const html = await res.text();
  const Parser = globalThis.window?.DOMParser ?? globalThis.DOMParser;
  if (!Parser) throw new Error("no DOMParser");
  const parsed = new Parser().parseFromString(html, "text/html");
  const found = parsed.getElementById("openSheet");
  if (!found) throw new Error("no sheet in /open");

  /* On /open the wordmark is the page's only heading. Overlaid on the home page
     it would be a second <h1> next to the hero's — two headings claiming to be
     the page — so it keeps its look and loses its outline level. */
  const wordmark = found.querySelector(".open-word");
  if (wordmark) {
    const line = parsed.createElement("p");
    line.className = wordmark.className;
    while (wordmark.firstChild) line.appendChild(wordmark.firstChild);
    wordmark.replaceWith(line);
  }

  return document.importNode(found, true);
}

async function openFrontDoor() {
  const doc = document.documentElement;
  if (seen()) {
    // Another tab may have opened the front door between the inline arming and
    // this module running. Un-arm it here rather than leaving the catalogue
    // hidden until the failsafe fires.
    doc.classList.remove("intro-armed");
    document.getElementById("intro")?.remove();
    return;
  }

  // The shell is served with the page (so the front door never flashes the
  // hero); the sheet's markup comes from /open, one cached document that keeps
  // the two mountings identical.
  const shell = document.getElementById("intro");
  let node;
  try {
    node = await loadSheet();
  } catch {
    shell?.remove();
    doc.classList.remove("intro-armed");
    markSeen();
    return;
  }

  if (!shell) {
    doc.classList.remove("intro-armed");
    markSeen();
    return;
  }
  shell.replaceChildren(node);
  shell.classList.remove("open-intro-pending");

  const reveal = () => {
    markSeen();
    shell.classList.add("open-leaving");
    doc.classList.remove("intro-armed");
    // Take the sheet out of the page entirely: it must not intercept clicks,
    // keep animations running, or come back on a bfcache restore.
    setTimeout(() => shell.remove(), 620);
  };

  runSheet(node, reveal);
}

/* -------------------------------------------------------------------------
   Boot
   ---------------------------------------------------------------------- */

if (isStandalone) {
  // /open — the sheet is the page and the catalogue is one link away.
  runSheet(sheet, () => {
    markSeen();
    location.replace("/");
  });
} else if (document.body?.dataset.page === "home" || document.getElementById("intro")) {
  if (forced) {
    try {
      session?.removeItem(PLAYED);
    } catch {
      /* nothing to clear */
    }
  }
  openFrontDoor();
}
