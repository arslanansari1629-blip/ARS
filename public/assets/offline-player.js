/* =========================================================================
   Playing a saved lecture, on this site.

   The library used to open a bare blob in a blank tab, which is why a saved
   lecture looked like something that had left the site: the only obvious button
   wrote a file into Chrome's Downloads folder and the other one opened a page
   that was not this page. Both are wrong readings of "plays offline".

   So this is the player: a real sheet, in the site's own design, that pulls the
   media out of IndexedDB and plays it — no server, no signed URL, no network of
   any kind. What it plays is a Blob made from the parts already on the device:

     · MPEG-TS (the default download) is `video/mp2t`, which the browser plays
       directly through a blob URL — nothing to fetch, nothing to expire;
     · a keyed playlist becomes a self-contained `.m3u8` blob handed to hls.js.

   "Save to device" stays, deliberately: a file on disk is how a lecture gets to
   a phone that does not have this site open. It is just no longer the only way
   to watch.
   ========================================================================= */

import { savedLecture, offlineFile, fmtDuration } from "./downloader.js";

/** hls.js, same-origin first, exactly as the lecture player loads it. */
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  const sources = [
    "/assets/vendor/hls.min.js",
    "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js",
    "https://unpkg.com/hls.js@1.5.17/dist/hls.min.js",
  ];
  return sources.reduce(
    (chain, src) =>
      chain.then(
        (found) =>
          found ||
          new Promise((resolve) => {
            const el = document.createElement("script");
            el.src = src;
            el.async = true;
            el.onload = () => resolve(window.Hls || false);
            el.onerror = () => resolve(false);
            document.head.appendChild(el);
          })
      ),
    Promise.resolve(false)
  );
}

const sheet = document.createElement("div");
sheet.className = "offline-player";
sheet.hidden = true;
sheet.innerHTML = `
  <div class="offline-player-backdrop" data-close></div>
  <div class="offline-player-card" role="dialog" aria-modal="true" aria-label="Offline lecture">
    <div class="offline-player-head">
      <span class="grow">
        <span class="offline-player-title" id="opTitle">Lecture</span>
        <span class="offline-player-meta" id="opMeta">Saved on this device</span>
      </span>
      <button class="btn btn-ghost btn-sm" data-close aria-label="Close">Close</button>
    </div>
    <div class="offline-player-stage">
      <video id="opVideo" controls playsinline preload="metadata"></video>
      <p class="offline-player-note" id="opNote" hidden></p>
    </div>
    <div class="offline-player-foot">
      <span class="tiny dim" id="opFoot">Playing from this device — no connection needed.</span>
      <span class="grow"></span>
      <button class="btn btn-ghost btn-sm" id="opSave">Save to device</button>
    </div>
  </div>`;
document.body.appendChild(sheet);

const video = sheet.querySelector("#opVideo");
const titleEl = sheet.querySelector("#opTitle");
const metaEl = sheet.querySelector("#opMeta");
const noteEl = sheet.querySelector("#opNote");
const footEl = sheet.querySelector("#opFoot");
const saveBtn = sheet.querySelector("#opSave");

/** The blob URL currently attached, revoked on close so nothing is leaked. */
let currentUrl = "";
let currentRecord = null;
let hls = null;
let returnFocus = null;

function release() {
  if (hls) {
    try {
      hls.destroy();
    } catch {
      /* an already-destroyed instance is not a fault */
    }
    hls = null;
  }
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    /* jsdom and old webviews have no media pipeline */
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = "";
  }
}

function close() {
  release();
  sheet.hidden = true;
  document.body.classList.remove("op-open");
  if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
}

function say(text) {
  noteEl.hidden = !text;
  noteEl.textContent = text || "";
}

/**
 * Load and play one saved lecture.
 *
 * Kept exportable so the page can call it from the player's own menu and from a
 * saved card, without either of them knowing how the bytes are shaped.
 */
export async function playSaved(id, { trigger } = {}) {
  const record = await savedLecture(id);
  if (!record) return false;
  returnFocus = trigger || document.activeElement;
  currentRecord = record;

  sheet.hidden = false;
  document.body.classList.add("op-open");
  titleEl.textContent = record.title || "Lecture";
  const held = (record.parts || []).reduce((n, p) => n + (p.size || 0), 0);
  metaEl.textContent = [
    record.done ? "Saved on this device" : "Partially saved",
    fmtDuration(record.seconds || 0),
    record.label || (record.quality ? `${record.quality}p` : ""),
    held ? `${(held / (1024 * 1024)).toFixed(1)} MB` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  say("");
  footEl.textContent = "Playing from this device — no connection needed.";
  release();

  const { blob } = offlineFile(record);
  currentUrl = URL.createObjectURL(blob);

  // A plain download is real MPEG-TS, and a `video/mp2t` blob plays directly.
  // A keyed one is a playlist, which needs hls.js to read it.
  if (record.format === "plain") {
    video.src = currentUrl;
    try {
      await video.play();
    } catch {
      // Autoplay policy: the controls are right there, and pressing play works.
      say("Press play to start — the browser blocked autoplay.");
    }
    return true;
  }

  const Hls = await loadHls();
  if (Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: false });
    hls.loadSource(currentUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data || !data.fatal) return;
      say("This saved lecture could not be read back. Try Save to device and open it in VLC.");
    });
    try {
      await video.play();
    } catch {
      /* controls are visible */
    }
    return true;
  }

  // Safari plays a playlist natively; anything else gets an honest message
  // rather than a black rectangle.
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = currentUrl;
    return true;
  }
  say(
    "This lecture was saved as a playlist and this browser has no playlist reader. Save it to the device and open it in VLC — or re-save it after updating the app."
  );
  return false;
}

saveBtn.addEventListener("click", () => {
  if (!currentRecord) return;
  const { blob, name } = offlineFile(currentRecord);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
  footEl.textContent = `Saved “${name}” to your device.`;
});

sheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) close();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sheet.hidden) close();
});

window.addEventListener("beforeunload", release);
