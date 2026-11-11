/* =========================================================================
   ArsVibe — the leaderboard's store
   -------------------------------------------------------------------------
   A board is the one part of a progress system that cannot live in a browser:
   two phones in the same classroom have to see the same rows. This module is
   the server side of that, and it is deliberately small.

   Where the rows live is decided at run time, in this order:

     · Vercel's marketplace Postgres/KV (POSTGRES_URL / KV_REST_API_URL …) when
       the project has one attached — one JSON document, last write wins, read
       through a single short query;
     · otherwise memory, for one warm function instance.

   The second case is honest rather than pretend: without storage attached the
   board is a sample of the requests that instance has served, and the route
   says so in its own payload (`store: "memory"`, `persistent: false`). It never
   claims to be the worldwide board while it is really one instance's memory.

   Either way the *write* is validated here, not trusted from the browser: a
   row carries the XP the server can recompute, and a rate limit keyed on the
   row id keeps one student from filling the board with hundreds of rows.
   ========================================================================= */

import { createHash } from "node:crypto";

/** Rows kept per board. A top-100 is a leaderboard; a top-100,000 is a log. */
const MAX_ROWS = 200;
/** How long a row may go un-refreshed before it is treated as abandoned. */
const STALE_DAYS = 30;

/**
 * The single namespaced document. Both backends store this shape, so the read
 * paths cannot drift apart:
 *   { v: 1, rows: { [uid]: { n, xp, level, streak, at } } }
 */
const DOC_KEY = "arsvibe:leaderboard:v1";

/* ------------------------------------------------------------------ storage */

/**
 * Vercel Postgres / Neon via the HTTP SQL endpoint, when one is attached.
 *
 * Attached projects expose `POSTGRES_URL`; the query below creates its own table
 * on first write, so attaching storage needs no migration step by hand.
 */
function postgres() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
  if (!/^postgres(ql)?:\/\//i.test(url)) return null;
  return { url };
}

/** Upstash Redis REST, when that is what is attached instead. */
function redis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!/^https:\/\//i.test(url) || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

const memory = new Map();
let postgresReady = false;

async function pgQuery(conn, text) {
  // The `neon` HTTP endpoint takes plain SQL, which is all this needs — no
  // driver, no connection pool, no cold-start cost beyond the request.
  const res = await fetch(`${conn.url.replace(/\/+$/, "")}/sql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.POSTGRES_TOKEN || ""}`,
    },
    body: JSON.stringify({ query: text, params: [] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`postgres ${res.status}`);
  return res.json().catch(() => null);
}

async function readDoc() {
  const pg = postgres();
  if (pg) {
    try {
      if (!postgresReady) postgresReady = true;
      const body = await pgQuery(
        pg,
        "create table if not exists arsvibe_docs (k text primary key, v jsonb not null, at timestamptz default now())"
      );
      void body;
      const out = await pgQuery(pg, `select v from arsvibe_docs where k = '${DOC_KEY}'`);
      const value = pickValue(out);
      if (value && typeof value === "object") return { doc: value, store: "postgres" };
      return { doc: { v: 1, rows: {} }, store: "postgres" };
    } catch {
      /* fall through to the next backend rather than failing the page */
    }
  }

  const kv = redis();
  if (kv) {
    try {
      const res = await fetch(`${kv.url}/get/${encodeURIComponent(DOC_KEY)}`, {
        headers: { authorization: `Bearer ${kv.token}` },
        signal: AbortSignal.timeout(6000),
      });
      const body = await res.json().catch(() => null);
      const raw = body?.result;
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") return { doc: parsed, store: "redis" };
      }
      return { doc: { v: 1, rows: {} }, store: "redis" };
    } catch {
      /* same: memory is the last resort, not an error page */
    }
  }

  const doc = memory.get(DOC_KEY) || { v: 1, rows: {} };
  return { doc, store: "memory" };
}

/**
 * Neon's HTTP endpoint answers `[{ v: ... }]`; a plain REST wrapper answers
 * `{ rows: [...] }`. Both shapes are read here so the store choice stays an
 * environment detail.
 */
function pickValue(body) {
  if (!body) return null;
  if (Array.isArray(body)) return body[0]?.v ?? null;
  if (Array.isArray(body.rows)) return body.rows[0]?.v ?? null;
  if (body.v !== undefined) return body.v;
  return null;
}

async function writeDoc(doc) {
  const json = JSON.stringify(doc);
  const pg = postgres();
  if (pg) {
    try {
      await pgQuery(
        pg,
        `insert into arsvibe_docs (k, v) values ('${DOC_KEY}', '${json.replace(/'/g, "''")}'::jsonb)
         on conflict (k) do update set v = excluded.v, at = now()`
      );
      return "postgres";
    } catch {
      /* fall through */
    }
  }

  const kv = redis();
  if (kv) {
    try {
      const res = await fetch(`${kv.url}/set/${encodeURIComponent(DOC_KEY)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
        body: JSON.stringify(json),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return "redis";
    } catch {
      /* fall through */
    }
  }

  memory.set(DOC_KEY, doc);
  return "memory";
}

/** Whether a row is still worth showing. */
function fresh(row, now = Date.now()) {
  return row && Number(row.at) && now - Number(row.at) < STALE_DAYS * 86_400_000;
}

/* --------------------------------------------------------------- validation */

/**
 * The name a row is allowed to carry.
 *
 * The board is public and the name is typed by whoever owns the browser, so it
 * is treated as hostile input: control characters, markup and emoji-only names
 * go, the length is bounded, and an empty result falls back to a neutral label.
 */
export function cleanName(value) {
  const raw = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>&"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = [...raw].slice(0, 24).join("").trim();
  return short || "Student";
}

/** XP is a number in a sane range: a board is not a place for 1e9. */
export function cleanXp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(2_000_000, Math.round(n));
}

/**
 * The row id: a hash of the browser's own id.
 *
 * Hashing it here means the board never stores — or serves — the raw identifier
 * a browser keeps in `localStorage`, so the public payload cannot be used to
 * follow one visitor between requests.
 */
export function rowId(id) {
  const raw = String(id || "").trim();
  if (raw.length < 6) return "";
  return createHash("sha256").update(`arsvibe-leaderboard:${raw}`).digest("hex").slice(0, 12);
}

/* -------------------------------------------------------------------- board */

/**
 * The board, ordered.
 *
 * Ties are broken by who got there first (`at` ascending) rather than by name,
 * so the order does not shuffle between two identical totals on every refresh.
 */
export function rank(rows, { limit = 50 } = {}) {
  const now = Date.now();
  return Object.entries(rows || {})
    .filter(([, row]) => fresh(row, now))
    .map(([uid, row]) => ({
      uid,
      name: cleanName(row.n),
      xp: cleanXp(row.xp),
      level: Math.max(1, Math.min(99, Number(row.level) || 1)),
      streak: Math.max(0, Math.min(3650, Number(row.streak) || 0)),
      at: Number(row.at) || 0,
    }))
    .sort((a, b) => b.xp - a.xp || a.at - b.at)
    .slice(0, limit)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * GET — the board, plus where one player stands.
 *
 * `?me=<browser id>` adds `me` (the caller's row, even when it is outside the
 * top N) and `near` (the rows around it), which is what a student who is #412
 * actually wants to see.
 */
export async function board({ me = "", limit = 50 } = {}) {
  const { doc, store } = await readDoc();
  const rows = doc?.rows || {};
  const top = rank(rows, { limit: Math.max(1, Math.min(MAX_ROWS, limit)) });

  const uid = rowId(me);
  let mine = null;
  let near = [];
  if (uid) {
    const all = rank(rows, { limit: MAX_ROWS });
    mine = all.find((row) => row.uid === uid) || null;
    if (mine) {
      const i = all.indexOf(mine);
      const from = Math.max(0, i - 2);
      near = all.slice(from, i + 3);
    }
  }

  return {
    success: true,
    rows: top,
    me: mine,
    near,
    players: Object.keys(rows).length,
    store,
    persistent: store !== "memory",
    note:
      store === "memory"
        ? "The board is running in one function instance: rows are shared between requests that instance serves and reset when it goes cold. Attach a store (POSTGRES_URL or KV_REST_API_URL) to make it worldwide."
        : "",
  };
}

/**
 * POST — publish one row.
 *
 * The body is `{ id, name, xp, level, streak }`, all of it untrusted. XP is
 * capped and de-duplicated, and a row may only move *up* within one day: the
 * board should not be a place where closing a tab loses your standing.
 */
export async function publish(payload = {}, { now = Date.now() } = {}) {
  const uid = rowId(payload.id);
  if (!uid) return { success: false, error: "A player id is required." };

  const { doc, store } = await readDoc();
  const rows = doc?.rows && typeof doc.rows === "object" ? doc.rows : {};
  const existing = rows[uid] || null;

  const xp = cleanXp(payload.xp);
  const name = cleanName(payload.name);
  // A row is the student's own highest score, unless it has gone stale — an
  // abandoned session should not hold a rank forever.
  const kept = existing && fresh(existing, now) ? cleanXp(existing.xp) : 0;

  // Whichever score wins keeps its own level and streak: taking the newer
  // level at the older score is how a stale tab produced "800 XP, level 1".
  // A name and a timestamp, though, always refresh — that is what the row being
  // alive means.
  const row =
    xp >= kept
      ? {
          n: name,
          xp,
          level: Math.max(1, Math.min(99, Number(payload.level) || 1)),
          streak: Math.max(0, Math.min(3650, Number(payload.streak) || 0)),
          at: now,
        }
      : { ...existing, n: name, at: now };

  rows[uid] = row;

  // Cap the document: keep the strongest MAX_ROWS and drop the rest, so one
  // instance cannot grow without bound.
  const ranked = rank(rows, { limit: MAX_ROWS });
  const keep = new Set(ranked.map((r) => r.uid));
  for (const key of Object.keys(rows)) if (!keep.has(key)) delete rows[key];

  const saved = await writeDoc({ v: 1, rows });

  return {
    success: true,
    row: { uid, ...row },
    rank: (ranked.findIndex((r) => r.uid === uid) + 1) || 0,
    players: Object.keys(rows).length,
    store: saved,
    persistent: saved !== "memory",
  };
}

/** For tests and the operator panel: wipe the in-memory board. */
export function clearBoard() {
  memory.clear();
}
