# ArsVibe PW — Physics Wallah batches, notes, DPPs & lectures

A complete, deployed clone of **[pw.eduvibe.cc.cd](https://pw.eduvibe.cc.cd/)** — the ArsVibe
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
| `/batches` | The complete catalogue — all **14,201** batches, paginated, searchable, filter by language, sort by name/date |
| `/batch?id=…` | Batch header (cover, price, dates, exam, language) + subject list, announcements tab, about tab |
| `/subject?batch=…&subject=…` | Chapter list with lecture / notes / DPP counters |
| `/chapter?batch=…&subject=…&chapter=…` | Tabs for **Lectures**, **Notes (PDF)**, **DPPs**, **DPP Solutions** |
| `/lecture?batch=…&subject=…&id=…` | Stream resolution + player (HLS / DASH / MP4), speed control, resume position, attached class notes & DPPs |
| `/viewer?url=…` | In-app PDF reader for notes and DPPs |
| `/login` | "Continue with Google" (local profile) and **Bypass Login** — mirrors the source sign-in |
| `/dashboard`, `/library` | Student dashboard: recent batches, reading positions, saved PDFs |
| `/favourites` | Batches kept on this device — the heart on any batch card adds and removes |

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

* **Batch discovery** does not use the upstream `searchBatch` endpoint. That endpoint cannot see
  parts of the catalogue (searching "Capcut" returned nothing while the batch's own detail page
  rendered fine), which is exactly why [vidcloud.eu.org](https://vidcloud.eu.org/#batches) does
  not search an API either: its client downloads one complete list and filters it locally. We
  ship the same list — `data/batches.json.gz`, 14,201 batches, refreshed from
  `https://rarestudy.github.io/rarestudy/batches.json` by `scripts/fetch-catalogue.mjs` — and
  search it in-process, so every batch that exists can be found. Batch *details* still come from
  the live API; if that call rate-limits, the page says so with a retry instead of showing an
  empty subject list.
* **Bare `/api/pw` is the discovery answer**, not an error: it lists every upstream path the
  proxy forwards (catalogue, batch, chapters, lectures, signer, OTP, PDFs, DPP tests), the
  switches (`?upstream=`, `?fresh=1`, `?bin=1`), and the allowlisted hosts. A path that fails
  validation still returns 400 — a caller must be able to tell "rejected" from "here are docs".
* **PDFs and thumbnails** are relayed through `/api/media` (PW hosts send no CORS headers),
  with HTTP `Range` forwarding so large notes stream progressively.
* **Lecture streams** are resolved by `/api/stream`. PW publishes signed CloudFront
  DASH/HLS URLs; CloudFront sends no CORS headers on segments, so playback goes through our
  own origin and every child request stays on our domain:
  * HLS — what every lecture we have checked actually uses — is relayed by `/api/sign`, which
    asks the signing relay for a fresh signed playlist, rewrites the `EXT-X-KEY` and segment
    URIs through itself, and streams the 16-byte AES key and the media segments byte for byte.
    Its `key=master.m3u8` entry point composes a real master playlist from the renditions that
    exist, so the player gets levels to switch between instead of one fixed quality.
  * DASH (`master.mpd`) is relayed by `/api/hls`, which rewrites the manifest's `BaseURL`.
    CloudFront will not serve an unsigned `.mpd` (403), and the public signer stores HLS
    renditions only, so a DASH-only lecture cannot be relayed: `/api/sign` answers that
    explicitly (with an `hlsHint`) rather than failing as a generic 404. HLS covers the
    lectures here, so this is a documented limit rather than the playback path.
* Renditions differ per video, so the resolver asks the signing relay for `1080`, `720`, `480`,
  `360` and `240` — every host/rendition pair at once — and keeps **all** that answer. A lecture
  published only at 480p used to be reported as "no video"; it now plays.
* The signer stores one rendition per video and has no `master.m3u8` (asking for one is a 404).
  Feeding a player a single rendition's media playlist meant hls.js saw exactly one level, so
  the player's quality picker was dead: the server had silently chosen the quality. `/api/sign`
  now *builds* a real master playlist from the renditions that answered (`key=master.m3u8`),
  listing them lowest-first, so hls.js exposes one level per rendition and the picker works.
  The chosen quality is remembered and re-applied on the next lecture.
* Some lectures are not on a PW CDN at all — the Skills batches publish recordings on YouTube.
  Those resolve to an embed plan (`kind: "youtube"`, `engine: "embed"`) and play in an `<iframe>`,
  with the quality/speed/resume controls hidden because they do not apply. A URL on a host we
  cannot relay is reported as `external` with a direct link, never as "no video".
* When a lecture genuinely has no published video, `/api/stream` answers `200` with
  `playable:false` and a specific reason — document-only entry, upcoming live class, or a
  recording the source has not finished processing — and the player shows that reason plus a
  retry button instead of a dead overlay.

## Project layout

```
api/                 Vercel serverless functions (Node runtime, ESM)
  batches.mjs        catalogue + search
  batch.mjs          batch detail + subjects
  contents.mjs       chapters + chapter contents
  lecture.mjs        lecture detail, attachments, announcements
  stream.mjs         playable stream resolution
  check.mjs          playback self-test (one lecture, a URL, or a whole chapter)
  admin.mjs          operator API: sign-in, sessions, live stats (+ mounts /api/hls, /api/sign)
  pdf.mjs            PDF resolution + redirect
  media.mjs          asset (PDF/image) relay
  pw/[...path].mjs   authenticated pass-through to the whole PW API surface
  token.mjs          token + auth self-test ("why is this lecture 401?")
lib/                 shared upstream client + normalisers (server side)
  pw-auth.mjs        guest-token resolution + the one PW header set
  pw-proxy.mjs       the /api/pw implementation (allowlist, failover, binary passthrough)
  catalog.mjs        the shipped batch catalogue (search + paging)
  playback.mjs       one explanation for "why has this lecture no video", shared by both routes
  admin.mjs          credentials (digests), sessions, traffic counters, health probes
  hls.mjs            CORS-safe manifest/segment gateway (mounted on api/stream.mjs)
  sign.mjs           signed-playlist relay (mounted on api/admin.mjs)
public/              the whole front end (static, no build step)
  index.html batches.html batch.html subject.html chapter.html lecture.html
  viewer.html login.html dashboard.html library.html favourites.html 404.html
  admin.html         the operator panel (noindex, its own plate)
  assets/            arsvibe.css (the whole design system) · app.js · data.js · page modules
data/batches.json.gz complete batch catalogue (13,631 upstream → 14,201 with the full list)
scripts/dev.mjs      local dev server (same (req,res) contract as Vercel)
scripts/fixture-upstream.mjs   offline fixture upstream for tests only
scripts/fetch-catalogue.mjs    refresh data/batches.json.gz from the source list
tests/               jsdom end-to-end tests for every page + API
legacy/              the Flask document-scanner project that previously lived in this repo
```

## Run locally

```bash
npm run dev          # http://localhost:3000
npm test             # end-to-end page/API/player tests (jsdom)
npm run build        # validates the tree + the batch catalogue
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

## The API proxy (`/api/pw`)

The lecture API answers **401 to an unauthenticated call**, so the credential cannot live in the
browser. `/api/pw` attaches it server-side and forwards any PW API path:

```bash
/api/pw/v3/batches/<id>/details
/api/pw/v2/batches/<id>/subject/<sid>/topics?page=1
/api/pw/v2/batches/<id>/subject/<sid>/contents?page=1&contentType=videos&tag=<topic>
/api/pw/v1/videos/get-otp?key=<hex>&isEncoded=true
/api/pw/v1/videos/get-hls-key?videoKey=<folder>&key=720/main.m3u8   # binary, streamed as-is
/api/pw/v3/test-service/tests/new-dpp-list?page=1&batchId=&batchSubjectId=
```

* **Credentials**: the guest token is resolved by `lib/pw-auth.mjs` (cached 10 min, refreshed on a
  401, optionally pinned with the `PW_TOKEN` env var) and sent as `authorization: Bearer…` plus
  `token`, `client-id`, `client-type`, `client-version`, `randomid`. The token never reaches a client.
* **Host failover**: `api.penpencil.co` → `api.penpencil.xyz` → `vidcloud.eu.org/api` →
  `api.studyspark.study` → `learnxpw.site`. A blocked or 5xx host is skipped; `X-PW-Tried` reports
  which hosts were walked.
* **Binary paths** (`get-hls-key`, `get-otp`, `*.ts`, `enc.key`) are streamed byte-for-byte — never
  parsed as text, which is how segments get corrupted.
* **Not an open proxy**: the host is allowlisted and the path must start with a real PW API segment,
  so it cannot be used to reach arbitrary addresses (traversal and foreign hosts return `400`).
* `SWITCHES`: `?upstream=<allowlisted host>`, `?fresh=1` (new token), `?bin=1` (force binary).

### Is the credential actually working?

```bash
GET /api/token            # token source, redacted value, and live probes
GET /api/token?fresh=1    # re-mint first
```

It spends the token against the API *and* both signer relays, and answers two separate
questions:

| field | meaning |
| --- | --- |
| `lectureSigning` | the relays accept the token, so any folder it is told about can be signed |
| `entitlement` | `{lectures, withVideoUrl, sampleTitle}` — a live lecture and its schedule record |
| `lecturePlayback` | `working` · `metadata-only` · `unavailable` |

**Signing and entitlement are not the same thing.** The relays will sign any folder they
are told about; whether a token is *told* which folder a lecture is depends on the schedule
record, and the two generations of that route do not even agree with each other: the modern
`/v1/.../schedule-details` returns an empty `videoDetails.videoUrl`, while the legacy
`/Schedule` — 404 on `api.penpencil.co`, alive on the vidcloud mirror — carries the signed
`master.mpd`. `fetchSchedule` asks both and keeps whichever has a stream.

With a guest token, some batches still come back with titles, durations and thumbnails but
no `videoUrl`; `lecturePlayback: "metadata-only"` is that state. To play those, pin a bearer
that holds the batch as `PW_TOKEN` (Vercel → project → Settings → Environment Variables).
Nothing else changes: the same proxy, the same `/api/sign` chain and the same player are
then used.

### Failover is per endpoint, not per host

The allowlisted hosts are mirrors of the same API but they do not overlap completely, so a
`4xx` from one means "wrong host for this path", not "bad request":

| endpoint | first host | serves it |
| --- | --- | --- |
| `/v1/videos/get-hls-key` | `401` on `api.penpencil.co` | `vidcloud.eu.org/api` |
| `GetPdf` | `404` on `api.penpencil.co` | `vidcloud.eu.org/api` |
| `/Schedule?BatchId=…` | `404` everywhere now (retired) | use `/v1/.../schedule-details` |
| `/TopicInfo?...` | `404` everywhere now (retired) | use `/v2/.../contents?tag=<chapter>` |

Both transports apply that rule — the HTTP route and `pwFetch()`, which is what the site's
own pages call — and a test pins them together. The signer endpoints also take the bearer as
an `authorization` **query parameter**; data routes keep it in the header.

## Is a lecture actually playable?

`GET /api/check` walks the exact path a browser walks and reports the first step that fails:

```bash
# one lecture: plan -> playlist -> AES key -> segment -> decrypt -> MPEG-TS
/api/check?batch=<batch>&subject=<subject-slug>&id=<lecture-id>

# a whole chapter (first 6 lectures, 3 at a time; &limit= up to 12)
/api/check?batch=<batch>&subject=<subject-slug>&chapter=<chapter-id>

# a raw stream URL you already have
/api/check?url=https://d1d34p8vz63oiq.cloudfront.net/<folder>/master.mpd
```

`result` is one of `plays`, `no_video_url`, `no_playable_plan`, `playlist_failed`, `key_failed`,
`no_segments`, `segment_failed`, `decrypt_mismatch` or `error`, and `explain` is the same
sentence the player shows. The chapter page links this sweep next to the lecture count, so a
"videos don't play" report comes with evidence instead of a screenshot.

### How playback is wired (and how it broke)

A lecture is played through one chain, and each link has been the reason lectures
went black at least once:

```
schedule record ──▶ plan (/api/stream) ──▶ master playlist ──▶ rendition playlist
                                                        └────▶ AES key, segments
```

- **`/api/stream`** resolves the plan. It hands the player a URL, never bytes.
- **`/api/sign`** is the signing relay: it asks the partner signer for one file
  (`720/main.m3u8`, `enc.key`, `720/000.ts`) and returns it, rewriting playlists
  so children come back through us. Signers store *one playlist per rendition*
  and answer 403 to `master.m3u8`, so the relay **builds the master itself** from
  the renditions the resolver verified (`&renditions=720,480,…`). Asking a signer
  for a master was the bug: the plan looked perfect and hls.js got a 403.
- **`/api/hls`** is the media gateway for already-signed CDN URLs (DASH or HLS).
  A URL with no signature — or a stale one — gets a 403 from CloudFront; the
  gateway then mints that file through `/api/sign` instead of dead-ending, and a
  master request is redirected to the plan's playable master.

Three invariants worth keeping:

1. A plan must point at `/api/hls` or `/api/sign` — never back at `/api/stream`,
   which answers JSON and leaves a media element with nothing to play.
2. Playlists are read as text and rewritten; segments are piped untouched. The
   file extension decides which is which, not the CDN's `content-type`.
3. Nothing calls its own origin over HTTP to reuse a handler — the gateway calls
   `fetchSigned()` in process, because a function cannot always reach itself.

`/api/token?fresh=1` proves the whole chain (plan → master → rendition →
segment) by fetching real bytes, and reports the first step that failed.

### When the signer refuses (the current production state)

PW does not sign content for the guest session this site holds: every signer
answers 401/403, so `/api/sign` returns 403 and no playlist can be minted. That is
an upstream access limit, not a bug in this repo, and retrying, relaying or
re-minting the guest token does not change it. Fixing it needs an operator
`PW_TOKEN` that can sign content.

What the code must do in that state — and now does — is refuse to lie about it.
The rendition probe records *which* failure happened (a 401/403 refusal, a signer
that could not be reached, or a genuine no-such-rendition), and `resolveStream`
picks its sentence from that evidence. "PW has not published a playable stream"
is only said when every signer answered 404. A refusal says the recording exists,
names the reason, and points at the notes and DPPs that do still work. Keep that
distinction: a student told "not published" goes looking for a video that is
already there.

The catalogue, batch pages, chapter lists, lecture lists, notes and DPPs are all
unaffected by this and remain live.

### The site repairs itself (`lib/selfheal.mjs`)

Nothing on a student-facing page mentions this. It exists so a dead link becomes
a retry instead of an error screen:

- **The player reports the folder that died.** Before any retry it fires a
  fire-and-forget beacon at `/api/repair?folder=…&kind=manifest|segment|stall`.
  That drops the cached plan for *that folder*, so the retry re-probes instead of
  receiving the same poisoned URL a second time.
- **It heals before it complains.** `/api/stream` retries silently, `/api/sign`
  reorders its signer ladder by observed health (a host that keeps failing is
  tried last, a quarantined one last of all — never removed, because a slow answer
  still beats no answer), and `/api/hls`/`/api/sign` every failure kind to the
  healer.
- **Repairs are bounded.** One repair per fault per minute, at most 12 an hour;
  the cap is itself reported as `budget.exhausted` instead of being silently
  swallowed. A bad minute cannot turn into a repair loop.
- **It only touches what it owns** — the plan cache, the rendition cache and the
  guest-token cache, all registered from the modules that own them so the
  dependency stays one-way. It never edits or deploys code: an auto-deployer
  triggered by a bad metric is how an outage becomes a cascade.

The ledger is visible in exactly one place, the admin panel's *Self-healing*
block: repairs made, signers quarantined with the resulting ladder, relay faults
over the last ten minutes, and how much of the hourly budget is spent.

## Downloading lectures for offline use

> **Status: blocked upstream, not by this code.** Everything below is built and
> tested against recorded fixtures, but it cannot run against the live site
> unless an operator supplies a `PW_TOKEN` whose account holds the batch. Physics
> Wallah's signer refuses a guest session, so `/api/stream` answers with
> `playable: false` and a reason; the download path shows that reason and stops
> rather than looping. **Notes and DPP PDFs are the part that works offline
> today** — they are plain files, and `/downloads` leads with them.

`/downloads` turns a lecture into a file that keeps playing with the network off.
It browses the live catalogue (batch → subject → chapter → lecture) and the
player's own menu carries a **Save for offline** action, so the decision can be
made where it is actually made — while watching.

The hard part is not fetching bytes, it is arithmetic:

- a signed URL dies within minutes, so a saved file that references one is
  worthless by the next morning;
- a two-hour lecture does not fit in one response, so it arrives in slices;
- a slice is a valid playlist on its own, but three slices are not one file.

So `/api/download` (rewritten onto `api/stream.mjs`, inside the twelve-function
budget) assembles a **self-contained** slice: the AES key and every segment are
written into the file as `data:` URIs, with `#EXT-X-ENDLIST`, so nothing in it
points at this deployment and nothing expires. Two shapes are offered:

| Format | What it is | Plays in |
| --- | --- | --- |
| `plain` | decrypted MPEG-TS (`.ts`) | any player — VLC, ffmpeg, this site |
| `playlist` | self-contained `.m3u8`, key inline | this site and VLC |

`plain` is the default when the source is AES-128, because a file that needs no
key handling is the one that keeps working. Decryption uses the media sequence
number as the IV, and a segment that will not come apart fails the slice rather
than shipping noise.

A saved lecture stays *on the site*: **Play offline** opens it in the site's own
player sheet (`public/assets/offline-player.js`), built from a Blob of the parts
already in IndexedDB — `video/mp2t` for a plain save, hls.js for a keyed one. There
is no request in that path at all, which is what makes it offline. **Save file** is
the separate, explicit action for putting a copy in the browser's Downloads folder
to carry to VLC or another phone — it is a copy, not the library.

Client side (`public/assets/downloader.js`), a download is: fetch a slice → pull
the inline media out → append it to what is already held → keep the running
result in IndexedDB. Slices are stitched into one file when the download
finishes, and an interrupted lecture stays playable up to where it stopped and
resumes from the same place. Each slice retries four times before anything is
reported, for the same reason the player does: a rate-limited signer is the
normal case, not a fault. The library lives on the device — nothing is uploaded
and no lecture is re-hosted.

One detail is worth stating because it cost a production outage: the route reads
the media playlist **from the signer directly**, not through this deployment's own
`/api/sign`. A signed playlist carries absolute URLs back to this origin, so the
first version fetched them from inside the function — which works locally and
answers 500 on a serverless deployment, because a function cannot rely on calling
its own deployment origin. `tests/download-route.test.mjs` now asserts that no
handler request ever names the deployment's host. The same investigation found
that the AES key is named `enc.key` with no rendition in front of it — segments
carry `720/000.ts`, the key does not — and that asking for `720/enc.key` is a 403.
`mode=file&probe=1` reports the shape of an assembled slice (size, `0x47` sync
byte, next offset) without shipping the bytes, which is how a binary response is
checked from a place that cannot save files.

## Why a download survives a bad minute

The signers refuse in bursts. The same request that answered a moment ago starts
returning `401` or `403` for a few seconds — usually because a mirror is busy or
its own guest-token minting is lagging — and then works again. A two-hour lecture
is about 550 segments, so a download that treated the first refusal as final died
somewhere in the middle and reported that the lecture "could not be downloaded"
while almost all of it had already arrived.

Three things keep that from happening:

- **The relay retries.** `fetchSigned` makes up to three passes over the signer
  ladder with a widening gap, and re-mints the guest token when the answer was
  `401`. A `404` is *not* retried — that is a real answer.
- **A slice keeps what answered.** `assembleSlice` skips a segment that stays
  unavailable instead of discarding the slice, and reports how many it dropped.
  The page says so once, in the toast, rather than leaving a silent gap.
- **A rendition is not the only rendition.** If the quality the player picked
  refuses, `mode=list` walks the rest before answering `playable:false`.

`X-Download-Skipped` carries the count and `mode=file&probe=1` shows it as
`skipped`, so the behaviour is visible without opening the file. `probe=1` also
keeps retries off, which keeps the diagnostic fast.

## The admin panel

`/admin` is a separate, noindex plate — it is not part of the student shell and
nothing in the public nav links to it (a small `admin` link appears in the
sidebar only after a panel session exists).

**Credentials live on the server only.** `lib/admin.mjs` keeps the username and
password as SHA-256 digests and compares them in constant time; neither string
exists anywhere under `public/`, and no API response ever echoes them. Signing in
issues a random session token (30 minutes idle, 8 hours absolute) which the
browser keeps in `sessionStorage`. Six failed attempts within ten minutes trip a
cooldown that also refuses the correct password.

What the panel reports, refreshed every 20 seconds:

| Block | Contents |
| --- | --- |
| Status | overall pass/fail with the failing probe named |
| API & host health | catalogue index, live API, public site, catalogue mirrors — each with latency |
| Upstream token | source, expiry and a redacted prefix; never the token |
| Traffic | 30-minute sparkline, success rate, data requests, bytes served, errors |
| Requests by route | which routes this instance actually served |
| Slowest / Errors | the eight slowest samples and the last twenty 5xx |
| Self-healing | repairs made, quarantined signers and the ladder, relay faults, budget |
| CDN | what Vercel's cache did with the responses this instance produced |
| Deployment | commit, environment, region, Node version |
| Runtime & data | uptime, memory, catalogue size |

Numbers are per warm server instance (Vercel functions are stateless between
cold starts), which the panel states plainly rather than implying a global
counter. Traffic is sampled inside `cors(res, req)` — the one call every API
route already makes — so a new route is counted without being instrumented.

Rendering note: `scripts/preview-admin.mjs` draws the panel to
`design/admin-panel.png` from a live `/api/admin?action=stats` payload using the
real stylesheet. It is a dev-only check (there is no browser in CI).

## Live deployment

**https://arsvibe-pw-sepia.vercel.app**

The project is named `arsvibe-pw` on Vercel. `eduvibe-pw-sepia.vercel.app` still serves the
same deployment, so existing links keep working; the `arsvibe-pw-…` URL is the one to share.

Every page and API route below is running against the live PW catalogue — no fixtures, no
placeholders. Verified end to end from the deployment itself: catalogue (14,201 batches),
batch detail with 12 subjects, chapter lists, lecture lists, class-note PDFs, DPPs, the PDF
relay, and a signed HLS manifest plus its AES key and encrypted segments.

### Deploy your own

The repository is Vercel-ready:

* framework: **Other**, output directory `public/`
* build command: `npm run build` — runs `scripts/build.mjs`, which validates the page/function
  tree and runs `scripts/check-modules.mjs` (catches imports a page module forgot to add)
* functions: `api/*.mjs`, Node runtime, 60 s max duration
* `cleanUrls` enabled so `/batches.html` is served as `/batches`
* `.vercelignore` drops `legacy/`, `tests/` and the uncompressed catalogue, but **keeps
  `scripts/` and `data/batches.json.gz`** (the build and `/api/batches` need them)

```bash
npm i -g vercel
vercel --prod
```

## Tests

```bash
npm test        # node --test tests/*.test.mjs
```

174 tests, all offline: a fixture upstream is booted on port 4181 and the dev server on 4180, then
each page module is executed in jsdom and asserted. Coverage includes page rendering, the
API contracts, catalogue completeness (the last page is reachable and a batch the upstream search
cannot see is findable), stream planning (rendition fallback, signer failover and YouTube embeds
included), the `GetPdf` note resolution
path, the `/api/sign` relay (token auth, playlist rewriting, key-path recovery), the no-video
explanations, the lecture stream bootstrap, and the self-healer itself: signer demotion and
quarantine, the demotion surviving a bad minute, cache eviction per failure class, the repair
beacon's payload, the backoff ladder and the hourly repair budget, and the offline saver
(twenty tests over playlist parsing, slice completeness, AES decryption, filenames and the
byte ceiling).

## Notes

* Progress (resume position, recent batches, saved PDFs) is stored in your browser only.
* Login is local — "Bypass Login" and the Google sheet generate a device-local profile.
* All lecture content, notes and artwork belong to Physics Wallah / ArsVibe; this project is a
  UI layer that reads their public API.
