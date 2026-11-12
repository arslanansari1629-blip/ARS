/**
 * Khazana — the archive reader.
 *
 * The property that matters here is not "does it return lectures". It cannot, and
 * pretending otherwise is the failure this file exists to prevent. The properties
 * worth pinning are:
 *
 *   1. **Every refusal is classified, not swallowed.** A 401, a 400, a 404 and a
 *      network failure are four different explanations and four different actions.
 *   2. **The reader never reports content it does not have.** An empty answer is
 *      `empty`, a 200 with unusable rows falls through rather than becoming a
 *      successful blank grid.
 *   3. **One refusal does not stop the ladder.** The shapes were tried in order
 *      for a reason: the first shape answering 401 must not prevent a later shape
 *      answering 200.
 *   4. **A batch with no pointer spends nothing.** Most of the catalogue has no
 *      archive, and the reader must not make a request to find that out.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  readArchive,
  classifyAnswer,
  archivePointers,
  archiveVerdict,
  KHAZANA_STATES,
  KHAZANA_ATTENTION,
} from "../lib/khazana.mjs";

/** A probe that answers from a table of path → response. */
function tableProbe(table) {
  const asked = [];
  const probe = async (path) => {
    asked.push(path);
    const hit = table[path];
    if (!hit) return { ok: false, status: 404, data: null, error: "upstream 404" };
    if (typeof hit === "function") return hit();
    return hit;
  };
  probe.asked = asked;
  return probe;
}

const refusal = { ok: false, status: 401, data: null, error: "Upstream answered 401" };
const notFound = { ok: false, status: 404, data: null, error: "Upstream answered 404" };
const badRequest = { ok: false, status: 400, data: null, error: "Invalid Batch" };

/* ------------------------------------------------------------ classification */

test("a 401 is a locked archive, not a failure", () => {
  assert.equal(classifyAnswer(refusal), "locked");
  assert.equal(classifyAnswer({ ok: false, status: 403 }), "locked");
});

test("a 400 and a 404 are different failures", () => {
  // A 400 means the pointer is not a content id; a 404 means this shape does not
  // exist. Only one of them is the source batch's fault.
  assert.equal(classifyAnswer(badRequest), "invalid");
  assert.equal(classifyAnswer(notFound), "missing-shape");
});

test("a 200 with subjects is content", () => {
  assert.equal(
    classifyAnswer({ ok: true, status: 200, data: { data: { subjects: [{ _id: "a" }] } } }),
    "ok"
  );
});

test("a 200 with no subjects is empty, which is not content", () => {
  assert.equal(classifyAnswer({ ok: true, status: 200, data: { data: { subjects: [] } } }), "empty");
});

test("a 200 in a shape this code does not understand is not an answer", () => {
  assert.equal(classifyAnswer({ ok: true, status: 200, data: { data: { somethingElse: 1 } } }), "missing-shape");
});

/* ------------------------------------------------------------------ pointer */

test("the archive pointer is read from the batch document", () => {
  const out = archivePointers({
    khazanaProgramId: "62cc7a39ea773600110bec2f",
    pitaraProgramId: "65409470e66ab5001863bbd8",
  });
  assert.equal(out.khazana, "62cc7a39ea773600110bec2f");
  assert.equal(out.pitara, "65409470e66ab5001863bbd8");
});

test("a batch with no pointer yields an empty one, not 'undefined'", () => {
  assert.deepEqual(archivePointers({}), { khazana: "", pitara: "" });
  assert.deepEqual(archivePointers(null), { khazana: "", pitara: "" });
});

/* -------------------------------------------------------------- reading it */

test("no pointer means no request at all", async () => {
  const probe = tableProbe({});
  const out = await readArchive("", { probe });
  assert.equal(out.state, "none");
  assert.equal(probe.asked.length, 0, "a batch with no archive must not spend a request finding out");
});

test("a live refusal is reported as locked, with the evidence", async () => {
  // This is the real production shape: every content shape answers 401.
  const probe = tableProbe({
    "/v3/batches/X/subjects": refusal,
    "/v3/programs/X/subjects": notFound,
    "/v3/batches/X/details": badRequest,
  });
  const out = await readArchive("X", { probe });

  assert.equal(out.state, "locked", "three shapes, all refused — that is a paid archive");
  assert.equal(out.needsSubscriberToken, true, "the reader has to learn what would unlock it");
  assert.equal(out.subjects.length, 0);
  assert.equal(out.tried.length, 3, "every shape that was tried must be reported");
  assert.ok(out.note.includes("PW_TOKEN"), "the note must name the fix");
});

test("one refusal does not stop a later shape answering content", async () => {
  // The ladder exists precisely because the pointer's type is ambiguous. If the
  // batch shape refuses but the program shape answers, the reader must not give up.
  const probe = tableProbe({
    "/v3/batches/X/subjects": refusal,
    "/v3/programs/X/subjects": {
      ok: true,
      status: 200,
      data: { data: { subjects: [{ _id: "s1", subject: "Physics", slug: "physics", lectureCount: 12 }] } },
    },
  });
  const out = await readArchive("X", { probe });

  assert.equal(out.state, "ok");
  assert.equal(out.subjects.length, 1);
  assert.equal(out.subjects[0].name, "Physics");
  assert.equal(out.subjects[0].archiveId, "X", "every row must know which archive it came from");
});

test("a 200 carrying unusable rows falls through instead of reporting content", async () => {
  const probe = tableProbe({
    "/v3/batches/X/subjects": { ok: true, status: 200, data: { data: { subjects: [{ _id: "no-slug" }] } } },
    "/v3/programs/X/subjects": { ok: true, status: 200, data: { data: { subjects: [] } } },
  });
  const out = await readArchive("X", { probe });
  // The first shape had a row with no slug; a row that cannot be linked is not
  // content. The second answered empty, which is the honest description.
  assert.equal(out.state, "empty");
  assert.equal(out.subjects.length, 0);
});

test("an unreachable archive is an error, and says it is a read failure", async () => {
  const probe = async () => {
    throw new Error("network down");
  };
  const out = await readArchive("X", { probe });
  assert.equal(out.state, "error");
  assert.match(out.note, /network read/i, "a network failure must not be reported as a missing archive");
  assert.equal(out.tried.length, 3);
});

test("a pointer nothing accepts is invalid, not locked", async () => {
  const probe = tableProbe({
    "/v3/batches/X/subjects": badRequest,
    "/v3/programs/X/subjects": notFound,
    "/v3/batches/X/details": badRequest,
  });
  const out = await readArchive("X", { probe });
  assert.equal(out.state, "invalid");
  assert.equal(out.needsSubscriberToken, undefined, "a bad pointer is not fixed by a token");
});

/* ------------------------------------------------------------------ verdict */

test("only the states a person can act on raise attention", () => {
  assert.equal(archiveVerdict({ state: "none" }).attention, false);
  assert.equal(archiveVerdict({ state: "ok" }).attention, false);
  assert.equal(archiveVerdict({ state: "unknown-to-this-build" }).attention, true);
  assert.ok(KHAZANA_ATTENTION.has("locked"));
  assert.ok(KHAZANA_ATTENTION.has("invalid"));
});

test("every state has wording a reader can act on", () => {
  for (const [key, meta] of Object.entries(KHAZANA_STATES)) {
    assert.ok(meta.label, `${key} has no label`);
    assert.ok(meta.short, `${key} has no explanation`);
    assert.ok(meta.short.length > 20, `${key}'s explanation is too terse to be useful`);
  }
});

test("the known state is the one the batch payload reports without spending a request", () => {
  const verdict = archiveVerdict({ state: "known", programId: "abc" });
  assert.equal(verdict.state, "known");
  assert.equal(verdict.attention, false, "a batch carrying an archive is not a fault");
  assert.equal(verdict.needsSubscriberToken, false);
});

/* ------------------------------------------------------------------ rendering */

/*
 * The renderer is where dishonesty would live if it lived anywhere: it is the
 * only part a student sees. These drive the real module against a jsdom document
 * so the assertions are about the markup that ships, not a reimplementation.
 */

// The renderer imports `./app.js`, which imports site-absolute paths; the loader
// shim maps them onto public/ so the shipped module can run in Node.
const { register } = await import("node:module");
register("./loader.mjs", import.meta.url);

const { JSDOM } = await import("jsdom");

function dom() {
  return new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>").window;
}

test("a batch with no archive says so instead of showing an empty grid", async () => {
  const { khazanaMarkup } = await import("../public/assets/khazana.js");
  const html = khazanaMarkup({ khazana: { state: "none" } });
  assert.match(html, /No Khazana archive/);
  assert.equal(/subject-card/.test(html), false, "an empty grid would look like content");
});

test("a paid archive names the reason and the fix, and asks for no subscription", async () => {
  const { khazanaMarkup } = await import("../public/assets/khazana.js");
  const html = khazanaMarkup({
    khazana: { state: "locked", programId: "62cc7a39", needsSubscriberToken: true },
  });
  assert.match(html, /paid content/i);
  assert.match(html, /PW_TOKEN/, "the reader must learn what would unlock it");
  assert.match(html, /62cc7a39/, "the pointer is the evidence for the verdict");
  assert.equal(/subject-card/.test(html), false);
});

test("the reading state is visibly different from the refused state", async () => {
  const { khazanaMarkup } = await import("../public/assets/khazana.js");
  const reading = khazanaMarkup({ khazana: { state: "known" }, reading: true });
  const refused = khazanaMarkup({ khazana: { state: "locked" } });
  assert.match(reading, /Reading the archive/);
  assert.equal(/Reading the archive/.test(refused), false, "'we have not asked' must never read as 'no'");
});

test("real subjects render as links that carry the archive id, not the batch id", async () => {
  const { khazanaMarkup } = await import("../public/assets/khazana.js");
  const html = khazanaMarkup({
    khazana: { state: "ok", programId: "ARCHIVE1" },
    subjects: [{ name: "Physics", slug: "physics-1", lectureCount: 40, tagCount: 12 }],
  });
  assert.match(html, /subject-card/);
  assert.match(html, /Physics/);
  assert.match(html, /batch=ARCHIVE1/, "the subject page must fetch the archive's chapters");
  assert.match(html, /archive=1/);
  assert.match(html, /40 lectures/);
});

test("a 200 with no usable rows renders as empty, never as success", async () => {
  const { khazanaMarkup } = await import("../public/assets/khazana.js");
  const html = khazanaMarkup({ khazana: { state: "ok", programId: "A" }, subjects: [] });
  assert.match(html, /empty/i);
  assert.equal(/subject-card/.test(html), false);
});

test("mounting with no pointer makes no request at all", async () => {
  const { mountKhazana } = await import("../public/assets/khazana.js");
  const window = dom();
  const host = window.document.getElementById("host");
  let calls = 0;
  await mountKhazana(host, {
    programId: "",
    fetchImpl: () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  assert.equal(calls, 0, "the common case must not spend a request");
  assert.match(host.innerHTML, /No Khazana archive/);
});

test("mounting with a pointer reads it and renders the answer", async () => {
  const { mountKhazana } = await import("../public/assets/khazana.js");
  const window = dom();
  const host = window.document.getElementById("host");
  const asked = [];
  const out = await mountKhazana(host, {
    programId: "ARCH",
    fetchImpl: async (url) => {
      asked.push(url);
      return {
        json: async () => ({
          success: true,
          khazana: { state: "ok", programId: "ARCH" },
          subjects: [{ name: "Maths", slug: "maths-1", lectureCount: 9 }],
        }),
      };
    },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /khazana=read/);
  assert.equal(out.state, "ok");
  assert.match(host.innerHTML, /Maths/);
});

test("a failed read renders the error state rather than throwing into the page", async () => {
  const { mountKhazana } = await import("../public/assets/khazana.js");
  const window = dom();
  const host = window.document.getElementById("host");
  await mountKhazana(host, {
    programId: "ARCH",
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.match(host.innerHTML, /could not be reached/);
});

test("an escaped pointer cannot inject markup into the notice", async () => {
  const { khazanaMarkup } = await import("../public/assets/khazana.js");
  const html = khazanaMarkup({
    khazana: { state: "locked", programId: '<img src=x onerror="alert(1)">' },
  });
  assert.equal(html.includes("<img src=x"), false, "the pointer is a value, not markup");
});

/* ---------------------------------------------------------------------------
 * A refusal is not an outage.
 *
 * Found in production, not in a test: the first live read of this feature
 * reported `state:"error"` — "the archive could not be reached, this is a
 * network read" — for an archive that was answering 401. `upstreamJson` returned
 * `status: 0` for every failed request whatever the HTTP status was, so 401, 400
 * and 404 were indistinguishable from a dead socket, and the reader told the
 * student the site was broken when the truth was "this content is paid".
 *
 * The tests below pin the distinction at both layers: the transport must carry
 * the status through, and the classifier must land on `locked` — with the fix for
 * it named — when it sees one.
 * ------------------------------------------------------------------------- */

test("a transport refusal keeps its status instead of collapsing to 0", async () => {
  const { classifyAnswer: classify } = await import("../lib/khazana.mjs");
  // This is the exact shape `upstreamJson` produces for a refused read.
  assert.equal(classify({ ok: false, status: 401, data: null, error: "upstream 401" }), "locked");
  assert.equal(classify({ ok: false, status: 403, data: null, error: "upstream 403" }), "locked");
  assert.equal(classify({ ok: false, status: 400, data: null, error: "upstream 400" }), "invalid");
  assert.equal(classify({ ok: false, status: 404, data: null, error: "upstream 404" }), "missing-shape");
  // No HTTP answer at all is the only thing that counts as unreachable.
  assert.equal(classify({ ok: false, status: 0, data: null, error: "fetch failed" }), "error");
});

test("a refusal wrapped as a generic failure is still read as a refusal", async () => {
  // Some paths lose the status somewhere between the upstream and here. The
  // upstream's own words survive, and they are enough: telling a student to sign
  // in is a better answer than telling them the site is down.
  assert.equal(classifyAnswer({ ok: false, status: 0, error: "Upstream refused this token" }), "locked");
  assert.equal(classifyAnswer({ ok: false, status: 0, error: "upstream 401" }), "locked");
  assert.equal(classifyAnswer({ ok: false, status: 0, error: "timed out" }), "error");
});

test("a refused archive reports the state a person can act on", async () => {
  const program = "62cc7a39ea773600110bec2f";
  const probe = tableProbe({
    [`/v3/batches/${program}/subjects`]: { ok: false, status: 401, data: null, error: "upstream 401" },
    [`/v3/programs/${program}/subjects`]: { ok: false, status: 401, data: null, error: "upstream 401" },
    [`/v3/batches/${program}/details`]: { ok: false, status: 400, data: null, error: "upstream 400" },
  });
  const out = await readArchive(program, { probe });

  assert.equal(out.state, "locked", "paid content must not be reported as an outage");
  assert.equal(out.needsSubscriberToken, true, "the reader must be told what would fix it");
  assert.match(out.note, /PW_TOKEN/);
  assert.equal(probe.asked.length, 3, "one refusal must not stop the ladder");
  // The evidence has to be usable: an operator reading the JSON should be able to
  // tell what each shape said without re-running the probes by hand.
  assert.equal(out.tried[0].status, 401);
  assert.match(out.tried[0].detail, /401/);
});

test("every state a person can act on is attention, and only those", async () => {
  assert.deepEqual([...KHAZANA_ATTENTION].sort(), ["error", "invalid", "locked"]);
  for (const quiet of ["none", "known", "empty", "ok"]) {
    assert.equal(KHAZANA_ATTENTION.has(quiet), false, `"${quiet}" is a normal state, not a fault`);
  }
});
