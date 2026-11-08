# EduVibe PW — Physics Wallah batches, notes, DPPs & lectures

A complete, deployable clone of **[pw.eduvibe.cc.cd](https://pw.eduvibe.cc.cd/)** — the EduVibe
"Physics Wallah" learning portal.

Every batch name, subject, chapter list, lecture, class-note PDF, DPP and announcement shown by
this site is **live data from the same upstream API the source site renders**. Nothing is scraped
into fixtures and nothing is hard-coded: the catalogue, chapter counts, lecture titles, PDF
links and thumbnails all come from the PW API on each request.

```
Home → All batches → Batch (subjects) → Subject (chapters) → Chapter (lectures / notes / DPPs)
                                                              ↓
                                                     Lecture player + PDF viewer
```

## What is included

| Page | What it does |
| --- | --- |
| `/` | Landing page in the source's visual language: hero, search, trending batches, catalogue preview, recent batches, community CTA |
| `/batches` | Full catalogue — 13,000+ batches, paginated, searchable, filter by language, sort by name/date |
| `/batch?id=…` | Batch header (cover, price, dates, exam, language) + subject list, announcements tab, about tab |
| `/subject?batch=…&subject=…` | Chapter list with lecture / notes / DPP counters |
| `/chapter?batch=…&subject=…&chapter=…` | Tabs for **Lectures**, **Notes (PDF)**, **DPPs**, **DPP Solutions** |
| `/lecture?batch=…&subject=…&id=…` | Stream resolution + player (HLS / DASH / MP4), speed control, resume position, attached class notes & DPPs |
| `/viewer?url=…` | In-app PDF reader for notes and DPPs |
| `/login` | "Continue with Google" (local profile) and **Bypass Login** — mirrors the source sign-in |
| `/dashboard`, `/library` | Student dashboard: recent batches, continue watching, saved PDFs |

## How the data flows

```
browser ──► /api/batches | /api/batch | /api/contents | /api/lecture | /api/stream
                │
                ├─ direct fetch ──► https://www.learnxpw.site/api/…   (PW catalogue API)
                │                     AllBatches · searchBatch · BatchInfo
                │                     SubjectInfo · TopicInfo · Schedule · GetPdf
                │
                └─ if the datacenter IP is blocked (answer: { needsProxy: true })
                      the browser fetches the *same live JSON* through a CORS relay
                      and normalises it with the identical mapping code
```

* **PDFs and thumbnails** are relayed through `/api/media` (PW hosts send no CORS headers),
  with HTTP `Range` forwarding so large notes stream progressively.
* **Lecture streams** are resolved by `/api/stream`. PW publishes signed CloudFront
  DASH/HLS URLs; CloudFront does not send CORS headers on segments, so manifests and
  segments are streamed through `/api/hls` (the manifest is rewritten so every child
  request stays on our domain). If a lecture's URL lost its signature, `/api/sign` asks
  PW's public signing relay for a freshly signed playlist.
* When a lecture genuinely has no published video yet, the player says so and links to the
  source player instead of failing silently.

## Project layout

```
api/                 Vercel serverless functions (Node runtime, ESM)
  batches.mjs        catalogue + search
  batch.mjs          batch detail + subjects
  contents.mjs       chapters + chapter contents
  lecture.mjs        lecture detail, attachments, announcements
  stream.mjs         playable stream resolution
  hls.mjs            CORS-safe manifest/segment gateway
  sign.mjs           signed-playlist relay
  pdf.mjs            PDF resolution + redirect
  media.mjs          asset (PDF/image) relay
lib/                 shared upstream client + normalisers (server side)
public/              the whole front end (static, no build step)
  index.html batches.html batch.html subject.html chapter.html lecture.html
  viewer.html login.html dashboard.html library.html 404.html
  assets/            theme.css · pages.css · app.js · data.js · client-api.js · page modules
scripts/dev.mjs      local dev server (same (req,res) contract as Vercel)
scripts/fixture-upstream.mjs   offline fixture upstream for tests only
tests/               jsdom end-to-end tests for every page + API
legacy/              the Flask document-scanner project that previously lived in this repo
```

## Run locally

```bash
npm run dev          # http://localhost:3000
npm test             # 11 end-to-end page/API tests (jsdom)
```

No build step, no dependencies at runtime — the front end is plain ES modules and the API
functions only use `fetch`.

### Working offline / on a blocked network

The sandbox that built this project cannot open connections to `learnxpw.site`, so tests run
against recorded upstream responses:

```bash
node scripts/fixture-upstream.mjs &          # 127.0.0.1:4010
PW_UPSTREAM_BASE=http://127.0.0.1:4010 npm run dev
```

In production no such override is set: `PW_UPSTREAM_BASE` is unset, so requests go to the real
PW API. If a deployment's region is blocked upstream, the API answers `{ needsProxy: true }` and
the browser transparently falls back to the public CORS relay — the UI keeps showing live data.

## Deploy

The repository is Vercel-ready:

* framework: **Other** (no build step), output directory `public/`
* functions: `api/*.mjs`, Node runtime, 60 s max duration
* `cleanUrls` enabled so `/batches.html` is served as `/batches`

```bash
npm i -g vercel
vercel --prod
```

## Notes

* Progress (resume position, recent batches, saved PDFs) is stored in your browser only.
* Login is local — "Bypass Login" and the Google sheet generate a device-local profile.
* All lecture content, notes and artwork belong to Physics Wallah / EduVibe; this project is a
  UI layer that reads their public API.
