/* =========================================================================
   The download key gate, in the browser.

   A visitor needs a key before a lecture can be saved. Getting one is: ask the
   server for a signed challenge → wait the number of seconds the server names
   (or clear a sponsor page, when one is configured) → claim a key that lasts
   until it expires.

   Three rules this file exists to keep:

     · the wait is the *server's* number, not a client guess. Faking a `setTimeout`
       cannot mint a key, because `claim` refuses a challenge that has not aged.
       The countdown here is only so the page can tell the truth while waiting.
     · the key is kept in `localStorage`, so a reload does not cost another wait,
       and it is re-verified against the server before every download — an
       expired key is discovered before a two-hour download, not after it.
     · nothing here is trusted by the download route. This is a gate on the page,
       not an authorisation to fetch media; the route itself stays open so the
       player can stream. That is stated plainly in the README, because a gate
       that pretends to be a lock is worse than an honest speed bump.
   ========================================================================= */

const STORAGE_KEY = "downloadKey";

/** How many milliseconds are left on a key record, or 0. */
function msLeft(record, now = Date.now()) {
  return record && record.expiresAt ? Math.max(0, record.expiresAt - now) : 0;
}

export function readKey() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.key !== "string") return null;
    if (msLeft(parsed) <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeKey(record) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ key: record.key, expiresAt: record.expiresAt, savedAt: Date.now() })
    );
  } catch {
    /* storage disabled: the key still works for this page view */
  }
}

export function forgetKey() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to forget */
  }
}

/** "6h 12m" — how long a key has left, for a label. */
export function fmtLeft(record) {
  const left = msLeft(record);
  if (!left) return "expired";
  const minutes = Math.ceil(left / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 1) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

/* --------------------------------- talking -------------------------------- */

async function call(params) {
  const query = new URLSearchParams(params);
  const res = await fetch(`/api/key?${query.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) throw new Error("The key service did not answer.");
  return body;
}

/** What this deployment requires, so the page can describe it accurately. */
export async function keyStatus() {
  const body = await call({});
  return {
    ok: Boolean(body && body.success),
    mode: body.mode || "wait",
    waitSeconds: Number(body.waitSeconds) || 0,
    ttlHours: Number(body.ttlHours) || 24,
    sponsorHost: body.sponsorHost || "",
  };
}

/** Ask the server whether a stored key is still good. */
export async function verifyStoredKey() {
  const record = readKey();
  if (!record) return { valid: false, reason: "none" };
  try {
    const body = await call({ op: "verify", k: record.key });
    if (!body.valid) {
      forgetKey();
      return { valid: false, reason: body.reason || "expired" };
    }
    // The server is the authority on expiry, so keep its answer, not ours.
    if (body.expiresAt && body.expiresAt !== record.expiresAt) {
      storeKey({ key: record.key, expiresAt: body.expiresAt });
    }
    return { valid: true, msLeft: body.msLeft || msLeft(record), record: readKey() };
  } catch {
    // Offline: an unexpired stored key is still usable. Refusing to download a
    // lecture because the *verification* call failed would be its own failure.
    return { valid: msLeft(record) > 0, reason: "unverified", record };
  }
}

/* -------------------------------- generating ------------------------------- */

/**
 * Wait out the challenge and collect the key.
 *
 * `onTick` receives `{ secondsLeft, total, phase }` so a caller can draw a bar.
 * `phase` is `waiting`, `claiming`, or `done`.
 */
export async function generateKey({ onTick = () => {}, signal } = {}) {
  const start = await call({ op: "start" });
  if (!start.success) throw new Error(start.error || "Could not start a key request.");

  // A sponsor/shortlink, when configured: the visitor clears it and comes back
  // to this same tab. Opened in a new tab so a phone that kills the page still
  // has the challenge here.
  if (start.sponsor) {
    try {
      window.open(start.sponsor, "_blank", "noopener,noreferrer");
    } catch {
      /* popup blocked: the wait below still works */
    }
  }

  const total = Math.max(0, Number(start.waitSeconds) || 0);
  const beganAt = Date.now();
  onTick({ secondsLeft: total, total, phase: "waiting" });

  for (;;) {
    if (signal && signal.aborted) throw new Error("Cancelled");
    const elapsed = (Date.now() - beganAt) / 1000;
    const secondsLeft = Math.max(0, Math.ceil(total - elapsed));
    onTick({ secondsLeft, total, phase: "waiting" });
    if (secondsLeft <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  onTick({ secondsLeft: 0, total, phase: "claiming" });
  const claim = await call({ op: "claim", c: start.challenge });
  if (!claim.success) {
    // The server decides whether the wait is over; if it disagrees, believe it.
    if (claim.reason === "wait" && claim.waitMs) {
      const extra = Math.ceil(claim.waitMs / 1000);
      for (let left = extra; left > 0; left -= 1) {
        onTick({ secondsLeft: left, total: Math.max(total, extra), phase: "waiting" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return generateKey({ onTick, signal });
    }
    throw new Error(claim.error || "The key could not be generated.");
  }

  storeKey({ key: claim.key, expiresAt: claim.expiresAt });
  onTick({ secondsLeft: 0, total, phase: "done" });
  return { key: claim.key, expiresAt: claim.expiresAt, ttlHours: claim.ttlHours || 24 };
}
