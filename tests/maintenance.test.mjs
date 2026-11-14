/**
 * Maintenance mode: the operator's switch, end to end.
 *
 * What is pinned:
 *   1. the gate answers 503 { maintenance: true } on a student route while
 *      the switch is on, and the route answers normally when it is off;
 *   2. the public status read needs no session (the wall on every page
 *      polls it), and the write side refuses anyone without one;
 *   3. the admin route itself is never gated — the operator must always
 *      be able to turn the site back on;
 *   4. the wall ships in the module every page loads, and exempts /admin.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4290;
const FIXPORT = 4291;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_ENV = { ADMIN_USERNAME: "operator-test", ADMIN_PASSWORD: "operator-test-pass" };

const children = [];
function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function waitFor(url, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

let adminToken = "";

before(async () => {
  start(["scripts/fixture-upstream.mjs"], { FIXTURE_PORT: String(FIXPORT) });
  await waitFor(`http://127.0.0.1:${FIXPORT}/AllBatches?page=1`);
  start(["scripts/dev.mjs"], {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PW_UPSTREAM_BASE: `http://127.0.0.1:${FIXPORT}`,
    ...TEST_ENV,
  });
  await waitFor(`${BASE}/admin.html`);

  const res = await fetch(`${BASE}/api/admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TEST_ENV.ADMIN_USERNAME, password: TEST_ENV.ADMIN_PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  adminToken = body.token;
  assert.ok(adminToken, "sign-in must return a session token");
});

after(() => {
  for (const child of children) child.kill("SIGKILL");
});

async function setSwitch(on, { auth = true, message = "" } = {}) {
  return fetch(`${BASE}/api/admin?action=maintenance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { "x-admin-token": adminToken } : {}),
    },
    body: JSON.stringify({ on, message }),
  });
}

test("the switch needs a session, and the status read does not", async () => {
  const refused = await setSwitch(true, { auth: false });
  assert.equal(refused.status, 401, "flipping the switch without a session must be refused");

  const pub = await fetch(`${BASE}/api/admin?action=maintenance`);
  assert.equal(pub.status, 200, "the status read is public — the wall polls it");
  const body = await pub.json();
  assert.equal(body.maintenance.on, false);
});

test("on means 503 everywhere for students, and the admin can still turn it off", async () => {
  const on = await setSwitch(true, { message: "Back in ten minutes." });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).maintenance.on, true);

  // A student route is gated…
  const gated = await fetch(`${BASE}/api/batches?page=1`);
  assert.equal(gated.status, 503);
  const gatedBody = await gated.json();
  assert.equal(gatedBody.maintenance, true);
  assert.match(gatedBody.message, /Back in ten minutes/);

  // …the public status agrees…
  const pub = await (await fetch(`${BASE}/api/admin?action=maintenance`)).json();
  assert.equal(pub.maintenance.on, true);

  // …and the operator surface still answers, so the switch can be flipped back.
  const off = await setSwitch(false);
  assert.equal(off.status, 200, "the admin route must never gate itself");
  assert.equal((await off.json()).maintenance.on, false);

  const live = await fetch(`${BASE}/api/batches?page=1`);
  assert.equal(live.status, 200, "turning it off must bring the site back");
});

test("the wall ships in the every-page module and exempts the admin", async () => {
  const boot = await readFile(path.join(ROOT, "public/assets/offline-boot.js"), "utf8");
  assert.match(boot, /action=maintenance/, "the wall must poll the public status read");
  assert.match(boot, /maintenance-wall/, "the wall must be a wall, not a banner");
  assert.match(boot, /\/admin/, "the admin surface must be exempt — it holds the off switch");
});
