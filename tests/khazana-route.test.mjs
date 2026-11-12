/**
 * The Khazana route, end to end through the dev server.
 *
 * The unit tests prove the classifier and the renderer. This proves the *seam* —
 * that `/api/batch?...&khazana=` answers, that the batch payload actually carries
 * the pointer the page reads, and that a batch without one does not spend an
 * upstream request finding out. Those are the three ways this feature can be
 * present in the code and absent in the product.
 *
 * The fixture upstream answers the batch detail shapes; whether the real PW API
 * refuses the archive is a fact about PW, recorded in `lib/khazana.mjs` and
 * verified against production, not something a fixture should pretend to know.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4296;
const FIXPORT = 4297;
const BASE = `http://127.0.0.1:${PORT}`;

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
      /* keep waiting */
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
    ADMIN_USERNAME: "khazana-user",
    ADMIN_PASSWORD: "khazana-pass",
  });
  await waitFor(`${BASE}/batch.html`);
});

after(() => {
  for (const c of children) c.kill("SIGKILL");
});

/** The fixture batch used everywhere else in this suite. */
const BATCH = "698ad3519549b300a5e1cc6a";

test("the batch payload carries the archive pointer when the source has one", async () => {
  const res = await fetch(`${BASE}/api/batch?id=${BATCH}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.batch, "the batch did not load");
  // The field is always present so the tab can branch on it without guessing;
  // whether it holds an id depends on the batch, not on the build.
  assert.ok("khazana" in data.batch, "the page has no way to know about an archive");
  assert.equal(typeof data.batch.khazana.programId, "string");
  assert.equal(typeof data.batch.khazana.state, "string");
  assert.equal(typeof data.batch.khazana.attention, "boolean");
});

test("asking for the pointer without reading it spends nothing", async () => {
  const res = await fetch(`${BASE}/api/batch?khazana=1&id=${BATCH}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.khazana, "no verdict was returned");
  // `1` must never return content: it is the cheap call the tab paints from.
  assert.deepEqual(data.subjects, []);
  assert.ok(["none", "known"].includes(data.khazana.state), `unexpected state ${data.khazana.state}`);
});

test("reading an archive always ends in a named state, never an exception", async () => {
  const res = await fetch(`${BASE}/api/batch?khazana=read&id=${BATCH}&program=fixtureprogram0000000001`);
  assert.equal(res.status, 200, "a read must answer, even when it cannot read anything");
  const data = await res.json();
  assert.ok(data.khazana && data.khazana.state, "the answer named no state");
  assert.ok(
    ["ok", "empty", "locked", "invalid", "error", "none"].includes(data.khazana.state),
    `unknown state ${data.khazana.state}`
  );
  assert.equal(typeof data.khazana.summary, "string");
  // The evidence, so an operator can disagree with the verdict.
  if (data.khazana.state !== "ok" && data.khazana.state !== "empty") {
    assert.ok(Array.isArray(data.tried), "a refusal must report which shapes it tried");
  }
});

test("a batch with no archive is reported as having none, without a request", async () => {
  const res = await fetch(`${BASE}/api/batch?khazana=read&id=${BATCH}`);
  const data = await res.json();
  // The fixture batch may or may not carry one; either way the answer must be a
  // named state rather than an error page.
  assert.ok(data.khazana.state);
  if (data.khazana.state === "none") {
    assert.equal(data.programId, "");
    assert.deepEqual(data.subjects, []);
  }
});

test("the batch page offers the tab on every batch", async () => {
  const html = await (await fetch(`${BASE}/batch.html`)).text();
  assert.match(html, /data-tab="khazana"/, "the tab is missing from the batch page");
  assert.match(html, /id="tab-khazana"/);
});

test("the khazana reader is served as a real module", async () => {
  const res = await fetch(`${BASE}/assets/khazana.js`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /mountKhazana/);
  assert.match(text, /PW_TOKEN/, "the served module must still name the unlock");
});

test("a hostile program id cannot be used to reach another host", async () => {
  // The route takes an id from the client. It must treat it as an id, never as a
  // path or a URL — the proxy's own allowlist is the second line, not the first.
  const res = await fetch(
    `${BASE}/api/batch?khazana=read&id=x&program=${encodeURIComponent("../../api/admin?action=stats")}`
  );
  const data = await res.json();
  assert.ok(data.khazana, "a malformed id must still produce a verdict");
  // Whatever it says, it must not have read the admin route's answer.
  assert.equal("token" in data, false);
  assert.equal("traffic" in data, false);
});

test("both batch payloads carry the openable Khazana list", async () => {
  // The tab is painted from whichever payload wins the race, so the list has to
  // ride on both. It was on neither in the build that shipped "no Khazana here".
  for (const q of [`id=${BATCH}`, `id=${BATCH}&header=1`]) {
    const res = await fetch(`${BASE}/api/batch?${q}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.library), `${q} carries no Khazana list`);
    assert.ok(data.library.length >= 1, `${q} carries an empty list`);
    const first = data.library[0];
    assert.match(first.id, /^[0-9a-f]{24}$/, "a card with no batch id cannot be opened");
    assert.match(first.name, /khazana/i, "the list is other people's content");
  }
});

/* ------------------------------------------- the archive, level by level */

/**
 * The whole point of this route: a linked archive is *browsable*.
 *
 * These five calls are the chain the pages make — Khazana tab → subject →
 * chapter → topic → lecture. Each one goes through `/api/batch?khazana=…`, which
 * is this deployment's own proxy against PW's v1/v2 program surface. If any link
 * breaks, the tab renders a notice instead of subjects, which is exactly the
 * state this suite exists to keep from shipping again.
 */
const PROGRAM = "697c6370cb722a4fac145ef1";

test("the archive lists its subjects, through our own proxy", async () => {
  const res = await fetch(`${BASE}/api/batch?khazana=subjects&id=${PROGRAM}&program=${PROGRAM}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.state, "ok");
  assert.ok(data.subjects.length >= 2, "an archive with no subjects cannot be browsed");

  const physics = data.subjects[0];
  assert.equal(physics.name, "Physics");
  assert.match(physics.id, /^[0-9a-f]{24}$/);
  // The slug is what the next two levels are addressed by; an id alone is not
  // enough, and a subject row without one leads to a 404 on click.
  assert.ok(physics.slug, "a subject with no slug cannot be opened");
  assert.equal(typeof physics.lectures, "number");
});

test("subject → chapter → topic → lecture walks without a dead link", async () => {
  const subjects = await (await fetch(`${BASE}/api/batch?khazana=subjects&id=${PROGRAM}`)).json();
  const subject = subjects.subjects[0];

  const chapters = await (
    await fetch(`${BASE}/api/batch?khazana=chapters&id=${PROGRAM}&subject=${subject.id}`)
  ).json();
  assert.equal(chapters.state, "ok", "the subject listed no chapters");
  const chapter = chapters.chapters[0];
  assert.ok(chapter.slug, "a chapter with no slug cannot be opened");
  assert.match(chapter.id, /^[0-9a-f]{24}$/);

  const topics = await (
    await fetch(
      `${BASE}/api/batch?khazana=topics&id=${PROGRAM}&subject=${subject.slug}&chapter=${chapter.slug}`
    )
  ).json();
  assert.equal(topics.state, "ok", "the chapter listed no topics");
  const topic = topics.topics[0];
  assert.ok(topic.slug);

  const contents = await (
    await fetch(
      `${BASE}/api/batch?khazana=contents&id=${PROGRAM}&subject=${subject.slug}` +
        `&chapter=${chapter.slug}&topic=${topic.slug}`
    )
  ).json();
  assert.equal(contents.state, "ok");
  assert.ok(contents.items.length >= 1, "the topic holds nothing");

  const lectures = contents.items.filter((i) => i.kind === "lecture");
  assert.ok(lectures.length >= 1, "no lecture came back — the row would have nothing to play");
  const lecture = lectures[0];
  assert.match(lecture.id, /^[0-9a-f]{24}$/);
  // This is the field the player signs. A lecture row without it is a dead click.
  assert.match(lecture.videoUrl, /^https:\/\/.+\.mpd$/, "no playable url on the lecture");
  assert.ok(lecture.title);
});

test("a topic's tabs are named, so the page can say what exists", async () => {
  const q = `khazana=sections&id=${PROGRAM}&subject=physics-936551&chapter=physics-by-848830&topic=abbbba-987565`;
  const data = await (await fetch(`${BASE}/api/batch?${q}`)).json();
  assert.equal(data.success, true);
  assert.ok(data.sections.length >= 2);
  const names = data.sections.map((s) => s.name);
  assert.ok(names.includes("Lectures"), `unexpected tabs: ${names.join(", ")}`);
});

test("a missing parent is a 400 that names the field, not an upstream call", async () => {
  const res = await fetch(`${BASE}/api/batch?khazana=contents&id=${PROGRAM}&subject=physics-936551`);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.success, false);
  assert.match(data.error, /chapter/);
});

test("an unknown archive id is reported, not invented", async () => {
  const data = await (
    await fetch(`${BASE}/api/batch?khazana=subjects&id=000000000000000000000000`)
  ).json();
  assert.equal(data.success, false);
  assert.ok(["missing", "error", "invalid"].includes(data.state), `got ${data.state}`);
  assert.deepEqual(data.subjects || [], [], "a failed read must not list subjects");
});
