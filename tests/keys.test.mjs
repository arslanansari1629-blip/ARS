/**
 * The download key gate.
 *
 * Two things are worth testing here, and they are different in kind:
 *
 *   1. the arithmetic — a key expires when it says, a challenge is only
 *      redeemable after the wait, a forged signature never passes. This is the
 *      part that can be *wrong*, so it is tested directly against a fixed clock.
 *   2. the gate is real over HTTP — the route is wired, the operation parameter
 *      is not swallowed by the router's own `action`, and a key minted through
 *      the endpoint verifies afterwards.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const HOUR = 60 * 60 * 1000;
const SECRET = "test-secret-for-the-key-gate";

process.env.DOWNLOAD_KEY_SECRET = SECRET;
// A real wait for the arithmetic below. The HTTP server further down overrides it
// for its own child process only — setting it here would otherwise make the
// "wait cannot be skipped" test pass for the wrong reason (a zero-second gate).
process.env.DOWNLOAD_KEY_WAIT_SECONDS = "30";

const keys = await import("../lib/keys.mjs");

/* --------------------------------- signing -------------------------------- */

/** What a key looks like when it is minted at `expiresAt` with this secret. */
function sign(value, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("base64url").slice(0, 32);
}

test("a minted key is good until its own expiry, and not a moment longer", () => {
  const now = 1_800_000_000_000;
  const { key, expiresAt } = keys.mintKey(now);

  assert.equal(expiresAt, now + keys.ttlMs());
  assert.match(key, /^d\.\d+\.[A-Za-z0-9_-]{32}$/);

  const fresh = keys.verifyKey(key, now);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.expiresAt, expiresAt);

  // One second before it dies it still works…
  assert.equal(keys.verifyKey(key, expiresAt - 1000).ok, true);
  // …and at the moment it dies it does not.
  const dead = keys.verifyKey(key, expiresAt);
  assert.equal(dead.ok, false);
  assert.equal(dead.reason, "expired");
});

test("a key tells the page how long it has left instead of leaving it to guess", () => {
  const now = 1_800_000_000_000;
  const { key } = keys.mintKey(now);
  const verdict = keys.verifyKey(key, now);
  assert.equal(verdict.msLeft, keys.ttlMs());
});

test("a key forged with the wrong secret never passes, even with a valid shape", () => {
  const now = Date.now();
  const expiresAt = now + HOUR;
  const forged = `d.${expiresAt}.${sign(`d.${expiresAt}`, "not-our-secret")}`;
  assert.equal(keys.verifyKey(forged, now).ok, false);
  assert.equal(keys.verifyKey(forged, now).reason, "bad-key");
});

test("a key cannot have its expiry edited, because the signature covers it", () => {
  const now = Date.now();
  const { key } = keys.mintKey(now);
  const [, , signature] = key.split(".");
  const extended = `d.${now + 30 * 24 * HOUR}.${signature}`;
  assert.equal(keys.verifyKey(extended, now).ok, false);
});

test("junk is refused rather than throwing", () => {
  for (const value of ["", "x", "d", "d.1", "d.abc.def", "c.1.2", null, undefined, "d.1.2.3"]) {
    const verdict = keys.verifyKey(value, Date.now());
    assert.equal(verdict.ok, false, `${value} was accepted`);
  }
});

/* -------------------------------- the wait -------------------------------- */

test("the wait cannot be skipped by redeeming a fresh challenge immediately", () => {
  const now = 1_800_000_000_000;
  const challenge = keys.mintChallenge(now);

  const early = keys.checkChallenge(challenge, now + 1000);
  assert.equal(early.ok, false);
  assert.equal(early.reason, "wait");
  // The page counts down from the server's number, not its own.
  assert.ok(early.waitMs > 0, "no wait was reported");

  const due = keys.checkChallenge(challenge, now + keys.waitMs() + 1);
  assert.equal(due.ok, true);
});

test("a stale challenge expires instead of staying redeemable forever", () => {
  const now = 1_800_000_000_000;
  const challenge = keys.mintChallenge(now);
  const late = keys.checkChallenge(challenge, now + 3 * HOUR);
  assert.equal(late.ok, false);
  assert.equal(late.reason, "expired");
});

test("a challenge with a tampered timestamp is not accepted", () => {
  const now = Date.now();
  const challenge = keys.mintChallenge(now);
  const [, , signature] = challenge.split(".");
  const backdated = `c.${now - keys.waitMs() - 1000}.${signature}`;
  const verdict = keys.checkChallenge(backdated, now);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "bad-challenge");
});

/* -------------------------------- the limits ------------------------------- */

test("one visitor cannot mint keys without limit", () => {
  keys.resetRateLimits();
  const now = 1_800_000_000_000;
  const policy = keys.ratePolicy();
  for (let i = 0; i < policy.perHour; i += 1) {
    assert.equal(keys.checkRate("1.2.3.4", now).allowed, true, `key ${i + 1} was refused early`);
    keys.noteKeyIssued("1.2.3.4", now);
  }
  const blocked = keys.checkRate("1.2.3.4", now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "hour");
  assert.ok(blocked.retryAfterMs > 0);

  // A different visitor is unaffected: this is a per-client limit, not a global off switch.
  assert.equal(keys.checkRate("5.6.7.8", now).allowed, true);
  // …and the window rolls over.
  assert.equal(keys.checkRate("1.2.3.4", now + 2 * HOUR).allowed, true);
  keys.resetRateLimits();
});

test("the first hop of x-forwarded-for is the client, not the proxy", () => {
  assert.equal(
    keys.clientKey({ headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" } }),
    "203.0.113.9"
  );
  assert.equal(keys.clientKey({ headers: { "x-real-ip": "198.51.100.4" } }), "198.51.100.4");
  assert.equal(keys.clientKey({ headers: {} }), "unknown");
});

test("the gate reports what it is configured to do, never the secret", () => {
  const config = keys.keyConfig();
  assert.equal(config.ttlHours, 24);
  assert.equal(config.mode, "wait");
  assert.equal(config.secretFromEnv, true);
  // Nothing in the shape of a HMAC or the secret itself.
  assert.equal(JSON.stringify(config).includes(SECRET), false);
  assert.deepEqual(Object.keys(config).sort(), [
    "mode",
    "rate",
    "secretFromEnv",
    "ttlHours",
    "waitSeconds",
  ]);
});

/* ------------------------------- over HTTP -------------------------------- */

const PORT = 4390;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  process.env.PORT = String(PORT);
  process.env.ARSVIBE_TEST_RESET = "1";
  const { spawn } = await import("node:child_process");
  server = spawn(process.execPath, ["scripts/dev.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DOWNLOAD_KEY_WAIT_SECONDS: "0", ARSVIBE_TEST_RESET: "1" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/key`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dev server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(() => {
  if (server) server.kill();
});

test("the gate can be read before anyone asks for a key", async () => {
  const res = await fetch(`${BASE}/api/key`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.required, true);
  assert.equal(body.mode, "wait");
  assert.equal(body.ttlHours, 24);
});

test("a key can be generated through the endpoint and it works afterwards", async () => {
  await fetch(`${BASE}/api/key?op=reset`);

  const start = await (await fetch(`${BASE}/api/key?op=start`)).json();
  assert.equal(start.success, true, JSON.stringify(start));
  assert.match(start.challenge, /^c\./);

  const claim = await (await fetch(`${BASE}/api/key?op=claim&c=${encodeURIComponent(start.challenge)}`)).json();
  assert.equal(claim.success, true, JSON.stringify(claim));
  assert.match(claim.key, /^d\./);
  assert.ok(claim.expiresAt > Date.now());

  const verify = await (
    await fetch(`${BASE}/api/key?op=verify&k=${encodeURIComponent(claim.key)}`)
  ).json();
  assert.equal(verify.valid, true);
  assert.ok(verify.msLeft > 0);
});

test("the gate cannot be skipped by claiming without a challenge", async () => {
  await fetch(`${BASE}/api/key?op=reset`);
  const res = await fetch(`${BASE}/api/key?op=claim`);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.key, undefined, "a key was issued without a challenge");
});

test("a wrong key is reported as invalid, not as an error", async () => {
  const body = await (await fetch(`${BASE}/api/key?op=verify&k=not-a-key`)).json();
  assert.equal(body.success, true);
  assert.equal(body.valid, false);
});

test("the download page and the player both carry the gate", async () => {
  const page = await (await fetch(`${BASE}/assets/downloads-page.js`)).text();
  assert.match(page, /generateKey/, "the page never generates a key");
  assert.match(page, /keyGate/, "the page has no gate to paint");
  assert.match(page, /A download key is needed|Generate a key to download/);

  const lecture = await (await fetch(`${BASE}/assets/lecture.js`)).text();
  assert.match(lecture, /menuDownload/, "the player has no download button");
  assert.match(lecture, /generateKey/, "the player's download button skips the gate");
  const html = await (await fetch(`${BASE}/lecture.html`)).text();
  assert.match(html, /id="menuDownload"/, "the download button is not in the player markup");
});
