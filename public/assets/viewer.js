/* PDF reader — resolves the relay URL and keeps the document for offline */

const params = new URLSearchParams(location.search);
const name = params.get("name") || "Document";
const raw = params.get("url") || "";
const id = params.get("id") || "";
const base = params.get("base") || "https://static.pw.live/";

const src = raw
  ? `/api/media?url=${encodeURIComponent(raw)}`
  : `/api/media?id=${encodeURIComponent(id)}&base=${encodeURIComponent(base)}`;

document.getElementById("docTitle").textContent = name;
document.getElementById("docMeta").textContent = "Rendered from the Physics Wallah PDF library";
document.title = `${name} — ArsVibe PW`;

const frame = document.getElementById("frame");
frame.src = src;

const download = document.getElementById("downloadBtn");
download.href = src;
download.download = name.endsWith(".pdf") ? name : `${name}.pdf`;

document.getElementById("openBtn").href = raw || (base + id);

/* Keep the document, so reopening it later needs no connection.
   The reader is the one place a person spends real time on a PDF — a chapter
   of notes, a DPP. The service worker already serves `/api/media?url=…`
   cache-first once it holds a copy, so all this has to do is ask for the copy
   to be taken now rather than whenever this tab is closed. It is best effort
   on purpose: a browser without a worker, or a file over the quota, must not
   make the document fail to open. */
(async () => {
  try {
    const { cacheForOffline, offlineReady } = await import("/assets/sw-register.js");
    if (!offlineReady()) return;
    cacheForOffline(src);

    const meta = document.getElementById("docMeta");
    const say = (text) => {
      if (meta) meta.textContent = text;
    };
    say("Rendered from the Physics Wallah PDF library · keeping a copy for offline");

    // Confirm from the cache itself rather than assuming the worker obliged:
    // `caches.match` is readable from the page for same-origin requests.
    if (!("caches" in window)) return;
    const keep = await caches.match(src, { ignoreSearch: false });
    say(
      keep
        ? "Saved on this device · opens without a connection"
        : "Rendered from the Physics Wallah PDF library · will be kept for offline after it loads"
    );

    // The first sweep usually runs before the worker has finished writing, so
    // one short second pass is what actually reports the truth.
    setTimeout(async () => {
      try {
        const again = await caches.match(src);
        if (again) say("Saved on this device · opens without a connection");
      } catch {
        /* ignore: the message above is already honest */
      }
    }, 1500);
  } catch {
    /* offline keeping is an enhancement; opening the document is not */
  }
})();
