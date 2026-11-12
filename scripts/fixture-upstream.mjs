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

/**
 * The Khazana program surface.
 *
 * Recorded from the live source and served here so the whole five-level walk —
 * subjects → chapters → topics → sections → contents — is exercised without
 * network access. The paths are matched in order because they overlap: the
 * contents call is `/v2/programs/contents` and every level above it is
 * `/v1|v2/programs/<id>/…`.
 */
const programFixture = JSON.parse(
  await readFile(path.join(FIX, "program.json"), "utf8")
);

const PROGRAM_ID = "697c6370cb722a4fac145ef1";

/**
 * A day's worth of rows, anchored to the clock the route was told to use.
 *
 * Two rows on purpose, because the strip's whole job is to tell them apart:
 *
 *   • a class that started ten minutes ago and has not finished — the recording
 *     does not exist yet, so this must read "Live now" and must NOT be linked;
 *   • a class later today with a published recording — "Upcoming" by time, but
 *     with a stream, so it is openable.
 *
 * Both carry `endTime` equal to `startTime`, which is what the real API does on
 * scheduled classes; the reader is expected to use the duration instead. That is
 * a property worth fixturing rather than smoothing over.
 */
function todayFeed(url) {
  const now = Number(new URL(url, "http://localhost").searchParams.get("now")) || Date.now();
  const at = (offsetMinutes) => new Date(now + offsetMinutes * 60 * 1000).toISOString();
  return {
    data: [
      {
        _id: "6ae8aeffae188900fe3f14e0",
        status: "PENDING",
        date: at(-10),
        startTime: at(-10),
        endTime: at(-10),
        isDPPNotes: false,
        restrictedSchedule: false,
        tags: [{ _id: "6a6b4631ce4ac4e9ab51eed5", name: "Units and Dimension" }],
        teachers: ["688dd9660fb5f084935d611f"],
        topic: "Units and Dimension 11 : Dimensional Analysis",
        url: "",
        urlType: "penpencilvdo",
        lectureType: "LIVE",
        videoDetails: {
          _id: "6818add7edc3eae1486792e1",
          name: "Units and Dimension 11 : Dimensional Analysis",
          image: "https://static.pw.live/5eb393ee95fab7468a79d189/ADMIN/7c30.png",
          videoUrl: "",
          description: "live to vod",
          duration: "01:30:00",
          status: "Ready",
          types: ["DASH", "HLS"],
          drmProtected: false,
        },
        isVideoLecture: true,
        isLocked: true,
      },
      {
        _id: "6a6b462b26b614560bceb74c",
        status: "PENDING",
        date: at(120),
        startTime: at(120),
        endTime: at(120),
        isDPPNotes: false,
        restrictedSchedule: false,
        tags: [{ _id: "6a6b4631ce4ac4e9ab51eed5", name: "Units and Dimension" }],
        teachers: ["688dd9660fb5f084935d611f"],
        topic: "Units and Dimension 12 : Significant Figures",
        url: "https://d1d34p8vz63oiq.cloudfront.net/aaaa1111-0000-4000-8000-000000000002/master.mpd",
        urlType: "penpencilvdo",
        lectureType: "RECORDED",
        videoDetails: {
          _id: "6818add7edc3eae1486792e2",
          name: "Units and Dimension 12 : Significant Figures",
          image: "https://static.pw.live/5eb393ee95fab7468a79d189/ADMIN/7c30.png",
          videoUrl: "https://d1d34p8vz63oiq.cloudfront.net/aaaa1111-0000-4000-8000-000000000002/master.mpd",
          description: "",
          duration: "01:20:00",
          status: "Ready",
          types: ["DASH", "HLS"],
          drmProtected: false,
        },
        isVideoLecture: true,
        isLocked: false,
      },
      {
        // A cancelled slot the way PW actually serves one: the page is retitled
        // and the lecture type is left as LIVE, with no status flag anywhere.
        // Read literally it is a class at +45 minutes, so without the
        // cancellation read the strip told a student to be there.
        _id: "6a6b462b26b614560bceb74d",
        status: "PENDING",
        date: at(45),
        startTime: at(45),
        endTime: at(45),
        isDPPNotes: false,
        restrictedSchedule: false,
        tags: [{ _id: "6a6b4631ce4ac4e9ab51eed5", name: "Units and Dimension" }],
        teachers: ["688dd9660fb5f084935d611f"],
        topic: "Class Cancelled: Due to some issue",
        url: "",
        urlType: "penpencilvdo",
        lectureType: "LIVE",
        videoDetails: {
          _id: "6818add7edc3eae1486792e3",
          name: "Class Cancelled: Due to some issue",
          image: "",
          videoUrl: "",
          description: "",
          duration: "",
          status: "PENDING",
          types: [],
          drmProtected: false,
        },
        isVideoLecture: true,
        isLocked: true,
      },
    ],
  };
}

const routes = [
  { match: /\/AllBatches/, file: "catalog.json" },
  { match: /\/searchBatch/, file: "catalog.json" },
  { match: /SubjectInfo/, file: "chapters.json" },
  {
    /**
     * Today's classes.
     *
     * The batch page's live-class strip reads one contents listing per subject and
     * keeps today's rows — so the fixture has to answer that listing with a day.
     * The recorded rows in `videos.json` are all in the past, which is correct
     * for a chapter list and useless for "what is on today", so this fixture
     * carries a "today" relative to the request: `startTime` is written from the
     * clock at the moment it is served, which is the only way a fixture can
     * exercise a strip that is defined by the current minute.
     *
     * The `?at=` query string that `/api/batch?today=1` accepts pins the clock
     * for the *route*, but the route is what asks upstream — so the rows have to
     * be anchored to the clock the route was given, which arrives here as a
     * `now` parameter this fixture reads.
     */
    // Only the batch the day is demonstrated on: every other batch keeps the
    // recorded chapter list, so a test of *this* strip cannot accidentally pass
    // by reading a chapter's 2025 lectures as today's timetable.
    match: /\/v2\/batches\/698ad3519549b300a5e1cc6a\/subject\/physics-by-saleem-ahmad-sir-886822\/contents\?(?=.*today=1)(?=.*now=)/,
    json: (url) => todayFeed(url),
  },
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
  // --- Khazana program surface, most specific first -----------------------
  {
    // The lecture/notes list. Addressed by query, not by path.
    match: /\/v2\/programs\/contents/,
    json: () => programFixture.contents,
  },
  {
    match: new RegExp(`/v1/programs/${PROGRAM_ID}/subjects/[^/]+/chapters/[^/]+/topics/[^/]+/contents/sub-topic`),
    json: () => programFixture.sections,
  },
  {
    match: new RegExp(`/v1/programs/${PROGRAM_ID}/subjects/[^/]+/chapters/[^/]+/topics`),
    json: () => programFixture.topics,
  },
  {
    match: new RegExp(`/v2/programs/${PROGRAM_ID}/subjects/[^/]+/chapters`),
    json: () => programFixture.chapters,
  },
  {
    match: new RegExp(`/v1/programs/${PROGRAM_ID}/subjects`),
    json: () => programFixture.subjects,
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
  { match: /dpp-paper-scan\.pdf$/, file: "dpp-paper-scan.pdf", type: "application/pdf" },
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

    // Khazana is the other paid surface: the *archive* id never serves content to
    // a guest, no matter which shape asks. The fixture has to say so, or a test
    // of the reader would pass against a 404 and never exercise the refusal path
    // that production actually hits.
    if (
      /v3\/(batches|programs)\/62cc7a39ea773600110bec2f(\/|$)/i.test(url.pathname)
    ) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({ success: false, error: { message: "Unauthorised Access", status: 401 }, code: 401 })
      );
    }

    if (!route) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: "fixture not found", url: req.url }));
    }

    // An inline route: the program fixture is one document with five levels.
    if (route.json) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(route.json(req.url)));
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
