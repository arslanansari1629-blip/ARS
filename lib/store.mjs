/**
 * A small keyed document store, shared by anything that needs to remember a
 * little JSON between requests: the scanner's cursor, the repair ledger, the
 * schedule's last tick.
 *
 * It is the same three-tier shape the leaderboard uses — Postgres when attached,
 * Upstash Redis when that is what is attached instead, and otherwise one
 * instance's memory — lifted into a function of the key so a second and third
 * caller do not each grow their own copy of the driver code.
 *
 * The honest part matters as much as the storage: `storeName()` never guesses.
 * With nothing attached it answers `"memory"`, and every panel that shows it
 * says "this instance" rather than pretending the state is shared.
 */

const memory = new Map();

/** The backend used by the most recent read or write, for the panel. */
let lastStore = "memory";

export function storeName() {
  return lastStore;
}

/**
 * Vercel Postgres / Neon via the HTTP SQL endpoint, when one is attached.
 * The table is created on first use, so attaching storage needs no migration.
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

async function pgQuery(conn, text) {
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

/** Neon's HTTP endpoint answers `[{v}]`; a REST wrapper answers `{rows:[{v}]}`. */
function pickValue(body) {
  if (!body) return null;
  if (Array.isArray(body)) return body[0]?.v ?? null;
  if (Array.isArray(body.rows)) return body.rows[0]?.v ?? null;
  if (body.v !== undefined) return body.v;
  return null;
}

const quote = (json) => json.replace(/'/g, "''");

export async function readDoc(key) {
  const pg = postgres();
  if (pg) {
    try {
      await pgQuery(
        pg,
        "create table if not exists arsvibe_docs (k text primary key, v jsonb not null, at timestamptz default now())"
      );
      const out = await pgQuery(pg, `select v from arsvibe_docs where k = '${quote(key)}'`);
      lastStore = "postgres";
      const value = pickValue(out);
      return value && typeof value === "object" ? value : null;
    } catch {
      /* fall through to the next backend rather than failing the caller */
    }
  }

  const kv = redis();
  if (kv) {
    try {
      const res = await fetch(`${kv.url}/get/${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${kv.token}` },
        signal: AbortSignal.timeout(6000),
      });
      const body = await res.json().catch(() => null);
      lastStore = "redis";
      const raw = body?.result;
      if (!raw) return null;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      /* same: memory is the last resort, not an error page */
    }
  }

  lastStore = "memory";
  return memory.get(key) || null;
}

export async function writeDoc(key, doc) {
  const json = JSON.stringify(doc);
  const pg = postgres();
  if (pg) {
    try {
      await pgQuery(
        pg,
        `insert into arsvibe_docs (k, v) values ('${quote(key)}', '${quote(json)}'::jsonb)
         on conflict (k) do update set v = excluded.v, at = now()`
      );
      lastStore = "postgres";
      return "postgres";
    } catch {
      /* fall through */
    }
  }

  const kv = redis();
  if (kv) {
    try {
      const res = await fetch(`${kv.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
        body: JSON.stringify(json),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        lastStore = "redis";
        return "redis";
      }
    } catch {
      /* fall through */
    }
  }

  memory.set(key, doc);
  lastStore = "memory";
  return "memory";
}

/** Whether whatever is attached actually survives a cold start. */
export function persistent() {
  return Boolean(postgres() || redis());
}

/** Tests only: forget the memory tier. */
export function resetStore() {
  memory.clear();
  lastStore = "memory";
}
