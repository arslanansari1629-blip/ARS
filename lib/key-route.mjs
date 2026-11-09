import { cors, json, query } from "../lib/http.mjs";
import {
  checkChallenge,
  checkRate,
  clientKey,
  keyConfig,
  mintChallenge,
  mintKey,
  noteKeyIssued,
  resetRateLimits,
  rewardUrl,
  verifyKey,
} from "../lib/keys.mjs";

/**
 * GET /api/key                    → what the gate requires, and the minimum wait
 * GET /api/key?op=start           → a signed challenge to wait against
 * GET /api/key?op=claim&c=…       → a download key, once the wait is over
 * GET /api/key?op=verify&k=…      → is this key still good?
 *
 * (`?action=start` and friends also work when the route is called directly as
 * `/api/check?action=key`; the router uses `action` for its own marker.)
 *
 * The gate in front of downloads. A visitor asks to start, waits the published
 * number of seconds (or clears an optional sponsor/shortlink page), then claims a
 * key that is good for every lecture until it expires.
 *
 * The endpoint that matters is `claim`: it is the only place a key is minted, and
 * it refuses a challenge that has not aged. Everything else is bookkeeping so the
 * page can tell the truth about how long is left rather than guessing.
 *
 * Mounted on `api/check.mjs`, which already answers a GET and is one of the ten
 * functions the Hobby plan allows. Vercel routes `/api/key` here; the function's
 * own `/api/check` behaviour is untouched.
 */

/** The gate, as the download page needs to describe it before anyone waits. */
function describe() {
  const config = keyConfig();
  return {
    success: true,
    required: true,
    mode: config.mode,
    waitSeconds: config.waitSeconds,
    ttlHours: config.ttlHours,
    // Shown to the visitor when a sponsor page is configured, so the button can
    // say where it goes instead of surprising them.
    sponsorHost: config.mode === "reward" ? hostOf() : "",
  };
}

function hostOf() {
  try {
    return new URL(rewardUrl("x")).host;
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return json(res, 405, { success: false, error: "Method not allowed" });

  const params = query(req);
  // `/api/key` is rewritten onto `/api/check?action=key`, so the *operation* has
  // to live in its own parameter — reading `action` here made every request look
  // like the router's own marker and nothing was ever minted.
  const named = String(params.action || "").toLowerCase();
  const action = String(params.op || (named === "key" || named === "gate" ? "" : named)).toLowerCase();
  const ip = clientKey(req);

  try {
    if (!action || action === "status" || action === "config") {
      return json(res, 200, describe());
    }

    if (action === "start") {
      const rate = checkRate(ip);
      if (!rate.allowed) {
        return json(res, 429, {
          success: false,
          error:
            rate.reason === "hour"
              ? "That is a lot of keys in one hour. Try again a little later."
              : "That is today's worth of keys. Come back tomorrow.",
          retryAfterMs: rate.retryAfterMs,
        });
      }
      const challenge = mintChallenge();
      const sponsor = rewardUrl(challenge);
      return json(res, 200, {
        success: true,
        challenge,
        waitSeconds: waitMsForTable(),
        ...(sponsor ? { sponsor } : {}),
      });
    }

    if (action === "claim") {
      const token = params.c || params.challenge || "";
      const verdict = checkChallenge(token);
      if (!verdict.ok) {
        return json(res, 200, {
          success: false,
          error:
            verdict.reason === "wait"
              ? "The wait is not over yet."
              : verdict.reason === "expired"
                ? "That key request expired. Start again."
                : "That key request is not valid. Start again.",
          reason: verdict.reason,
          waitMs: verdict.waitMs || 0,
        });
      }

      const rate = checkRate(ip);
      if (!rate.allowed) {
        return json(res, 429, {
          success: false,
          error:
            rate.reason === "hour"
              ? "That is a lot of keys in one hour. Try again a little later."
              : "That is today's worth of keys. Come back tomorrow.",
          retryAfterMs: rate.retryAfterMs,
        });
      }

      noteKeyIssued(ip);
      const minted = mintKey();
      return json(res, 200, {
        success: true,
        key: minted.key,
        expiresAt: minted.expiresAt,
        expiresInMs: minted.ttlMs,
        ttlHours: keyConfig().ttlHours,
      });
    }

    if (action === "verify") {
      const verdict = verifyKey(params.k || params.key || "");
      return json(res, 200, {
        success: true,
        valid: verdict.ok,
        reason: verdict.reason || "",
        expiresAt: verdict.expiresAt || 0,
        msLeft: Math.max(0, verdict.msLeft || 0),
      });
    }

    // Test-only: counters live in memory per instance, so a suite that mints more
    // than the hourly policy needs a way back to zero.
    if (action === "reset" && typeof process !== "undefined" && process.env.ARSVIBE_TEST_RESET === "1") {
      resetRateLimits();
      return json(res, 200, { success: true });
    }

    return json(res, 400, {
      success: false,
      error: "Unknown action. Use start, claim, or verify.",
    });
  } catch (err) {
    return json(res, 500, {
      success: false,
      error: err?.message || "The key service is not answering.",
    });
  }
}

/** Kept next to `describe` so the two can never drift apart. */
function waitMsForTable() {
  return keyConfig().waitSeconds;
}
