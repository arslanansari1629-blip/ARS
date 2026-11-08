/**
 * Regression test: PW list responses return class-note / DPP attachments with
 * an empty storage `key`. The API layer must resolve them through GetPdf so the
 * UI gets a real PDF URL instead of a placeholder row.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4200;
const FIXPORT = 4201;
const BASE = `http://127.0.0.1:${PORT}`;

const BATCH = "698ad3519549b300a5e1cc6a";
const SUBJECT = "physics-by-saleem-ahmad-sir-886822";
const CHAPTER = "6a6b461cce4ac4e9ab51ee98";

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

before(async () => {
  start(["scripts/fixture-upstream.mjs"], { FIXTURE_PORT: String(FIXPORT) });
  await waitFor(`http://127.0.0.1:${FIXPORT}/AllBatches?page=1`);
  start(["scripts/dev.mjs"], {
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PW_UPSTREAM_BASE: `http://127.0.0.1:${FIXPORT}`,
  });
  await waitFor(`${BASE}/`);
});

after(() => {
  for (const child of children) child.kill("SIGTERM");
});

test("notes with an empty attachment key are resolved via GetPdf", async () => {
  const res = await fetch(
    `${BASE}/api/contents?batch=${BATCH}&subject=${SUBJECT}&topic=${CHAPTER}&type=notes`
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.items) && data.items.length >= 1);
  assert.equal(data.items[0].kind, "notes");

  const docs = data.items[0].docs;
  assert.equal(docs.length, 1, `expected one resolved PDF, got ${docs.length}`);
  assert.match(
    docs[0].url,
    /^https:\/\/static\.pw\.live\/5eb393ee95fab7468a79d189\/ADMIN\/7a2b3197-71da-4d2b-ba3c-e5a24721fffa\.pdf$/
  );
  assert.match(docs[0].name, /Class Notes\.pdf$/);
  assert.match(data.items[0].title, /Class Notes/);
});

test("note rows never come back with an unusable url", async () => {
  const res = await fetch(
    `${BASE}/api/contents?batch=${BATCH}&subject=${SUBJECT}&topic=${CHAPTER}&type=DppNotes`
  );
  const data = await res.json();
  for (const item of data.items || []) {
    for (const doc of item.docs || []) {
      assert.match(doc.url, /^https?:\/\//, `bad doc url for ${doc.name}`);
    }
  }
});
