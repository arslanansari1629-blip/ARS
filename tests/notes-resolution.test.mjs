/**
 * Notes/DPP attachment resolution.
 *
 * Every note and DPP PDF arrives from PW's listing without a storage key, so
 * each one needs its own `GetPdf` lookup before the row can render. That loop
 * had two faults:
 *
 *   1. A failed lookup was written into the cache as `undefined`, and the guard
 *      read `url === undefined` — so one throttled request marked that
 *      attachment unresolvable for the life of the process. PW rate-limits
 *      these calls, so this happened routinely, and the Notes tab stayed short
 *      long after the limit had cleared.
 *   2. The work was unbounded. A 120-entry chapter is 40 sequential rounds at
 *      three-at-a-time; against a slow upstream that exceeds the function
 *      timeout and the tab renders nothing at all rather than a short list.
 *
 * The fix is that only *successes* are cached, and the loop has a deadline
 * after which it reports what it skipped instead of being killed mid-flight.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/** A stub PW upstream: the listing plus a GetPdf that throttles on demand. */
async function stubUpstream(handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const out = handler(url);
    res.writeHead(out.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test("a throttled GetPdf is retried on the next request, not cached as dead", async () => {
  let getPdfCalls = 0;
  const { server, base } = await stubUpstream((url) => {
    if (url.pathname === "/GetPdf") {
      getPdfCalls++;
      // `upstreamJson` retries a 429 once internally, so a single throttled
      // response is absorbed and proves nothing. Throttle past that retry: the
      // whole first round fails, which is the state that used to be cached.
      if (getPdfCalls <= 2) return { status: 429, body: { success: false, message: "slow down" } };
      return {
        status: 200,
        body: { success: true, data: { _id: "pdf1", fileName: "Notes.pdf", key: "pw/notes/1.pdf" } },
      };
    }
    return {
      status: 200,
      body: {
        success: true,
        data: [
          {
            // Real listing shape: attachments live on the item, and each one
            // arrives with no storage key — that gap is what GetPdf fills.
            _id: "item1",
            topic: "Units and Measurement 01",
            attachmentIds: [{ _id: "att1", name: "Notes.pdf" }],
          },
        ],
      },
    };
  });

  const pinned = process.env.PW_UPSTREAM_BASE;
  process.env.PW_UPSTREAM_BASE = base;
  try {
    const { fetchChapterContents } = await import(`../lib/api-data.mjs?t=${Date.now()}`);
    const first = await fetchChapterContents("b1", "s1", "topic1", "notes");
    assert.ok(first.diagnostics.failed >= 1, "the throttled lookup should be reported as failed");

    // The same attachment, asked for again. It must try the network once more.
    const before = getPdfCalls;
    const second = await fetchChapterContents("b1", "s1", "topic1", "notes");
    assert.ok(getPdfCalls > before, "a failed lookup must not be cached as permanently unresolved");
    assert.equal(second.diagnostics.failed, 0, "the retry should resolve the attachment");
    const url = second.items[0].docs[0].url;
    assert.match(String(url), /pw\/notes\/1\.pdf/, "the resolved url must reach the row");
  } finally {
    if (pinned === undefined) delete process.env.PW_UPSTREAM_BASE;
    else process.env.PW_UPSTREAM_BASE = pinned;
    await new Promise((r) => server.close(r));
  }
});
