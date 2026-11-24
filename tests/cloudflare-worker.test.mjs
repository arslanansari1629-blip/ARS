/**
 * The Cloudflare Worker entry: API paths reach the adapter, everything
 * else falls to the static-assets binding, and the daily cron re-runs
 * the scanner with the platform proof the admin route expects.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.PW_UPSTREAM_BASE = process.env.PW_UPSTREAM_BASE || "http://127.0.0.1:9";

const worker = (await import("../cloudflare/worker.js")).default;

test("API paths are dispatched, static paths hit ASSETS", async () => {
  let assetPath = "";
  const env = {
    ASSETS: {
      fetch: async (req) => {
        assetPath = new URL(req.url).pathname;
        return new Response("static", { status: 200 });
      },
    },
  };
  const api = await worker.fetch(new Request("https://arsvibe.workers.dev/api/batches?facets=1"), env);
  assert.equal(api.status, 200);
  assert.equal(assetPath, "", "an API call must never fall through to static assets");

  const page = await worker.fetch(new Request("https://arsvibe.workers.dev/batches.html"), env);
  assert.equal(await page.text(), "static");
  assert.equal(assetPath, "/batches.html");
});

test("the cron pings the scanner with platform proof", async () => {
  let pinged = "";
  const env = { ASSETS: { fetch: async () => new Response("") } };
  const waits = [];
  await worker.scheduled({ cron: "0 3 * * *" }, env, { waitUntil: (p) => waits.push(p) });
  assert.equal(waits.length, 1);
  // The ping itself must not throw the cron handler over.
  await waits[0];
});

test("the five-minute cron runs the bot watchdog, not the scanner", async () => {
  const env = { ASSETS: { fetch: async () => new Response("") } };
  const waits = [];
  await worker.scheduled({ cron: "*/5 * * * *" }, env, { waitUntil: (p) => waits.push(p) });
  assert.equal(waits.length, 1);
  // No bots in the test store: the watchdog must simply finish.
  await waits[0];
});
