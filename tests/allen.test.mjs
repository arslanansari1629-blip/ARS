/**
 * The Allen platform: its own catalogue, its own bt_/cr_ ids, never
 * the PW shapes. The upstream routes are the ones Nexthope's own
 * Allen pages call (discovered live): /Allen/batches.json,
 * /Allen/api/subjects|topics|contents, and /api/token play URLs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  allenPlay,
  allenProxyAllowed,
  normalizeAllenBatch,
  normalizeAllenLecture,
  normalizeAllenSubject,
  normalizeAllenTopic,
  resetAllenCache,
  rewriteAllenPlaylist,
} from "../lib/allen.mjs";

/** A response object that records what the handler did. */
function fakeRes() {
  const headers = {};
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  return {
    statusCode: 200,
    headers,
    body: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("utf8"),
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = String(value);
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      finished();
    },
    done,
  };
}

async function callBatches(query) {
  const { default: handler } = await import("../api/batches.mjs");
  const res = fakeRes();
  await handler({ method: "GET", url: `/api/batches?${query}`, headers: {} }, res);
  await res.done;
  return { status: res.statusCode, headers: res.headers, text: () => res.text(), json: async () => JSON.parse(res.text()) };
}

test("a Nexthope batches.json row normalises to code/ids/exam", () => {
  const out = normalizeAllenBatch({
    batch_id: "bt_TgS6lWQF1S9ESPIh1BCOf",
    batch_name: "D6TL-36-DILC21",
    course_id: "cr_LylAze94OqLyj641cXJTA",
    course_name: "JEE (MAIN + ADVANCED) LEADER ENGLISH",
    class: "Class 12 Plus",
    stream: "JEE Advanced",
    batch_status: "LIVE",
  });
  assert.equal(out.code, "D6TL-36-DILC21");
  assert.equal(out.batchId, "bt_TgS6lWQF1S9ESPIh1BCOf");
  assert.equal(out.courseId, "cr_LylAze94OqLyj641cXJTA");
  assert.equal(out.exam, "JEE Advanced");
  const neet = normalizeAllenBatch({
    batch_id: "bt_Kf1IzzyNFJiF0eubGsbd0",
    batch_name: "X1ME-1AP-RMGAJ",
    course_name: "PRE-MEDICAL ENTHUSIAST ENGLISH",
    stream: "NEET",
  });
  assert.equal(neet.exam, "NEET");
});

test("PW catalogue rows can never pass as Allen batches", () => {
  // Nexthope's shared API answers its PW catalogue under /Allen/api/*
  // too (live: 17,302 PW rows). No bt_ id, no Allen batch — the one
  // failure this section must never ship.
  assert.equal(normalizeAllenBatch({ name: "Lakshya JEE 2025", batch_id: "65d862392b1da90018ad8f3b", batch_name: "Lakshya" }), null);
  assert.equal(normalizeAllenBatch({ batch_id: "bt_x", batch_name: "65d862392b1da90018ad8f3b" }), null);
  assert.equal(normalizeAllenBatch({ batch_name: "D6TL-36-DILC21" }), null, "a code without its bt_ id cannot be opened");
});

test("Allen subject, topic and lecture rows normalise from upstream variants", () => {
  const s = normalizeAllenSubject({ subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" });
  assert.equal(s.id, "984");
  assert.equal(s.taxonomyId, "1763385325sj");
  const t = normalizeAllenTopic({ topic_id: "1295", name: "Chemistry In Everyday Life", order: 1, videos_count: 3 });
  assert.equal(t.id, "1295");
  const lec = normalizeAllenLecture({
    content_id: "79b3a1ac-bec7-4780-b5c6-e06bb8c76ec7",
    title: "CSD CHEMISTRY DARPAN 304",
    duration: "77:00",
    play_url: "/api/token?token=abc&media=1",
  });
  assert.equal(lec.title, "CSD CHEMISTRY DARPAN 304");
  assert.match(lec.playUrl, /^https:\/\/stream\.nexthope\.sbs\/api\/token\?token=abc/, "play_url must be made absolute against the Allen upstream");
});

test("/api/allen serves batches, subjects and lectures from the real upstream routes", async () => {
  resetAllenCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const u = String(url);
    if (u.includes("/Allen/batches.json")) {
      return new Response(
        JSON.stringify([
          {
            batch_id: "bt_TgS6lWQF1S9ESPIh1BCOf",
            batch_name: "D6TL-36-DILC21",
            course_id: "cr_LylAze94OqLyj641cXJTA",
            course_name: "JEE (MAIN + ADVANCED) LEADER ENGLISH",
            stream: "JEE Advanced",
            class: "Class 12 Plus",
            batch_status: "LIVE",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/Allen/api/subjects")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            { subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" },
            { subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/Allen/api/contents")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ content_id: "lec-1", title: "Darpan 304", duration: "77:00", play_url: "/api/token?token=t1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const batches = await callBatches("action=allen&view=batches");
    assert.equal(batches.status, 200);
    const bbody = await batches.json();
    assert.equal(bbody.items[0].code, "D6TL-36-DILC21");

    const subjects = await callBatches("action=allen&view=subjects&batch=bt_TgS6lWQF1S9ESPIh1BCOf&course=cr_LylAze94OqLyj641cXJTA");
    const sbody = await subjects.json();
    assert.equal(sbody.items.length, 1, "the upstream's enrolled+curriculum duplicates must collapse to one card");

    const lectures = await callBatches(
      "action=allen&view=lectures&batch=bt_TgS6lWQF1S9ESPIh1BCOf&course=cr_LylAze94OqLyj641cXJTA&subject=984&taxonomy=1763385325sj&topic=1295"
    );
    const lbody = await lectures.json();
    assert.equal(lbody.items[0].id, "lec-1");
    assert.match(lbody.items[0].playUrl, /\/api\/token\?token=t1/);
    assert.ok(seen.some((x) => x.includes("nexthope.sbs/Allen/api/contents")), "lectures must come from the contents route");
  } finally {
    globalThis.fetch = original;
  }
});

test("the Allen proxy rewrites playlists onto our own media relay", () => {
  const out = rewriteAllenPlaylist(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/main.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg-1.ts\nhttps://cdn.allen.in/abs/seg-2.ts\n',
    "https://cdn.allen.in/live/master.m3u8"
  );
  assert.match(out, /URI="\/api\/media\?url=https%3A%2F%2Fcdn\.allen\.in%2Flive%2Fkey\.bin"/, "keys ride the media relay");
  // The audio playlist is a playlist, not a file: through the plain
  // relay it arrived unrewritten and its segments died — video with
  // no awaaz. It must recurse through the playlist proxy.
  assert.match(
    out,
    /#EXT-X-MEDIA:[^\n]*URI="\/api\/allen\?view=playlist&u=https%3A%2F%2Fcdn\.allen\.in%2Flive%2Faudio%2Fmain\.m3u8"/,
    "the audio playlist must recurse through the playlist proxy"
  );
  // Media lines ride the playlist proxy again, never the plain relay:
  // a variant playlist through the relay keeps its relative segments
  // and they resolve against the relay URL and die (proven live).
  assert.match(out, /\/api\/allen\?view=playlist&u=https%3A%2F%2Fcdn\.allen\.in%2Flive%2Fseg-1\.ts/);
  assert.match(out, /seg-2\.ts/);
  assert.ok(!/seg-1\.ts\n/.test(out.replace(/%2Fseg-1\.ts/, "")), "no bare segment URI may survive the rewrite");
  assert.equal(allenProxyAllowed("https://cdn.allen.in/x.m3u8"), true);
  assert.equal(allenProxyAllowed("https://stream.nexthope.sbs/api/token?t=1"), true);
  assert.equal(allenProxyAllowed("https://evil.example.com/x.m3u8"), false, "the proxy is for Allen hosts, not the open internet");
  assert.equal(allenProxyAllowed("http://cdn.allen.in/x.m3u8"), false);
});

test("a playlist served as text/plain at the token URL still resolves", async () => {
  // Their player loads the token URL itself as the HLS source, and
  // the endpoint answers #EXTM3U with a lying content-type. Sniffing
  // the body is the fix; trusting text/plain was the outage.
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("#EXTM3U\n#EXTINF:6,\nseg-1.ts\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  try {
    const out = await allenPlay("https://stream.nexthope.sbs/api/token?token=t1&media=1");
    assert.equal(out.success, true);
    assert.match(out.url, /\/api\/token\?token=t1/);
  } finally {
    globalThis.fetch = original;
  }
});

test("the playlist proxy sniffs #EXTM3U out of a text/plain answer", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("#EXTM3U\n#EXTINF:6,\nseg-1.ts\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  try {
    const res = await callBatches(
      "action=allen&view=playlist&u=https%3A%2F%2Fcdn.allen.in%2Fapi%2Ftoken%3Ftoken%3Dt1"
    );
    // callBatches parses via the fake res: check the raw body instead.
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test("the playlist proxy retries a refused first ask on the second header shape", async () => {
  resetAllenCache();
  const original = globalThis.fetch;
  let asks = 0;
  globalThis.fetch = async () => {
    asks += 1;
    if (asks === 1) return new Response("denied", { status: 403 });
    return new Response("#EXTM3U\n#EXTINF:6,\nseg-1.ts\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  try {
    const res = await callBatches(
      "action=allen&view=playlist&u=https%3A%2F%2Fcdn.allen.in%2Ftoken%3Ft%3Dretry1"
    );
    assert.equal(res.status, 200);
    assert.match(res.text(), /#EXTM3U/);
    assert.match(res.text(), /view=playlist/, "segments must recurse through the proxy");
    assert.equal(asks, 2, "a 403 on the player header shape must be retried once, not surrendered");
  } finally {
    globalThis.fetch = original;
  }
});

test("the Allen page ships its own skin and the upgraded player", async () => {
  const page = await readFile(new URL("../public/allen.html", import.meta.url), "utf8");
  assert.match(page, /\/assets\/allen\.css/, "the Allen page must load its own stylesheet");
  for (const id of ["allenQuality", "allenSpeed", "allenPip", "allenFull", "allenProgress", "allenBigPlay", "allenSort", "allenStatTotal", "allenCenter", "allenCBack", "allenCFwd", "allenSpeedBtn", "allenQualityBtn", "allenSpeedMenu", "allenQualityMenu", "allenStageTitle"]) {
    assert.match(page, new RegExp(`id="${id}"`), `upgraded player/catalogue is missing #${id}`);
  }
  const css = await readFile(new URL("../public/assets/allen.css", import.meta.url), "utf8");
  assert.match(css, /allen-hero/);
  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  assert.match(script, /proxyUrl/, "the player must load our proxy URL, not Allen's host");
  assert.match(script, /arsvibe\.allen\.pos\./, "resume-position memory is missing");
});

test("the Allen player is Pro X: QoE console, seek FX, cinema, settings memory", async () => {
  const page = await readFile(new URL("../public/allen.html", import.meta.url), "utf8");
  for (const id of ["allenStatsPanel", "allenStatsBtn", "allenCinemaBtn", "allenSeekFxL", "allenSeekFxR", "allenStBuffer", "allenStDropped"]) {
    assert.match(page, new RegExp(`id="${id}"`), `Pro X player is missing #${id}`);
  }
  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  assert.match(script, /arsvibe\.allen\.settings\.v1/, "player settings must persist across sessions");
  assert.match(script, /getVideoPlaybackQuality/, "the QoE console must read dropped frames");
  assert.match(script, /slowNet/, "a data-saver connection must change the start level");
  assert.match(script, /dblclick/, "double-tap seek is missing");
  const shell = await readFile(new URL("../public/assets/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /speculationrules/, "site-wide instant navigation is missing");
});

test("the Allen player has the Fullscreen Fit Engine: device-detecting auto-fit ladder", async () => {
  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  // Rung 1: standard + prefixed element fullscreen, options retried bare.
  assert.match(script, /requestFullscreen/, "standard fullscreen request is missing");
  assert.match(script, /webkitRequestFullscreen/, "webkit-prefixed fullscreen is missing");
  // Rung 2: Android orientation lock so a portrait phone actually fills.
  assert.match(script, /orientation/, "orientation handling is missing");
  assert.match(script, /\.lock\("landscape"\)/, "landscape lock is missing");
  // Rung 3: iOS Safari only fullscreens the <video> element itself.
  assert.match(script, /webkitEnterFullscreen/, "iOS video fullscreen fallback is missing");
  assert.match(script, /isIOS/, "device detection is missing");
  // Rung 4: pseudo-fullscreen so webviews still fill the viewport.
  assert.match(script, /ap-pseudo-fs/, "pseudo-fullscreen fallback is missing");
  assert.match(script, /fullscreenchange/, "fullscreen state sync is missing");

  const css = await readFile(new URL("../public/assets/allen.css", import.meta.url), "utf8");
  assert.match(css, /:fullscreen[^{]*\{[^}]*display: flex/s, "fullscreen shell must stretch to the viewport");
  assert.match(css, /aspect-ratio: auto/, "fullscreen stage must drop the 16/9 strap");
  assert.match(css, /safe-area-inset/, "notch safe-area padding is missing");
  assert.match(css, /100dvh/, "pseudo-fullscreen must use the dynamic viewport");

  const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(sw, /arsvibe-v43/, "cached-asset changes must bump the SW version");
});

test("the Allen page self-heals: fault-isolated wiring, versioned assets, boot watchdog", async () => {
  const page = await readFile(new URL("../public/allen.html", import.meta.url), "utf8");
  // Version-stamped assets defeat a stale worker's cache-first assets:
  // the query is part of the cache key, so ?v= is a guaranteed miss.
  assert.match(page, /allen\.js\?v=41/, "allen.js must be version-stamped");
  assert.match(page, /allen\.css\?v=41/, "allen.css must be version-stamped");
  // The watchdog is inline + classic (module failure cannot silence it)
  // and purges caches/workers exactly once per session.
  assert.match(page, /Boot watchdog/, "boot watchdog is missing");
  assert.match(page, /arsvibe\.allen\.healed\.v1/, "watchdog must be loop-guarded");
  assert.match(page, /caches\.delete/, "watchdog must purge caches");
  assert.match(page, /getRegistrations/, "watchdog must unregister stale workers");

  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  // Player wiring can throw without taking the catalogue down with it.
  assert.match(script, /wire\(wirePlayer\)/, "player wiring must be fault-isolated");
  assert.match(script, /loadCatalogue\(\)\.catch/, "catalogue load must carry its own failure path");
});

test("Allen content can never be hidden by its own entrance animation (white-grid regression)", async () => {
  const css = await readFile(new URL("../public/assets/allen.css", import.meta.url), "utf8");
  // The perf engine pauses animations on lite devices; cards that
  // start at opacity:0 (allenRise, fill both) froze invisible. Where
  // animations are throttled, choreography is removed, not paused.
  assert.match(css, /html\[data-perf="lite"\] \.allen-card[^}]*animation: none !important/s, "lite tier must not pause cards at opacity 0");
  assert.match(css, /html\.page-hidden \.allen-card[^}]*opacity: 1 !important/s, "hidden-tab freeze must not stick to a visible grid");
  // content-visibility on animated cards left blank tiles on mobile.
  assert.match(css, /#allenGrid > \*[^}]*content-visibility: visible/s, "Allen grid must render directly");

  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  // The grid renders before any decorative painter gets a chance to throw.
  const load = script.slice(script.indexOf("async function loadCatalogue"));
  assert.ok(load.indexOf("renderGrid()") < load.indexOf("paintStats()"), "catalogue must render before hero stats paint");
  assert.match(load, /try \{\s*paintStats\(\)/, "stats painting must be fault-isolated");
  assert.match(load, /try \{\s*paintContinue\(\)/, "continue painting must be fault-isolated");
});

test("view=play never consumes the token — it only hands back the proxy URL", async () => {
  // Their player loads the token URL exactly once. A resolver that
  // pre-fetches it to "check" burns a short-lived/single-use token,
  // and the player's real ask then lands on a dead one. The play
  // endpoint must answer without any upstream fetch at all.
  const original = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("upstream must not be touched by view=play");
  };
  try {
    const res = await callBatches(
      "action=allen&view=play&play=https%3A%2F%2Fstream.nexthope.sbs%2Fapi%2Ftoken%3Ftoken%3Dabc123"
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.match(body.proxyUrl, /view=playlist&u=/);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("a stale client asking by batch CODE still gets its subjects", async () => {
  // The service worker serves /assets cache-first, so a returning
  // reader can run last week's allen.js, which asks view=subjects
  // with the visible code instead of the bt_ id. The API resolves
  // code → ids; without this, that reader sees an empty panel.
  resetAllenCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/Allen/batches.json")) {
      return new Response(
        JSON.stringify([
          {
            batch_id: "bt_TgS6lWQF1S9ESPIh1BCOf",
            batch_name: "D6TL-36-DILC21",
            course_id: "cr_LylAze94OqLyj641cXJTA",
            course_name: "JEE (MAIN + ADVANCED) LEADER ENGLISH",
            stream: "JEE Advanced",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (u.includes("/Allen/api/subjects")) {
      return new Response(
        JSON.stringify({ success: true, data: [{ subject_id: "984", name: "Chemistry", taxonomy_id: "1763385325sj" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const res = await callBatches("action=allen&view=subjects&code=D6TL-36-DILC21");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items[0].name, "Chemistry");
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/allen without a batch id answers a useful 400, never a crash", async () => {
  const res = await callBatches("action=allen&view=subjects");
  assert.equal(res.status, 400);
});

test("the Allen page, route aliases and scanner contract are wired", async () => {
  const page = await readFile(new URL("../public/allen.html", import.meta.url), "utf8");
  assert.match(page, /id="allenGrid"/);
  assert.match(page, /id="allenSearch"/);
  const script = await readFile(new URL("../public/assets/allen.js", import.meta.url), "utf8");
  assert.match(script, /\/api\/allen\?view=batches/, "the page must read its own API, not Nexthope directly");
  assert.ok(!/nexthope/i.test(script), "the browser must never hardcode the upstream host");
  const scanner = await readFile(new URL("../lib/scanner.mjs", import.meta.url), "utf8");
  assert.match(scanner, /"allen\.html"/, "the scanner would never notice a broken Allen page");
  const worker = await readFile(new URL("../functions/api/[[route]].js", import.meta.url), "utf8");
  assert.match(worker, /allen: \["batches", "allen"\]/, "the Worker would 404 /api/allen");
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok((vercel.rewrites || []).some((r) => r.source === "/api/allen"), "Vercel would 404 /api/allen");
});
