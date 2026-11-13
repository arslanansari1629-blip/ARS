/* =========================================================================
   ArsVibe service worker.

   Why this exists: the Downloads page already keeps *lectures* in IndexedDB,
   which is what makes a saved class play with no connection. Everything else —
   the shell, the catalogue page, and crucially the class notes and DPP PDFs —
   still needed the network. A student revising on a train wants the notes they
   opened last night, not a "you are offline" card.

   Four rules, in priority order:

     1. **Never cache an API answer.** `/api/*` is live data with a signed URL in
        it; a cached one is a lie that expires silently. The only exception is
        the catalogue (`/api/batches`), which is a shipped index and answers
        `s-maxage`, so a stale copy is still correct.
     2. **Never touch a media request.** `/api/download` answers with a
        200 MB attachment and `/api/sign` streams segments; routing either
        through a cache would fight the downloader and the player.
     3. **Notes and PDFs are cache-first.** That is the whole point: a PDF that
        was read once opens again offline. They are immutable by URL.
     4. **Pages are network-first, cache as a fallback.** A deploy should show
        immediately; the cached copy is only for when the network is gone.

   The worker is deliberately small and has no build step. `version` is bumped
   whenever the cache shape changes, and old caches are deleted on activate.
   ========================================================================= */

/* Bump this whenever a *cached asset* changes, not only when the cache shape
   does. `/assets/*` is cache-first keyed on this string, so shipping a fix to
   `batch.js` without bumping it leaves every returning reader running the old
   module with no way to notice: the deploy succeeds, the file on the server is
   new, and the browser never asks for it again. That is what "I fixed it but you
   still see the old behaviour" looks like — twice, in this project's history. */
const VERSION = "arsvibe-v10";
const SHELL_CACHE = `${VERSION}-shell`;
const PAGE_CACHE = `${VERSION}-pages`;
const FILE_CACHE = `${VERSION}-files`;

/** The minimum needed to render a page from cold. */
const SHELL_ASSETS = [
  "/assets/arsvibe.css",
  "/assets/app.js",
  "/assets/shell.mjs",
  "/assets/ui.js",
  "/assets/data.js",
  // The batch page's modules. Pre-cached so a new worker install replaces the copy
  // that `isShellAsset` would otherwise keep serving for ever.
  "/assets/batch.js",
  "/assets/khazana.js",
  "/assets/today.js",
  // The opening sheet: /open is cached as a document (below), and the front
  // door fills itself from it on the first visit of a session.
  "/assets/open.js",
  // Progress is read on the dashboard and the board, needs no request to be
  // useful, and is small enough to pre-cache with the shell.
  "/assets/progress.js",
  "/assets/logo.svg",
  "/assets/icon.svg",
  // The fallback page has to be here, not merely cached when someone happens to
  // visit it: the first offline navigation is exactly the moment it is needed,
  // and by then there is no network left to fetch it with.
  "/offline.html",
];

/** How many page/PDF entries to keep before evicting the oldest. */
const PAGE_LIMIT = 40;
const FILE_LIMIT = 60;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `addAll` rejects wholesale if one URL fails, which would leave the app
      // with no cache at all. Each asset is added on its own for that reason.
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            /* one missing asset is not a failed install */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, PAGE_CACHE, FILE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith("arsvibe-") && !keep.has(name)).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/* --------------------------------- policy -------------------------------- */

const isApi = (url) => url.pathname.startsWith("/api/");
const isCatalogue = (url) => url.pathname === "/api/batches";

/**
 * `/api/media` is the document relay — a notes or DPP PDF fetched through this
 * origin so the reader can show it. Its content is immutable and keyed entirely
 * by `?url=`, which makes it the one API route worth keeping: a chapter of notes
 * read once should open again on a train. The video routes are excluded below.
 */
const isDocRelay = (url) => url.pathname === "/api/media" && url.searchParams.has("url");

const isMedia = (url) =>
  /^\/api\/(download|sign|hls)\b/.test(url.pathname) || /\.(ts|m4s|mp4|m3u8|mpd)$/i.test(url.pathname);

const isFile = (url) =>
  isDocRelay(url) || (/\.(pdf|png|jpe?g|webp|svg|woff2?)$/i.test(url.pathname) && !url.pathname.startsWith("/assets/"));
const isShellAsset = (url) => url.pathname.startsWith("/assets/");
const isDocument = (request) => request.mode === "navigate" || request.destination === "document";

/* --------------------------------- helpers ------------------------------- */

/** Delete the oldest entries until a cache is back under `limit`. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  // Cache keys come back in insertion order, so the front is the oldest.
  for (const request of keys.slice(0, keys.length - limit)) {
    await cache.delete(request);
  }
}

/** Fetch and keep a copy, tolerating opaque responses and cache-write errors. */
async function fetchAndCache(request, cacheName) {
  const response = await fetch(request);
  // `response.type === "opaque"` (a cross-origin image) still stores, but its
  // status is unreadable — only cache real successes to keep the count honest.
  if (response && (response.ok || response.type === "opaque")) {
    const cache = await caches.open(cacheName);
    try {
      await cache.put(request, response.clone());
      await trim(cache, cacheName === PAGE_CACHE ? PAGE_LIMIT : FILE_LIMIT);
    } catch {
      /* quota: serving the response still matters more than caching it */
    }
  }
  return response;
}

/* ---------------------------------- fetch -------------------------------- */

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Same-origin only: a third-party request (an image CDN, a signer) is none of
  // this worker's business and must not be delayed by it.
  if (url.origin !== self.location.origin) return;
  if (isMedia(url)) return;
  if (isApi(url) && !isCatalogue(url) && !isDocRelay(url)) return;

  /* The catalogue index: cache-first, because it is a shipped file that the
     route itself serves with `s-maxage`. Refreshed in the background. */
  if (isCatalogue(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FILE_CACHE);
        const hit = await cache.match(request);
        const network = fetchAndCache(request, FILE_CACHE).catch(() => null);
        return hit || (await network) || Response.error();
      })()
    );
    return;
  }

  /* Notes, DPPs and other documents read inside the viewer: cache-first. */
  if (isFile(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FILE_CACHE);
        const hit = await cache.match(request);
        if (hit) {
          // Refresh quietly so a re-issued PDF is picked up next time.
          fetchAndCache(request, FILE_CACHE).catch(() => {});
          return hit;
        }
        try {
          return await fetchAndCache(request, FILE_CACHE);
        } catch {
          return new Response("This file is not available offline.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      })()
    );
    return;
  }

  /* Site assets: cache-first, they carry a `must-revalidate` header and change
     only with a deploy, which bumps `VERSION` above. */
  if (isShellAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          return await fetchAndCache(request, SHELL_CACHE);
        } catch {
          return Response.error();
        }
      })()
    );
    return;
  }

  /* Pages: network-first, so a deploy is never hidden behind a stale copy. */
  if (isDocument(request) || (request.headers.get("accept") || "").includes("text/html")) {
    event.respondWith(
      (async () => {
        try {
          return await fetchAndCache(request, PAGE_CACHE);
        } catch {
          const cache = await caches.open(PAGE_CACHE);

          /* Exact match first. Only then relax the query string, because
             `/batch?id=A` and `/batch?id=B` are the same path: a loose match
             here would show one batch's page when another was asked for, which
             is worse than an honest offline card. */
          const hit =
            (await cache.match(request)) ||
            (await cache.match(request, { ignoreSearch: true }).then(async (loose) => {
              const asked = new URL(request.url).search;
              if (!asked) return loose;
              // The page shell is interchangeable between entities only when it
              // is the shell that is wrong, not the entity: prefer the offline
              // card over a page describing a different batch.
              const looseUrl = loose && new URL(loose.url || request.url).search;
              return loose && looseUrl === asked ? loose : null;
            }));
          if (hit) return hit;
          const offline = await caches.match("/offline.html");
          return (
            offline ||
            new Response("You are offline and this page was not saved.", {
              status: 503,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          );
        }
      })()
    );
  }
});

/* ------------------------------- messages -------------------------------- */

self.addEventListener("message", (event) => {
  const data = event.data || {};

  /** Let a page ask for a file to be stored *before* it is needed offline. */
  if (data.type === "cache-url" && typeof data.url === "string") {
    event.waitUntil(
      (async () => {
        try {
          const url = new URL(data.url, self.location.origin);
          if (url.origin !== self.location.origin) return;
          await fetchAndCache(new Request(url.toString(), { cache: "reload" }), FILE_CACHE);
        } catch {
          /* a failed pre-cache is not an error the page needs to handle */
        }
      })()
    );
  }

  /** Ask how much has been stored, so the Downloads page can say so. */
  if (data.type === "stats") {
    event.waitUntil(
      (async () => {
        const names = [SHELL_CACHE, PAGE_CACHE, FILE_CACHE];
        const counts = {};
        for (const name of names) {
          const cache = await caches.open(name);
          counts[name] = (await cache.keys()).length;
        }
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) client.postMessage({ type: "stats", counts });
      })()
    );
  }

  /** Drop everything this worker stored. Saved lectures live elsewhere. */
  if (data.type === "clear") {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith("arsvibe-")).map((n) => caches.delete(n)));
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) client.postMessage({ type: "cleared" });
      })()
    );
  }

  if (data.type === "skip-waiting") self.skipWaiting();
});
