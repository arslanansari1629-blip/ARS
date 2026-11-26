/**
 * The site-wide advanced-technology pack:
 *  - service worker Navigation Preload (worker boots in parallel
 *    with the page fetch instead of in front of it),
 *  - the Adaptive Performance Engine (device-tiered spectacle),
 *  - an advanced PWA manifest (window-controls-overlay, launch
 *    handler, Allen app shortcut),
 *  - edge document hardening headers in the Cloudflare worker.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("the service worker preloads navigations and stays versioned", async () => {
  const sw = await read("public/sw.js");
  assert.match(sw, /navigationPreload\.enable\(\)/, "navigation preload is never enabled");
  assert.match(sw, /event\.preloadResponse/, "the preload response is never used");
  assert.match(sw, /const VERSION = "arsvibe-v\d+"/, "the cache version stamp is missing");
});

test("the shell adapts the site's spectacle to the device", async () => {
  const shell = await read("public/assets/shell.mjs");
  assert.match(shell, /perfEngine/, "the Adaptive Performance Engine is missing");
  assert.match(shell, /dataset\.perf/, "the perf tier never lands on <html>");
  assert.match(shell, /deviceMemory/, "device memory is not part of the verdict");
  assert.match(shell, /getBattery/, "a draining battery cannot calm the site down");
  assert.match(shell, /requestIdleCallback/, "idle warm-up is missing");
  assert.match(shell, /speculationrules/, "instant navigation regressed");
  const css = await read("public/assets/arsvibe.css");
  assert.match(css, /data-perf="lite"/, "CSS ignores the lite tier");
  assert.match(css, /page-hidden/, "hidden tabs keep animating");
});

test("the manifest is an advanced PWA manifest", async () => {
  const manifest = JSON.parse(await read("public/manifest.webmanifest"));
  assert.ok(
    manifest.display_override.includes("window-controls-overlay"),
    "window-controls-overlay missing from display_override"
  );
  assert.equal(manifest.launch_handler.client_mode, "focus-existing");
  const urls = (manifest.shortcuts || []).map((s) => s.url);
  assert.ok(urls.includes("/allen.html"), "the Allen app shortcut is missing");
  assert.ok(urls.includes("/batches.html"), "the batches shortcut is missing");
});

test("the edge hardens documents without touching media or API", async () => {
  const worker = await read("cloudflare/worker.js");
  assert.match(worker, /X-Content-Type-Options/, "document hardening missing at the edge");
  assert.match(worker, /sec-fetch-dest/, "hardening is not scoped to documents");
});
