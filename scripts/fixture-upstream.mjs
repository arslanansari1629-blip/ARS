/**
 * Fixture proxy — local development / CI only.
 *
 * Serves recorded upstream responses (tests/fixtures) so the UI can be
 * exercised end-to-end without live network access. Point the dev server at it:
 *
 *   PW_UPSTREAM_BASE=http://127.0.0.1:4010
 *   node scripts/dev.mjs
 *
 * In production this is never used: the app talks to the live PW API.
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests", "fixtures");
const PORT = Number(process.env.FIXTURE_PORT || 4010);

const routes = [
  { match: /\/AllBatches/, file: "catalog.json" },
  { match: /\/searchBatch/, file: "catalog.json" },
  { match: /SubjectInfo/, file: "chapters.json" },
  {
    // The modern contents route the site actually uses: `/v2/batches/…/contents`.
    match: /\/v2\/batches\/.*\/contents|TopicInfo/,
    // 6a6b461cce4ac4e9ab51ee98 → "unkeyed" notes: attachments arrive with an
    // empty `key` and are only resolvable through GetPdf (regression case).
    file: (url) => {
      // The DPP papers list: `DppNotes` returns the item shape the admin panel
      // reads, with one attachment whose URL is the served PDF fixture.
      if (/ContentType=DppNotes|contentType=DppNotes/i.test(url)) return "dpp-papers.json";
      if (!/ContentType=notes/i.test(url)) return "videos.json";
      return /TopicId=6a6b461cce4ac4e9ab51ee98/.test(url)
        ? "notes-unkeyed.json"
        : "notes.json";
    },
  },
  { match: /GetPdf/, file: "getpdf.json" },
  { match: /\/Schedule\?/, file: "schedule.json" },
  { match: /Type=announcement/, file: "announcements.json" },
  { match: /Type=details/, file: "batch.json" },
  // DPP index. The paper itself is deliberately *not* fixtured: a guest session
  // gets a 401 from PW, so the fixture returns the same 401 the live API does
  // and the locked-paper path is what the UI is tested against.
  { match: /new-dpp-list/, file: "dpp-list.json" },
  // The DPP *paper* PDF. Unlike the quiz, a paper is guest-readable, so the
  // fixture serves a real one and the whole extract-and-run path is testable.
  { match: /dpp-paper\.pdf$/, file: "dpp-paper.pdf", type: "application/pdf" },
  // A reproduction of the *live* DPP 11 layout (option letters and values in
  // separate runs) and a stacked variant. Both exist because a plain-text read
  // gets them wrong, so they are what the practice tests assert against.
  { match: /dpp-paper-real\.pdf$/, file: "dpp-paper-real.pdf", type: "application/pdf" },
  { match: /dpp-paper-stacked\.pdf$/, file: "dpp-paper-stacked.pdf", type: "application/pdf" },
  // DPP 11 as the source prints it: two questions to a row, on three pages.
  { match: /dpp-paper-columns\.pdf$/, file: "dpp-paper-columns.pdf", type: "application/pdf" },
];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = routes.find((r) => r.match.test(req.url));
    res.setHeader("Access-Control-Allow-Origin", "*");

    // A DPP *paper* is not fixtured on purpose: PW answers 401 to a guest, so the
    // fixture does too and the UI's locked-paper path is what exercise covers.
    // This has to run before the route lookup, or the unmatched path 404s and the
    // test reads "not found" instead of "locked".
    if (/test-service\/tests\/[0-9a-f]{24}\/questions/i.test(url.pathname)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, message: "Unauthorised Access", code: 401 }));
    }

    if (!route) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: "fixture not found", url: req.url }));
    }

    const name = typeof route.file === "function" ? route.file(req.url) : route.file;
    try {
      let buf = await readFile(path.join(FIX, name));
      // Some fixtures point at *this* server (the DPP paper PDF). The port is not
      // known ahead of time — CI, a local run and the tests each pick their own —
      // so the JSON carries a placeholder and it is filled in here.
      if (/\.json$/.test(name)) {
        buf = Buffer.from(
          buf.toString("utf8").replaceAll("{FIXTURE_BASE}", `http://127.0.0.1:${PORT}`)
        );
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", route.type || "application/json");
      res.end(buf);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fixture upstream → http://127.0.0.1:${PORT}`));
