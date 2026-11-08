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
    match: /TopicInfo/,
    file: (url) => (/ContentType=notes/i.test(url) ? "notes.json" : "videos.json"),
  },
  { match: /\/Schedule\?/, file: "schedule.json" },
  { match: /Type=announcement/, file: "announcements.json" },
  { match: /Type=details/, file: "batch.json" },
];

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = routes.find((r) => r.match.test(req.url));
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!route) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: "fixture not found", url: req.url }));
    }

    const name = typeof route.file === "function" ? route.file(req.url) : route.file;
    try {
      const buf = await readFile(path.join(FIX, name));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(buf);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fixture upstream → http://127.0.0.1:${PORT}`));
