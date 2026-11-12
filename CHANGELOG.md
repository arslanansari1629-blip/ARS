# Changelog

---

## Round AV — today's classes, on every batch

"add live class in everybatch." The source site opens a batch page with today's
timetable; this one buried the schedule a level deeper, inside each chapter's
lecture list, where nobody looks at 10:25.

**What was actually missing was an endpoint.** PW has no batch-level schedule
route that answers a guest. Every spelling was probed against production:

```
/v1/batches/<id>/schedule       404   (route does not exist)
/v2/batches/<id>/schedule       401
/v3/batches/<id>/schedule       401
/v2/batches/<id>/contents       401   (no subject)
/batch-schedule/batch/<id>      404
```

What *does* answer is the per-subject contents listing — the call the chapter pages
already make — and every row in it carries `startTime`, `endTime`, `lectureType`
and the video's real `duration`. So a batch's day is read the way PW's own app
reads it: one listing per subject, keep the rows that fall on today. `lib/today.mjs`
records that surface and the cap (ten subjects) that stops a forty-subject batch
from becoming forty upstream calls.

**A day is an IST day.** PW schedules against Indian time. The first version of
this used the device clock, which put a 21:30 class in yesterday for anyone
outside India — and made the feature impossible to test. `?now=` pins the clock, so
a test asserts "this class is live at 21:35" instead of only passing when CI
happens to run at the right minute.

**`endTime` cannot be trusted.** On a scheduled class PW copies `startTime` into
`endTime`, so a class is zero minutes long and "is it on now" answers *no* for
every class, always. The window comes from the duration (with a plausibility check
on a stated end), which is the only field that describes how long a class runs.

**Three states, three honest answers.**

- *Live / upcoming / finished* — the day's classes, on air first, each row saying
  which it is. A class that has not happened is **not** offered as a recording,
  even when a stream is attached to the row: that sends a student to a player
  holding an empty manifest. A finished class with a recording gets "Watch".
- *Nothing today* — one line, plus the next class by date and time. An empty day is
  ordinary; it does not get a panel, and 14,000 batch pages must not each open
  with an apology. The wording is "published", not "scheduled": the only surface a
  guest can read lists classes the source has *created*, so a slot PW has not
  published yet is invisible — and "nothing else is scheduled" would be a claim
  about a calendar this site cannot see.
- *Every listing refused* — **no strip at all.** "No classes today" on a refusal is
  a claim made on no evidence, and it is the kind of quiet lie that makes someone
  miss a class. The distinction between `empty` and `error` is pinned by a test.

Once the whole day is over, the strip adds one line naming the next class, because
three classes you cannot attend is not an answer on its own.

**Cost is contained.** The day is cached for a minute per batch, the listings for
ninety seconds, the detail read that finds the subjects bursts out at eight
seconds, and the strip is mounted without blocking the rest of the page — the hero
and the tabs do not wait for it.

**Tests:** 507 (was 472). 27 unit tests on the reader and the strip, 7 through the
dev server, 1 in jsdom on the real page. The fixture had to grow a `today.json`
that anchors its rows to the request's clock, because a fixture with fixed 2025
dates cannot test anything about "now" — and it serves them only for the batch the
day is demonstrated on, so a strip test cannot pass by reading a chapter's old
lectures as a timetable.

Two real bugs were caught by those tests while writing them: `parseDuration` read
`"45:00"` as 45 hours (three days in the future), and a `return` inside a
`forEach` silently listed only the first class of each subject and dropped the
rest.

Service worker `arsvibe-v6` → `v7`; `today.js` is pre-cached.

---

## Round AU — the Khazana tab, designed rather than assembled

"keep it in well proper and maintained." The tab had no real design: three
unrelated shapes depending on state — a bare `<p>` while reading, an `<h3>` plus a
grid when it worked, an unadorned notice when it did not. Switching tabs meant the
panel jumped height and the page moved under the reader's finger. The size of an
archive (17,429 lectures in the big ones) was buried in a sentence.

**One frame, seven states.** Everything now sits in `.khazana-panel` with an
eyebrow ("Khazana · archive" / "Khazana · notice"), a heading and a 68ch
explanation — the measure the rest of the site uses. The state decides only what
fills the frame, so the panel never reflows between "loading", "empty" and "here
it is".

**The figures are stated, not embedded.** Subjects, lectures and chapters are now
three labelled counters above the grid (`3 · 17,429 · 123`), because that is the
one thing worth knowing before scrolling. Numbers use Indian digit grouping, the
same as everywhere else on the site, and the header counts what the grid actually
draws.

**Cards match the Subjects tab** — same `.subject-card`, same 40px thumbnail, same
chevron. They *are* subjects; dressing them differently would suggest they behave
differently. Names clamp to two lines, meta lines truncate, so a long archive
subject cannot stretch a card.

**A skeleton while reading** in the shape the cards will take, so the panel does
not jump when the archive lands. Disabled under `prefers-reduced-motion`, along
with the shimmer.

Also fixed: `subject-grid` never had a base rule (it only ever existed as a
modifier on `.grid`), so the Khazana grid was relying on `.khazana-grid` alone.
It now uses the site's `.grid` base. `subject-thumb` got a real rule.

**Tests:** 472 (was 468). Four new ones: every state has the same frame and is
never empty; the header counts agree with the grid and use Indian grouping; a
card's numbers pluralise correctly ("1 chapter", not "1 chapters"); and every
class the module emits has a rule in the stylesheet — which is what caught the two
missing ones.

---

## Round AT — a batch's Khazana tab shows that batch's archive, and nothing else

The tab rendered two things: the batch's own linked archive, **and** a site-wide
list of the ten openable Khazana *batches*. That list was identical on all 14,201
batch pages, so a Class 10 UP Board student on Brahmastra got CA Foundation, JAIIB
and SSC Booster cards underneath their own archive — other exams' content, in
someone else's tab.

Removed from the tab. `khazanaMarkup` now renders one batch's archive and nothing
else, and `libraryMarkup` / `libraryCard` are gone rather than left as dead code
that a future caller could re-wire. `mountKhazana` still accepts `library` so call
sites do not break, but it is deliberately not drawn.

Those ten batches are unchanged and still reachable: `?search=khazana` returns all
of them from the shipped catalogue, which is where a cross-batch list belongs.

The empty state was rewritten to match — it no longer promises "the Khazana
batches that *can* be opened are listed below", because nothing is listed below it
any more. It says the batch has no archive, that its own subjects are unaffected,
and points at the catalogue search for the standalone Khazana batches.

**Tests:** 468. Three new ones assert the cross-batch list is *absent* — including
when a caller passes `library` anyway — and the page test now checks the tab for a
batch with an archive draws its own cards and zero foreign ones.

---

## Round AS — why the fix was deployed and you still saw the old page

Two separate reasons, both now fixed.

**1. The service worker was serving the old module, for ever.** `/assets/*` is
cache-first, keyed on `const VERSION = "arsvibe-v2"`. Rounds AQ and AR changed
`batch.js` and `data.js` and never bumped that string, so any browser that had
loaded the site once kept the *old* modules indefinitely: the deploy was green,
the file on the server was correct, and the browser never asked for it again. That
is the entire difference between "I fixed it" and "nothing changed on my screen".
`VERSION` is now `arsvibe-v3`, `batch.js` is in the shell pre-cache list, and a
test asserts the version is not the stale one — with a comment saying the real
rule: bump it whenever a cached asset changes, not only when the cache shape does.

**2. A race that reverted the tab.** `loadBatch` called `renderSubjects()`
unconditionally when its detail call landed, and `loadHeader` painted a skeleton
unconditionally when the header landed. Tap Khazana before either finishes and
whichever arrives last replaces the archive with the subject grid. On a cold
`/BatchInfo` — which is exactly the batch that was reported, a 9-subject UP Board
crash course — the detail call takes seconds, so this is the *normal* path, not an
edge case: the tab visibly fills in and is then silently thrown away. Both
repaints are now gated on `tab === "subjects"`.

The new test holds the detail call open, taps Khazana, waits for the archive
cards, *then* releases the detail call — and asserts the cards are still there.
Reverting either guard fails it.

**Tests:** 467 (was 465).

---

## Round AR — the Khazana tab that "did nothing", and why

**"when i click khazana nothing happen."** It was not a styling problem or a
dead button: the tab rendered a *notice* and stopped.

The tab decided whether to read an archive from `batch.khazana.programId`. That
field arrives with the full `/BatchInfo` document — but the batch page paints
from the **header** payload, and the header is served from the shipped catalogue,
which has **no `khazanaProgramId` column at all** (0 of 14,201 rows). So on every
batch on the site the tab found no pointer, wrote "No linked archive", and never
spent the one read that would have proved otherwise. Lakshya JEE 2025 was
reported as having no archive while `62cd3a81c521a200190acaca` sat behind it with
17,185 lectures across 4 subjects.

Worse, this path was never tested: the fixture batch carried no pointer either,
so every Khazana test exercised the *notice* branch and passed.

**1. The tab asks instead of assuming.** It now calls `?khazana=1`, which answers
the pointer without content, and only then reads the archive. A failed pointer
read reports "could not be reached" rather than inventing an absence — asserting
"no archive" is exactly the bug, one layer down.

**2. `program=` was being sent on the pointer read.** That parameter means "the id
above *is* an archive id, skip the lookup", which is right for every level below
the program and wrong for the one call whose whole job is to resolve a batch to
its archive. It made `?khazana=1` answer the batch id as its own pointer — a
pointer that resolves to nothing.

**3. The tab no longer re-renders itself from the batch load.** It owns its read
now; re-entering it while the first attempt was in flight raced two readers onto
the same tab body.

The fixture batch carries a pointer, and two new page tests click the tab for
real: the archive's subject cards must appear, must not say "No linked archive",
and must link to `/subject.html?…&archive=1` with the *program* id. Reverting the
fix makes the first one fail, which is the point of it.

**Tests:** 465 (was 462).

---

## Round AQ — coverage audited, and the DRM lecture that lied about itself

**"get all batch from there which are not on our site."** Audited properly, and
the honest answer is that **there are none**. The reference page advertises
18,568 batches; PW's own `/AllBatches` reports **13,631**, and our catalogue holds
**14,201** — a superset of the real list. Every id sampled from the reference
list (newest page, page 400, and the oldest page 680, 2021-era) was already
present, as were all 1,401 sub-batch ids referenced by the catalogue. A new
`scripts/audit-coverage.mjs` walks all 682 upstream pages and counts the gap
instead of sampling it, so this is answerable on demand rather than argued.

**1. `?q=` was silently ignored.** `/api/batches?q=Lakshya JEE 2025` returned
`total: 14201` — the whole catalogue, unfiltered. A wrong parameter that answers
with plausible data is worse than one that errors, because the page renders and
looks like a search finding nothing. `q` is now an alias for the documented
`search`, with `search` winning when both are present, and a blank term is not a
term. (The site's own search box was never affected — it sends `search=` — but
bookmarks and API callers were.)

**2. DRM lectures blamed the wrong thing.** A real lecture in CA Foundation
Khazana 2026 reported:

> "This lecture is hosted outside the PW CDN, so it cannot be relayed here."

about `https://d1d34p8vz63oiq.cloudfront.net/drm/7e2dfafb-…/master.mpd` — the
CDN this site relays every day. `parseFolder()` required the uuid to follow the
host directly, so the `/drm/` segment made it return `""`, and every caller read
`""` as "not a PW asset". The pattern now tolerates `/drm/`, and `isDrmUrl()`
reports the separate, true fact: the recording is Widevine-encrypted and cannot
be relayed by anyone without a licence. The student now gets *"DRM-protected
lecture"* with a route to the notes and DPPs — which do open — instead of a
useless Retry button and an invitation to watch a stream that will not play.

**Verified working in a batch outside the JEE/NEET set:** CA Foundation Khazana
2026 resolves 4 subjects (Accounting 263 lectures, Business Laws 197, Quant 174,
Business Economics 183), chapters, lecture lists, and a real 480p HLS stream for
its non-DRM lectures. Eklavya Maharashtra 2.0 resolves 6 subjects and correctly
reports `state: none` for an archive — PW ships no pointer there, and saying so
is the right answer.

**Tests:** 462 (was 458).

---

## Round AP — every batch, and the shapes PW actually uses

**"use his api convert to our api and make khazana working in everybatch."**

Studying the reference URLs turned up four things that were still wrong, none of
them in the code I had been looking at:

**1. A "program" is two different things.** `697c6370…` (Udaan English Khazana
2027) is a *course*: subjects are Physics, Chemistry, Biology. `62cc7a39…` — the
archive attached to the named Khazana batch "Power Batch : 11th Khazana JEE" — is
an *archive*: subjects are "Complete Physics - 11th", and **5,669 lectures across
659 topics**. Same endpoints, completely different shape. `programShape()` now
tells the page which it is holding.

**2. Every chapter in an archive is called "Physics by".** 30 of them, differing
only in `description` (`"Saleem Ahmad Sir; Arjuna JEE 2026"`). Thirty identical
rows are thirty identical clicks. `disambiguate()` promotes the distinguishing
part to the display name — "Physics by — Arjuna JEE 2026" — and only when the
plain name is ambiguous, so small archives still read cleanly.

**3. Topics were silently truncated at 20.** A chapter reports up to 39 topics and
the endpoint's default page size is 20. Worse: the topics that survived were the
*empty* ones, because emptying out competes with truncating. The call now asks
for `limit=100`. Verified: 39 topics, all of them.

**4. Plenty of batches had no subject list at all.** `/v3/batches/<id>/details`
answers a guest for newer batches, but named Khazana batches come back
`subjects: null` or 401. **`/v1/batches/<id>/subjects` accepts a guest token** and
returns the same rows. That fallback is what makes the named-Khazana half work —
"working in every batch" was, for those, a missing one-version-back call.

Also: `v2/programs/contents` ignores `page` entirely (page 2 replays page 1), so
the contents reader walks pages until one adds nothing new rather than looping.

**Tests:** 458 (was 452). The new ones assert course-vs-archive, distinct chapter
labels, one-answer contents, and that the topics call asks for the whole chapter.

---

## Round AO — Khazana, actually working

**"khazana not working fix it yaar … make a proxy and make it workable."** Right
again, and this time the bug was mine: I had concluded the linked archive was paid
because I only ever probed `/v3/programs/*`, which answers **404 for every id**.
The archive is a *program*, and programs are served by `v1`/`v2`.

**What the live source actually answers** (guest credential, no subscriber):

```
/v1/programs/<p>/subjects                                         9 subjects
/v2/programs/<p>/subjects/<subjectId>/chapters                    "Physics by"
/v1/programs/<p>/subjects/<subjectSlug>/chapters/<slug>/topics    5 topics
/v1/…/topics/<topicSlug>/contents/sub-topic                       Lectures · Notes · DPPs
/v2/programs/contents?programId=&subjectId=&chapterId=&topicId=   the lectures
```

That last one returns `videoUrl` → `d1d34p8vz63oiq.cloudfront.net/…/master.mpd`.
Fed to this deployment's own `/api/stream?url=`, it answers
`playable: true` with 480/360/240 renditions. **The lectures play.**

**The proxy.** Five levels, all on `/api/batch` (staying at ten functions):
`?khazana=subjects|chapters|topics|sections|contents`. Server-side, against PW's
v1/v2 program surface — no third-party relay, and the browser never talks to
`proxy.streamvideo.co.in`.

**The pages.** The Khazana tab now lists the archive's subjects with their real
lecture counts. Subject → chapter → topic → lecture is a real walk:

| new | what it draws |
| --- | --- |
| `public/assets/khazana.js` | archive subjects, with counts and images |
| `public/assets/subject.js` | the archive's chapter list (`archive=1`) |
| `public/assets/chapter.js` | a chapter's topics, then a topic's lectures + notes |
| `public/assets/lecture.js` | plays an archive lecture from its CloudFront URL |
| `lib/khazana-program.mjs` | normalisers for all five levels |

Two address shapes had to travel through the links: the topic call is
**slug**-addressed, the lecture call is **id**-addressed. Both ride in the query,
so a click is never a guess.

**Reported, not obeyed.** `isPurchased: false` on some lectures is PW's own
entitlement flag. The row is listed and labelled, and it still opens when the
source serves the video. Nothing is filtered out on that flag.

**Tests.** 452 pass (was 447): five new e2e tests walk subject → chapter → topic
→ lecture through the real route and assert a lecture comes back with a playable
`.mpd` URL; `tests/fixtures/program.json` records the surface so it is all
testable offline.

---

## Round AM — Khazana, corrected

**The push-back was right.** "make khazana working — see how he runs it."

**What I had got wrong.** I treated Khazana as one thing: the `khazanaProgramId`
archive linked inside a batch, which is paid and answers every guest token with
401. That is real, and it is a footnote. Khazana is *also* a product PW sells as
its own batch, and there are ten of those in the catalogue:

```
CA Foundation Khazana 2026            6970a2f313f87bdb24cd4934
SSC Khazana for Exam 2026             6881f5ec021fa11ef316143b
CA Inter Sep 2026 Group 1 Khazana     68ec896b807049bc648ac2cc
SSC CGL Khazana Booster 2025          689ac17c1654399508d70db1
… and six more
```

Note what those batches are *not* missing: they have no `khazanaProgramId` at all.
The tab took that as "no Khazana here", when it meant "this batch **is** the
Khazana". A batch called "CA Foundation Khazana 2026" with 263 Accounting
lectures is the feature working, not the feature gated.

**Verified before changing anything**, against production: `70+ chapters` on CA
Foundation Khazana 2026, chapters resolving with videos and notes on
`/api/contents`, and `SSC Khazana for Exam 2026` returning five subjects. Nothing
in the working path needs a token.

**What changed.** `lib/khazana.mjs` gained `khazanaLibrary()` — derived from the
catalogue at request time, free batches first, so a new Khazana batch appears
without a rebuild. The list rides on **both** the header and the full batch
payload, because the tab is painted by whichever wins and leaving it off the
header would have made the best content depend on the slowest request. The tab
now draws that list first and the linked archive underneath it.

**The defect I had written into a test.** One test asserted "the catalogue must
yield at least one Khazana batch" against `localCatalogPage(1, 100)` — the first
page of the curated catalogue happens to hold none, and the production path falls
back to the search index. The test now exercises `khazanaBatchList()`, the code
the server actually runs, rather than a simplification of it.

**Gates.** `npm test` **447/447** (was 440) · 18 pages / 10 API functions /
46 assets · 10 of 12 serverless functions.

---


What changed, in the order it shipped. Each round was built, tested and deployed to
<https://arsvibe-pw-sepia.vercel.app> before the next one started.

---

## Round AL — Khazana on every batch page

**The request.** "now add khazan in every batch like this vidcloud.eu.org — do this
and add working khazana in every batch."

**What Khazana turned out to be.** Not a page, not a player: Physics Wallah's
**archive of older lecture sets**, bundled inside newer batches. It is in the API
this site already speaks to, and nearly every real batch carries a pointer:

```
/v3/batches/<id>/details → "khazanaProgramId": "62cc7a39ea773600110bec2f"
                         → "pitaraProgramId":  "65409470e66ab5001863bbd8"
```

**The part that decided the design.** Attaching the pointer is free. Reading the
archive is not. Verified against the live upstream before any code was written:
`/v3/batches/<archive>/subjects` → **401**, `/details` → **400 Invalid Batch**,
four program shapes → **404**, all five mirror hosts → 404, and a freshly minted
guest token → **still 401**. Khazana is paid content; this deployment mints guest
tokens. There is no endpoint or mirror that changes that.

So the honest deliverable is a tab that is **correct in every state and complete
the moment a subscriber token exists**, rather than one that draws an empty grid
and labels it Khazana:

- **`lib/khazana.mjs` — the reader.** Classifies every answer into one of
  `none · known · locked · invalid · empty · ok · error`. One refusal does not
  stop the ladder (the first shape answering 401 must not hide a later shape
  answering 200), a 200 with unusable rows falls through instead of becoming a
  successful blank grid, and an unknown state fails *safe* — attention, not
  healthy.
- **`/api/batch?khazana=1|read`.** On the existing function, not a new one: the
  deployment holds ten of twelve. `1` returns the pointer and spends nothing;
  `read` walks the shapes and returns the state, the subjects, and `tried` — what
  each shape said — as evidence an operator can disagree with.
- **The tab, on all 14,201 batches.** `Khazana` beside DPP Tests, plus a
  `#khazana` deep link. Renders from the pointer the page already has; a batch
  without one makes **no request at all**, which is most of the catalogue.
- **Archive subject links carry the archive id**, not the batch id — a batch id
  there would silently list the current year's chapters under an archive heading.

**What turns it on.** `PW_TOKEN` holding a subscribed bearer. No code change:
the `ok` path starts returning subjects and the tab lists them.

**A defect the deploy caught.** The first live read said "the archive could not be
reached — this is a network read" for an archive that was answering 401.
`upstreamJson` returned `status: 0` for every failed request whatever the HTTP
status was, so a refusal, a bad pointer, a missing shape and a dead socket were
one value — and the tab told a student the site was broken when the truth was
"this content is paid". It now carries the upstream's own status and reserves 0
for "no answer arrived". The refusal path is fixtured and pinned at both layers.

**Two defects the tests caught.** `slug` fell back to `_id`, producing links that
look like content and 404 on click — a row that cannot be opened is not content.
And `archiveVerdict` reported an unrecognised state as healthy; it now fails safe.

**"Working" meant more than listing.** Chapters come from `SubjectInfo?BatchId=`,
so an archive that answers in program form would have produced rows that 404 on
click. The reader now checks whether the id can actually be opened before it
claims `ok`, and reports `invalid` with the reason instead of a grid of dead links.

**Gates.** `npm test` **440/440** (was 402) · build 14,201 batches / 18 pages /
10 API functions / 46 assets · `check-modules` 32 modules.

---

## Round AK — the browser is finally an instrument

**The request.** "upgrade player and self healing system so know it can detect any
bug on the site."

**What "any bug" honestly means.** Every instrument the site had was on the server:
HTTP status, the content contract, the probe suite, the scanner. All of them share
one blind spot, and it is the largest kind of bug there is — **a page that answers
200 and then throws in the browser.** The response was perfect. The server logged
nothing. The content contract passed. And the visitor is looking at an empty grid.
No amount of server-side scanning can see it, because the failure happens after the
response was already sent. That class of bug is now visible; nothing here claims to
see a defect that leaves no observable trace.

**What shipped.**

- **`public/assets/telemetry.js` — the missing sense.** Listens to `error`,
  `unhandledrejection`, and resource-load `error` in the capture phase (a module
  that 404s does not bubble). It reports **aggregated evidence, not exceptions**:
  faults are bucketed by a `kind|message|source:line` fingerprint, counted locally,
  and at most six are sent per page view. Discipline that keeps a self-reporting
  client from becoming its own outage: nothing personal leaves the page (query
  strings, JWTs and emails are stripped), every call is wrapped, the beacon is
  `keepalive`, and a clean page view sends nothing at all.
- **`lib/client-errors.mjs` — the receiving end.** A bounded ring buffer: 80
  fingerprints, 6 h lifetime, one row per bug with a count, a page and a first/last
  sighting. It **re-scrubs** everything the client claims to have scrubbed, refuses
  to echo what other visitors reported, and answers rather than complains when a
  broken page sends it an unreadable body. Shared across instances through one store
  document (`arsvibe:client-faults:v1`) — a report landing on a different lambda than
  the panel reads it from was the exact bug the scanner's `sharedAt` taught us to
  look for.
- **`client.errors` / `client.recover` in the healer.** A seventh probe
  ("Browser script errors"), a thirteenth known symptom, and a three-rung ladder —
  drop the caches a stale module could be served from, re-mint the token, then check
  the asset manifest. It ends in an operator, because a code fault is not something
  a server can repair. **One visitor hitting one exception is not a broken site** —
  the probe needs five occurrences or two distinct faults before it trips, which is
  what stops a monitoring panel from teaching its operator to ignore it.
- **The player can now hear silence.** Its old recovery all waited for an *event*.
  A stream that wedges emits none: the element says `playing`, `timeupdate` simply
  stops, and the student watches a still frame. A once-a-minute heartbeat compares
  the playhead with where it was; one stuck minute gets a fresh plan, a second gets
  **reported**, and then the beat *stops* — a watchdog that keeps retrying a stream
  that keeps freezing is a retry storm dressed as diligence. `visibilitychange`
  covers the backgrounded tab that comes back wedged, and `health()` exposes the
  whole reading.
- **Silent storage failures are no longer silent.** `downloader.js` reported
  nothing when IndexedDB could not be opened or a transaction failed, so "your
  saved lectures are unreadable" and "you have no saved lectures" looked identical.
  Both now report through the same channel.
- **The panel reports on itself.** A `render()` that threw used to surface only as
  a dead "live" dot — indistinguishable from a network problem. It now says the
  page could not render the answer, and reports it through the same channel.
- **A build guard.** Every one of the 18 pages must load the telemetry module; a
  page without it is blind to its own worst failure mode, and `scripts/build.mjs`
  now refuses the build if one is missing.

**Verification worth naming.** The player's new watchdog was proven with mock
timers against the *real* interval, not a copy of its logic — and the first version
of that test failed, because the heartbeat reset its own counter after reporting and
retried forever. The test found a real retry storm. `wireHealer()` had the same kind
of seam: it ignored any argument it did not declare, so the `client` handle was
silently dropped and the probe reported itself *skipped* — which the panel draws as
healthy. Both are fixed and pinned.

**Gates.** `npm test` **402/402** (was 354) · build 14,201 batches / 18 pages /
10 API functions / 45 assets · `check-modules` 31 modules.

---

## Round AI — the site scans itself every five minutes, and repairs what it finds

**The request.** "make self healing system ultra it scan full site every 5
minutes and if found any issue then fix it."

**The first thing the request ran into.** Vercel's Hobby plan **rejects any cron
that fires more than once a day, at deploy time.** A `*/5 * * * *` line in
`vercel.json` does not make a slow scheduler — it fails the deployment and takes
production with it. So "every five minutes" could not be a cron expression, and the
honest options had to be built instead of faked:

| Channel | What it really does |
| --- | --- |
| **On traffic** | any request to the site may run one *slice*, at most once per five minutes. Steady traffic is a five-minute scanner. |
| **Deployment cron** | a daily floor at 03:00 UTC — the most a Hobby plan allows. |
| **External pinger** | `POST /api/scan` with `x-scan-key` — the only true five-minute pass on this plan. |

The panel draws all three and marks which are live, including the one that is not
configured. It never prints "every 5 minutes" over a job that does not run.

**What shipped.**

- **`lib/scanner.mjs` — the eyes.** 18 pages (status, content type, the
  `#main` landmark and a per-page content contract, so a soft 404 served with a
  200 is caught), the not-found shell on a real missing URL, the public API routes
  *including answer shape* (`200 {success:false}` is a failure), the asset manifest
  against the disk, and a **window of real batches**: page → `/api/batch` →
  `/api/contents` → DPP papers → PDF magic bytes.
- **A cursor, not a lie.** 18 pages, 10 routes and 14,201 batches do not fit in a
  request, so a pass is a *budgeted slice* that saves where it stopped. Consecutive
  slices walk the whole catalogue and wrap; `perMille` is the honest coverage
  number and "no full cycle yet" means exactly that.
- **A blind spot is not an outage.** If the function cannot reach its own public
  origin, that is *one* finding with no symptom and the sentence "set SELF_BASE" —
  not eighteen broken pages the healer would then try to repair.
- **`lib/scheduler.mjs` — the clock.** A five-minute tick that is two number
  comparisons when it is not time, detaches its slice (`waitUntil` where the
  runtime offers it), never overlaps itself, and restores its cursor from a store
  after a cold start so a scaled-to-zero function resumes rather than restarting.
- **`lib/store.mjs`** — the leaderboard's document store, lifted into a keyed
  `readDoc`/`writeDoc` so the scheduler does not grow a second storage driver.
- **The scanner reports; the healer repairs.** Two new symptoms with real ladders
  (`site.page` → reload the index, then re-request; `api.route` → drop caches, then
  re-mint; `api.upstream` → fresh token, cached answers, signer evidence) and
  `reportFault()` so a sighting is recorded as *degraded* without counting a
  strike — an escalation ladder that climbs on observation is one that nukes the
  caches every time a network blips.
- **Routes.** `GET /api/scan` (coverage only, never findings, never a scan),
  `POST /api/scan` (key or session), `GET|POST /api/admin?action=site`, and the
  scanner's report riding along on the existing stats poll. Still **10 serverless
  functions** — `/api/scan` is a rewrite onto the admin function.
- **The panel** gained a scanner section: the coverage bar and its per-mille, the
  three clocks, every open finding with the repair route it takes (or *operator*),
  the blind spots drawn differently, the store's honesty line, and what has been
  repaired and cleared.
- **A bug the tests caught before it shipped:** the batch walk was asking
  `/api/batch?id=…&header=1`, and the slim header answers `subjects: null` *by
  design* — so the first version would have reported every batch on the site as
  having no subjects. The walk now uses the full answer.

**Gates.** 22 new scanner/scheduler tests (coverage arithmetic, wrap-around,
full-cycle detection, budget honesty, blind spots, the fault handoff, cold-start
restore, the channel report) and 2 new route tests against the dev server; the
whole suite is green, the build validators pass, and the function count is still 10.

---

## Round AH — a healer with a state machine, and an admin panel that shows its work

**The request.** "`/admin` upgrade it and self healing system ultra advance."

**The problem with the old one.** Self-healing existed, but it was *reactive and
invisible*: a visitor's failed request reported a fault, a cache was dropped, the
operator found out by reading a list of things that had already happened. It could
not answer "is anything wrong right now?" without waiting for traffic, and it had
no notion of trying harder — one cache drop, then silence, whether or not the drop
fixed anything.

**What shipped.** A healer is now a **state machine over six probes and six
repairs**, and the panel draws every part of it:

- **It looks, instead of waiting.** Probes for the catalogue index, the guest-token
  ladder, every signing host, the playback relay, the request error rate and this
  instance's heap. Each returns a number with a unit, a verdict and the reason — so
  the panel can show the reading, not just a colour.
- **Five lifecycle states**: healthy → degraded → repairing → repaired →
  escalated → failed. A fault climbs **one rung of its repair ladder per strike**:
  the token is re-minted from the cache first and from the signer second; the ladder
  is re-ordered from fresh evidence first and quarantined second; the caches go
  plans → renditions → both. Recovery is the *only* thing that lowers the rung, so
  Monday's outage cannot hand Tuesday a sledgehammer.
- **It stops.** "Could not look" is never evidence (a probe that times out or throws
  triggers nothing), every repair has a cooldown and shares an hourly budget, and a
  fault that runs out of rungs is marked **failed** and left alone with a sentence
  saying exactly what needs an operator. Nothing loops.
- **`GET /api/admin?action=heal`** reports; **`POST`** repairs. A GET never changes
  the site — otherwise the page an operator reloads to look at a fault would be what
  fixes it, and they could never see the state they were paged about.
- **The panel** gained the lifecycle strip, the probe table, a card per fault with
  its ladder and a **Fix now** button, the budget and cache holdings, the repair
  ledger, and a collapsible record of every state transition with its reason. It
  rides along with the ordinary stats poll, so watching costs no extra request.

**The bugs the tests found, which is the point of writing them.**

1. **A repair that quietly failed to fix anything never counted as a strike**, so
   the ladder could not climb and the same futile action would repeat forever. A
   returning fault is now a strike; a repair that throws is a second kind.
2. **A timed-out probe leaked its timer**, and because the timer was `unref`'d the
   deadline could never fire when nothing else was pending — a sweep could hang
   until the lambda was killed.
3. **A `failed` symptom was retried on the next sweep**, undoing the one guarantee
   that matters. It now waits for a recovery or an operator.
4. **The budget counted its own "budget exhausted" marker**, so a spent budget read
   "13 of 12" — which reads as a bug in the ledger rather than a deliberate stop.

**Honest limit.** The healer's memory is one instance's, like the leaderboard's:
Vercel may run several, and each heals itself. That is the right scope for repairs —
a cache, a token and a signer ranking are per-instance facts — but the panel says
"this instance" everywhere it means it, rather than implying a fleet-wide view.

## Round AG — the DPP panel that only opened once

**The problem.** "DPP test panel is not opening." It opened the first time and then not
again — press the DPP Tests tab on a batch, look at About, come back, and the card said
"Looking for papers…" forever while the data was fine all along. The second half of the
complaint was the nav's own DPP Tests entry: it landed on a note explaining that papers
live in a batch's tab, which is a page *about* the feature rather than the feature.

**The bug.** `setTab` removed the `#dppPanel` node when the reader left the tab and kept
the module's reference to it. `renderDpp` saw a panel already built and returned early,
so nothing was ever re-mounted: the card was empty because the panel had been thrown
away. The panel is now kept as a *detached* node and re-attached — bindings, rows, filters
and all — and `renderDpp` never replaces a mounted panel with a loading line.

**What shipped.**

- **The batch DPP tab opens every time.** First, second and third visit paint the same
  paper list; the search box, subject filter and "looking for more" all still work after
  the round trip, because the DOM survives it rather than being rebuilt from markup.
- **The nav's DPP Tests entry lists papers.** It reads the batches already on the page —
  a bounded walk, three at a time, using the same collection code as the batch panel — and
  lists each paper with its batch, chapter and a Practice link, with its own search and a
  dismiss back to the catalogue. It is a panel over the catalogue, not a page instead of
  it: the catalogue stays, off-JS still shows the catalogue, and changing the search or
  page re-reads the panel because its papers described the page that was there.

**Tests.** `the batch DPP tab opens every time, not just the first` (three round trips,
then the search box must still filter) and `the nav's DPP Tests entry lists papers
instead of pointing at a batch`. The older jump test that asserted the "go open a batch"
copy was replaced — it was asserting the behaviour the user rejected.

## Round AF — XP, a daily streak, and a leaderboard

**The problem.** The site could record work and had nowhere to put the record. A student finished a
paper, saw a percentage, and that was the end of it: no accumulated standing, no reason to come back
tomorrow, and nothing that answered "am I actually keeping up?".

**What shipped.**

- **XP for finished work, from the marked result.** A DPP paper pays 50, its correct answers 6 each,
  a clean sweep 40 more; a finished lecture 15, twenty minutes actually watched 20, a class note 8.
  Levels widen as they rise (220 XP then +25% each), with names in the site's own register —
  starting sheet, set square, draftsman, surveyor, chief engineer.
- **A streak that says when it is at risk.** Five days of papers is a five-day run; the sixth day
  with no paper yet is *at risk*, stated, not quietly still running.
- **`/leaderboard.html`** — your standing, a seven-day strip, the board with your own row marked,
  where every point comes from, and the milestones ahead. The dashboard carries the same band.
- **`GET|POST /api/token?route=board`** — the board, folded into an existing function because the
  deployment is at the ten-function mark and Hobby allows twelve.

**The two bugs this round was really about.**

1. **The paper paid twice.** The base award, the marks, the perfect score and the daily were keyed
   separately, so re-sitting the same paper the same evening with two more right paid again — the
   cheapest possible exploit, discovered by the test that asserted a repeat pays nothing. A paper is
   one award; its marks are *components* of it, in `meta.breakdown`, and the key is the paper and the
   day.
2. **A stale tab could demote a student.** A row is the player's best score, but level and streak
   were being taken from whichever request arrived last — "800 XP, level 1". Whichever score wins
   now keeps its own level and streak; only the name and the timestamp refresh.

**Honest limit.** Without a store attached to the project, the board is one warm function instance's
memory. The route says exactly that (`store: "memory"`, `persistent: false`) and the page repeats
it, rather than calling one instance a worldwide ranking. Attaching `POSTGRES_URL` or
`KV_REST_API_URL` makes it real with no code change.

## Round AE — two things left owed

**A diagnostic that had become a public window.** `?probe=extract` was added to
answer one question — *why* a paper reads as control bytes — and it answers it by
returning a page of the paper's extracted text. Left open, that is a window onto
whatever PDF anyone names, refetched on this deployment's bill. It now asks for an
operator session (`x-admin-token`, or `&token=` for curl) and is silent otherwise.
The practice test beside it stays public, which is the line worth keeping straight:
a student's route into a paper, yes; a debugging hatch into arbitrary PDFs, no.

**One paper list, one implementation.** `collectDppPapers` existed twice — a copy in
`api/admin.mjs` and the exported one in `lib/dpp-paper.mjs` used by nothing. Both
walked chapters and flattened DPP attachments, and they had already begun to differ
in how they filter a chapter pool. The panel now calls the shared one, so a fix to
"which chapters carry papers" lands in one place.

## Round AD — the opening sheet

**The problem.** The site had no opening. `/` dropped a visitor straight into a hero and a
search box, which is efficient and says nothing about what this thing is — a drawing of the
whole Physics Wallah catalogue rather than another course storefront.

**What shipped.**

- **`/open`** — a title sequence in the site's own language: the plate traces itself on, the
  wordmark letterspaces in, the catalogue draws row by row while the live batch count counts up,
  the title block is stamped into the corner, a sweep crosses the sheet, and it lifts to the
  catalogue. Four seconds, once.
- **The front door opens it too.** The same sheet is laid over `/` on the first visit of a
  session and lifted without navigating, so the catalogue underneath keeps its scroll. It is the
  *same markup* — the home page fetches `/open` — and `/?open=1` replays it.
- **The count is finished, not frozen.** The batch figure counts up over frames, and a
  background tab throttles frames — so leaving early (or being suspended mid-count) settles the
  number on the figure the catalogue reports. A frozen "12,925" on the way out would be a wrong
  number, which is worse than no animation.
- **A sheet, not a gate.** Hidden states are scoped to a class the module adds, so the page is the
  finished drawing without JavaScript; the front door arms itself in `<head>` with a 5s failsafe
  that gives the page back if the module never arrives; `Esc`, `Enter`, `Space`, a click and the
  visible "Open the site" link all leave at any moment; and `prefers-reduced-motion` gets the
  still drawing with the exit in focus rather than a faster animation.

**The bug this round was really about.** An opening page fails in one of two ways: it is a gate,
or it flashes. The first pass was both — the overlay's markup only existed after a fetch, so the
hero appeared for a moment first, and the beat schedule lived in JS while the CSS carried its own
delays, so the sheet lifted on one clock and finished drawing on another. The shell now ships
with the page (invisible until filled), the beats are CSS delays only, and a test asserts the last
beat is over before the sheet lifts.

## Round AC — DPP practice: answer a paper, submit, read the analysis

**The problem.** Round AB made the *operator's* panel run a paper. A student still
had nothing to sit: the chapter's DPP tab offered five buttons around a PDF
(keep, open, download) and no way to answer anything. The feature existed and was
unreachable from the site.

**What shipped.**

- **`/dpp`** — a practice page. The paper's own time limit counts down, options are
  radio buttons, the palette shows which questions are still blank, `A`–`D` answers
  from the keyboard, and the attempt survives a refresh (per paper, in
  `localStorage`, dropped on submit).
- **`GET /api/pdf?dpp=<paper>`** returns the questions and options *without* the
  key; **`POST`** returns the marked attempt — score, percentage, and a
  per-question review saying what was asked, what was chosen and what the key says.
  The route rides on `api/pdf.mjs` because the deployment is at the 12-function cap.
- **Analysis, not just a score**: a ring, four counters (correct / wrong / skipped /
  not scorable), a "worth another look" line, and All / Wrong / Skipped filters over
  the review.
- **Every DPP row on a chapter page now has a `Practice` button.** Notes do not —
  a class note is reading material, and a button there would promise a test that
  does not exist.
- **The operator panel's runner asks the same public route**, so an operator cannot
  see the key before submitting either, and the same analysis filters are there.

**The bug this round was really about — two of them, in the same paragraph.**

1. The papers that ship are set with each option letter and its value as **separate
   text runs**: `(A) (B) (C) (D)` on one line, `5 4 2 3` on the next. Reading the
   page as a stream of lines pairs every letter with the wrong value — Q2's four
   options became "A is 4, B is 5".
2. Worse, and only visible on a *real* paper: PW sets **two questions side by side**
   to fit fourteen questions onto three pages. Question 1 is printed beside
   question 8. Grouping runs into visual lines and reading across therefore
   produced a "line" made of two unrelated questions, and Q1's options came back
   holding Q7's and Q8's values. Nothing threw. Every option looked plausible. The
   fixture that reproduced the first layout was single-column, so the tests were
   green while production was marking wrongly — which is the whole argument for
   checking the deployed build against a real paper instead of trusting a suite.

So there are now two readers: text order, and **positions** — runs grouped into
visual lines by `y`, columns inferred from where the question markers start, each
value given to the nearest marker to its left. A two-column page is read down the
left and then down the right, and the questions are re-sorted into the paper's own
numbering. Both readers run, the one that recovers more scorable questions wins,
and the response names it in `parser`.

3. And a third, which the column reader did not fix on its own: the gutter was put
   at the **midpoint** between the two columns' markers — x=170 for columns starting
   at 29 and 311. But the left column sets its options **two to a line**, so option
   `(B)` begins at x=165 and its value at x=181. The boundary ran straight through
   the middle of a question: `(B)` stayed left, its value went right, and Q2 came
   back with options A and C only. Again nothing threw. The gutter is now the
   columns' own **start** positions, and a run belongs to the last column that
   starts at or before it, so a value that sits a little to the right of its own
   letter stays with its question.

`lib/dpp-paper.mjs` is tested against three fixtures that reproduce the real DPP 11
geometry — single column, stacked values, and the two-column sheet whose expected
marking is the real paper's own key (14 of 14). The two-column fixture is not drawn
to look like the paper: its runs are the paper's own, **measured** — read back from
the deployed route with `?lines=1&runs=1` — including the two-options-to-a-line
left column, the 12.3pt values between 10.2pt letters, the 8.7pt superscripts, and
the 548x900pt sheet. The test fails outright if the column reader is removed *and*
if the gutter is moved back to the midpoint; both were checked rather than assumed.
The table-shaped answer key had a fourth instance of the same disease: it put each
question number and its letter in separate cells, and a cell-wise read was silently
dropping half the key.

4. And a fifth, found by reading the *deployed* paper rather than the fixture: the
   column start was rounded to a whole point (310.917 → 311). Rounding moved the
   right column's own markers outside the column, so every right-hand question was
   read as a bare `Q8` line among the left column's options — the paper came back with
   **nine** scorable questions instead of fourteen. The start is kept unrounded, and
   the fixture now sets its right column at fractional x too, so rounding cannot
   return quietly.
5. Smaller, but a student would have seen it: each page's furniture — the app's name,
   the batch, `DPP: 11`, the time limit — sits inside the right column's x-range, so it
   arrived after the left column's last question and was stitched into that question's
   stem. Q7 read "The decimal equivalent of 1/20 upto three significant figures is
   Master NCERT with PW Books APP JEE DPP: 11 30 min". The furniture is now removed
   run by run *before* the page is split, which is the only order that works: the time
   limit is three runs and one of them lands in each column.

**Every batch now has a DPP panel.** The papers were three levels down — a batch has
subjects, a subject has chapters, a chapter has a `DppNotes` tab — so reaching one was
five taps, and nothing anywhere said how many a batch had. The batch page gained a
**DPP Tests** tab that walks that tree once and lists the papers flat: a Practice
button and a PDF link on each, the chapter and subject it came from, a search box and
a subject filter, and the walk is progressive — papers appear as each chapter answers
rather than after the eleventh, with "still looking…" in the header while it runs.
The nav carries a DPP Tests link to match, which lands on the catalogue with a note
saying where the papers live.

The walk reads the catalogue's own DPP count per chapter (`exercises` — "Units and
Measurement" reports 11, the "Only PDF" chapters report 0) and visits the chapters
that hold papers first. That is the difference between the list filling in three
seconds and filling in twenty-five: a real subject carries 35 chapters and only a
handful of them have DPPs. Measured against the fixture batch, the first row lands in
141 ms and the walk finishes in 192 ms.

A finished attempt now leaves its score behind (`arsvibe.dpp.result.<paper>`), so the
row says **62% last time** and offers **Retry** instead of a blank Practice button as
if the paper were untouched. The answers themselves are still dropped on submit.

**Two papers that would not read, and the wrong thing said about them.** Sweeping the
chapter's papers after the fix, DPP 11 passed (`?check=1` → 14/14, 100%) and DPP 10
failed with "it is probably a scanned image". It is not a scan: it opens, it has 842
runs on page one, and every one of them extracts as control bytes — the PDF's font has
no character mapping. A student told their paper is "probably a scan" goes looking for
a scanner that is not there, and the real fault is hidden. Scans and broken-encoding
papers are now told apart by whether the extracted text has any letters in it, and each
gets an honest message. Neither can be turned into a test, and the page still offers
the PDF.

**And the door into the feature was broken.** A chapter's `Practice` button builds
the link the practice page opens; the link addressed the paper as `paper` while the
page read its address from `dpp`. So the button was present, looked right, and opened
"Pick a DPP paper first" — an empty page with no test on it. The page now reads
`dpp` or `paper`, the link sends both, and a test presses the real button, takes the
href it produced, opens *that* and waits for the questions. It was confirmed to fail
(the paper never loads) when the page goes back to reading only `dpp`.

**The check that should have existed first.** `GET …&check=1` marks a perfect attempt
— every question answered with the paper's own key, which the server reads itself —
and reports how many came back correct. Fourteen of fourteen means the options belong
to the right questions and the key belongs to the right numbers; a damaged read names
the questions that failed. It leaks nothing (the caller supplies no answers and the
response carries counts, not the key), and it is the one assertion that can be made
against a *deployed* paper — which is where every one of these bugs actually was. Both
the furniture test and the marking check were confirmed to fail when the code they
guard is broken.

That diagnostic is itself a hazard on a public route — it echoes the paper's lines,
and the paper's lines end with `Q1 (B) Q8 (D)`. It now stops at the answer key and
says how many lines it withheld; a test asserts none of the key's rows appear in it.

The practice page also had two bugs of its own, both found by driving it rather
than reading it: the failure branch called a `const` helper declared below it, so
the one case that must speak — a paper that will not load — threw and left a blank
page; and the media-relay fallback overwrote the paper's real error with its own
(`404` became `400`), so the message blamed this site's proxy instead of the dead
link. Both are covered now.

The three column bugs above were each found the same way — by reading the *deployed*
paper with `?lines=1` and comparing with the printed key — which is why the marking
check (`?check=1`) exists now, and why the two-column fixture is the paper's measured
runs rather than something drawn to look like it.

Three more found while building it:

- `scorePaper` keyed answers by index *or* question number and guessed between
  them; a paper numbered from 1 has `index 1 = question 2`, so a `number`-keyed
  payload marked the wrong question. The two are now explicit (`keyedBy`) and never
  mixed.
- The practice page restored a saved attempt *before* drawing the questions, so a
  restored answer had nothing to attach to. Restore now runs after the sheet.
- `scripts/build-paper-fixtures.mjs` writes two PDFs, one of them the hostile
  layout above; the fixture upstream serves both.

`/dpp` is in `robots.txt` as a disallow: every URL is a PDF that may disappear, and
there is nothing there to rank. 268 tests pass; 18 of them are new and 4 drive the
page itself in jsdom (answer → submit → analysis, refresh → restored, keyboard →
scored).

---

## Round AB — the DPP panel actually runs a paper

**The problem.** Round AA shipped a DPP panel that could *list* papers but not
open one. The list was real — PW serves the DPP index to a guest — but every
questions route (`/tests/<id>/questions`, `get-test`, `start-test`) answers 401
without a paid student session, on all five allowlisted hosts. A panel that says
"locked" is honest, but it is not a test panel.

**The way through.** The interactive quiz is locked; the *paper* is not. Every
DPP is also a PDF on `static.pw.live`, guest-readable, and it contains the
questions, the four options and the answer key. So the panel reads the PDF.

- **`lib/dpp-paper.mjs`** downloads a paper, extracts its text with `unpdf`,
  splits it into questions and options, and reads the answer key — which ships in
  two shapes (a `Q1 (B)` list and a `| Q1 | (B) |` table), both handled.
- **`?action=dpp-papers`** walks a subject's chapters and returns one PDF entry per
  lecture, attributed to its chapter. **`?action=dpp-paper&url=`** reads one paper
  and returns the parsed questions. Everything is proxied through this origin:
  the browser never talks to PW, and the CDN request is retried through
  `/api/media` when it refuses a bare server fetch.
- **The panel runs it as a test.** A countdown from the paper's own time limit,
  radio options, a live "N of M answered", and on submit: score, percentage,
  the right answer marked green, a wrong pick marked red, and every option locked.
  Answers are not in the DOM until submit. Running out of time submits.
- A question whose options could not be recovered is shown but **not scored**, and
  says so — a paper is never quietly shorter than it is.

**Two real bugs found on the way.**

- `unpdf` *detaches* the buffer it parses, so a paper that had just been read
  reported itself as 0 bytes. `extractPdfText` now copies before parsing, and a
  test pins it.
- `fetchChapterContents` read only `res.data.data`, but PW's current `/v2/…contents`
  route (and the fixture) wrap the rows twice. The second spelling produced an
  empty chapter with no error — the same class of bug the audit hit.

No new serverless function: three actions on `api/admin.mjs`. 249 tests pass.

---

## Round AA — the admin panel now audits content and reads DPPs

**The problem.** The panel could tell an operator that the site was up, how fast it
answered and what had just failed. It could not answer the two questions anyone
actually asks about a lecture site: *which lectures do not play, and why* — and
*are the DPP papers there, with their questions?* Both were guesswork.

**What changed.**

- **A content audit.** `GET /api/admin?action=audit` returns the last sweep, and
  `POST` starts one (`{batch, limit, subject?, chapter?}`, 409 if one is already
  running, a 50 s deadline). `lib/audit.mjs` walks the batch and puts every lecture
  in one of five states — `plays`, `pending`, `no-stream`, `broken`, `unknown` —
  using the same resolver the player uses, so a green row means a real signed stream
  resolved rather than a URL that merely existed.
- **`pending` is not a fault.** When the schedule carries no video URL it also
  carries `videoStatus` ("Not Ready"), and that is reported as *not published yet*
  and left uncoloured. Before the audit read that field it counted every live class
  as broken, which is how a panel trains an operator to ignore red.
- Rows are ordered worst-first and each has a **re-check** button
  (`POST ?action=rescan`) that re-resolves one lecture fresh and patches the row in
  place instead of losing the scroll position.
- **A DPP panel.** `GET /api/admin?action=dpp&batch=&subject=` lists the Daily
  Practice Problems for one subject and `?action=dpp-paper&id=` opens one. The list
  is keyed on the *batch-subject document id*, and a subject slug is resolved to it
  rather than quietly returning an empty list. A paper Physics Wallah will not serve
  to a guest is reported as **locked** with the reason, not as an empty test.
- `lib/dpp.mjs` strips Physics Wallah's HTML and decodes the maths entities that
  appear in real physics questions (`&deg;`, `&radic;`, `&omega;`, …) before the
  panel renders them as text.

No new serverless function: both features are actions on `api/admin.mjs`, so the
deployment stays inside the plan's 12-function limit.

**Fixed on the way through.** `scripts/check-modules.mjs` did not skip regex
literals, so `/[&<>"']/` in `admin.js` was read as an unterminated string, swallowed
the rest of the file and reported a phantom undefined call. Attribute values in the
audit and DPP rows now go through `escAttr` — a title containing a quote used to
break the row's markup.

---

## Round Z — the catalogue filters were filtering twenty rows

**The problem.** The catalogue is 14,201 batches across 711 pages, and every
filter ran in the browser over the twenty rows already on screen:

- The language dropdown was built from those same twenty rows, so it offered only
  the languages that happened to appear on page 1. Kannada — 70 batches — could
  not be reached through the UI at all.
- Choosing a language filtered the current page, usually to nothing, and said
  "Nothing on this page" as though the catalogue were empty.
- Sorting did the same, so "Price: low to high" sorted twenty arbitrary batches.
- "Free only" with an empty search box short-circuited to zero results, because a
  filter without a query was treated as a search for the empty string.

42% of the catalogue is free (5,854 batches), and none of that was reachable.

**What changed.**

- `lib/catalog.mjs` now applies language, price and sort over the whole catalogue
  before paging, and `searchLocalCatalog` accepts filters with no query at all —
  filtering is a browse, not an empty search.
- A new `?facets=1` endpoint returns every language with its count and the free
  and paid totals, cached for an hour. The dropdown says "Kannada (70)" and cannot
  offer the same language twice, because the source spells one language two ways
  (`Assamese` and `ASSAMESE` were splitting it in half).
- Misspellings are corrected for display (`Gujrati` → Gujarati, `Bangla` →
  Bengali) and the aliases are accepted as filter input.
- The result line reports a range — "1–20 of 14,201" — instead of hiding the scale
  behind a page number, and filtered views say how many matches exist beyond the
  first 80.
- Filters live in the URL, so a filtered view can be linked and reloaded.

**Second problem: the site promised what it could not do.** The home page said
"watch lectures", the hero said "HD lecture player", and the batch, subject,
chapter and lecture pages all described themselves as watchable in their meta
descriptions and structured data — while every playback request was refused.
Those strings were rewritten.

**Third problem: a permanent refusal was retried like a transient one.** A lecture
page with an unplayable stream retried three times with a widening pause —
about five seconds of spinner — and then showed the same message. Two bugs came
out of chasing it: `boot()` awaited a promise it never caught (so a stream error
abandoned the page on "Loading lecture…" with no message at all), and the player
spent up to 21 seconds trying three engine sources at seven seconds each before
falling back to native playback. The engine download is now bounded to nine
seconds total, with the same-origin copy given a short leash, and a refusal that
names an access limit is shown immediately with the chapter's notes as the
primary action.

**Tests.** 10 new. Several were written to fail against the old code:
the Kannada filter, the free/paid totals adding up, an empty search with filters,
a permanent refusal asked exactly once, and a check that no page description says
"free to watch".

---

## Round Z.2 — no banner, no promise the page cannot keep

**The problem.** Round Z added a dismissible notice under the nav explaining that
lecture playback needs a Physics Wallah account. That was the wrong shape of
honesty: a site that has to put a warning at the top of every page is telling you
its own copy is untrustworthy. A reader who dismisses the note never sees it again
and is back to pages claiming to watch things. So the note is gone, and the claims
are fixed instead.

**What changed.**

- The status notice is deleted — its container from all 15 pages, its module and
  storage key from `app.js`, and its stylesheet block from `arsvibe.css`. Nothing
  reads it, so nothing renders it.
- Every meta description that advertised playback now describes what the page
  actually holds. The home page promised "free, fast and open" browsing of
  lectures; it now says you can read every class note and DPP PDF. The batch page
  offered to "save lectures for offline"; the chapter page called its lectures
  "ready to play"; the dashboard reported "lectures watched"; the lecture page
  opened with "watch this lecture in a clean, ad-free player".
- The downloads page had the largest gap between copy and reality, so it was
  rewritten rather than patched. It was titled "Download lectures", headed "Watch
  without a connection", and documented portable MPEG-TS files with "no expiry"
  and a key that "travels inside" the playlist. It is now **Offline reading**,
  headed "Read without a connection", and says outright that lecture video cannot
  be saved because Physics Wallah only signs stream links for signed-in accounts.
  The five bullet points describe keeping notes and DPPs, which is the part that
  genuinely works offline.
- The login page promised every lecture "for FREE"; it now promises the thing a
  local sign-in actually does — syncing favourites, library and progress.
- The `og:description` on twelve pages carried the same playback sentence, so the
  fix is applied there too; a link shared in a study group no longer advertises a
  player that refuses to play.

**Tests.** The downloads-page test asserted the old copy — "Download lectures",
"MPEG-TS", "this device only" — so it was rewritten to pin the honest contract
instead: the page must say *Offline reading*, must mention notes and PDFs, must
state that video cannot be kept, and must **not** mention MPEG-TS. 193 total,
all passing.

**What the first pass missed.** Live-checking the deployed pages found the
promises that lived in UI chrome rather than prose:

- The hero carried a play-button chip reading **"Live lectures"** — the most
  prominent claim on the site, and wrong. It is now "Chapter-wise PDFs" with a
  document icon.
- `/downloads` still said a saved lecture "stays in this browser, and plays
  here", filtered "saved lectures", and reported storage as "0 B in lectures".
  All three now talk about saved files.
- The dashboard's "Watched on this device" counter can never move, because video
  never plays; it is now "Position saved". Its "Continue watching" panel is
  "Recent lectures".
- `viewer.html` had no `<h1>` at all — its document title was a `<div>`.
- `offline-boot.js` and `offline-page.js` bound `addEventListener` on the bare
  global instead of `window`, which throws wherever `window` is supplied as a
  value and aborted the whole module.

---

## Round Z.4 — the lecture list that would not open

**Reported as "lecture list are not open".** The list renders correctly when
Physics Wallah answers — the "Units and Measurement" chapter lists all 13 of its
lectures on production — so this is not a broken render path. It is what the page
does on the two occasions PW does not answer, and both were dead ends.

- **A 5xx or a timeout showed the browser's own words.** `explainUpstream` passed
  anything that was not a 401/403/404 straight through, so a transient refusal
  rendered as **"Could not load this section — fetch failed"**, or the relay's
  `upstream 502; upstream 502`. Both are machine strings, neither suggests
  retrying, and both read as "this site is broken" when the truth is their server
  had a bad minute. There is now a sentence for that case, on the server side in
  `explainUpstream` and in the browser relay fallback in `client-api.js`.
- **There was no retry.** The page offered nothing to click, so a reader whose
  request failed had to guess that reloading might help. A failed section now
  renders a **Try again** button that re-fetches just that tab, and the header
  stops saying "Loading the lecture list…" once it has given up.
- **Empty chapters were a dead end.** A subject lists chapters with 0 lectures,
  0 notes and 0 DPPs — eight of the 35 in that Physics subject — and the subject
  page labels them **"PDF only"**, which is wrong: there is no PDF either. Clicking
  one produced "No lectures yet / nothing published in this section" with no way
  forward. An empty section now offers the tabs that *do* have content and a link
  back to the subject's chapter list.

**On playback.** Asked again to make lectures play. The refusal stands, and the
reason is no longer an opinion: the non-DRM manifest PW publishes in its own
listing for that lecture (`.../master.mpd`) answers **`MissingKey`** — "Missing
Key-Pair-Id query parameter or cookie value". The path is PW's CDN, and the key
pair is only minted for a signed-in account's session. There are no bytes to
fetch without it, so there is nothing for this site to play, and forging the
signature is the line this project does not cross.

**Tests.** 197 total. Two new: a failed section must offer a retry and must never
print a raw browser error, and an empty section must link back to the subject.

---

## Round AB — start on a rung the line can hold

Round AA fixed the copy. This round is about the two seconds in front of the
first frame, which the copy was quietly talking around.

**The token was minted, then used.** Resolving a lecture asked the relay for a
guest token, waited for it, and only then probed the signer with it — two
network round trips in a row for one question. The mint now starts first and is
used *if it has landed*; a signer that accepts it costs nothing, and one that
refuses costs exactly one retry pass, which is what `!found.size && refused` is
for. Against a 250 ms stub fetch the cold path went **829 ms → 327 ms**, with the
mint accounting for about half of the old figure.

**Playback opened on the top rendition.** On a line that cannot sustain 1080,
hls.js fetches a segment, discovers it is behind, and steps down — so the first
seconds of every lecture were a spinner, and it was the player's own fault. A
cold start now opens in the *middle* of the ladder and steps up, which is the
direction that costs no visible wait. Every level is still in the master
playlist; this picks a starting point, it does not take anything away.

**A recovery now resumes at the quality the student had.** `playingQuality()`
reads the rung ABR is actually on — `loadLevel`, because `currentLevel` is `-1`
while auto — the player sends it as `&level=` on a retry, and the resolver opens
there. A level that vanished in a re-encode falls back to the middle and never
fails the plan.

**`/api/check` reports its own latency.** `timing` carries medians over the last
25 resolutions: `totalMs`, `tokenMs`, `probeMs`, `cachedShare`. "Is it faster" is
now answerable from production rather than from a stopwatch on my desk. The
instrumentation had a bug worth remembering: mismatched key names produced `null`
medians and reported nothing at all, so a test asserts the numbers are numbers.

**Then production said the number out loud, and it was still 2.2 s.** `/api/check`
carried `timing` for the first time and reported `totalMs 2206, tokenMs 2206,
probeMs 2206` — three labels on one number, and 2.2 s between the tap and the
manifest. Two more bugs, both mine:

- the mint was still *awaited* on the happy path. Overlapping the mint with the
  probe fixed the ordering, not the wait: when the signer answers an anonymous
  probe — which this one does — the request then sat out the whole mint for a
  token it never used. 2181 ms of 2182 ms was minting, for nothing.
- the probe waited for the **slowest** host. `Promise.all` resolves when every
  request settles, so one sleepy mirror set the latency of the whole lecture even
  after a healthy host had answered every rendition. It now resolves as soon as
  the ladder is settled; stragglers keep running because their answers are still
  what teach the healer which hosts to trust.

**And the instrument was lying.** `recordTiming` read `{total, token, probe}`
while the cold path passed `{totalMs, tokenMs, probeMs}`, so every sample recorded
zeros — and zeros look like a fast server. The token timer was also read after the
probe finished, which is why the three numbers were identical. Both are fixed, and
four tests now assert the medians are non-zero, distinct, and that a request which
never waited for the mint reports `tokenMs: 0` rather than borrowing the total.

**And then 2.2 s again, now correctly labelled.** With the timer fixed the numbers
were honest and unflattering: `totalMs 2372, tokenMs 4, probeMs 2371`. The mint
was never the problem — the probe was. It waited for the *whole ladder*, and the
player only needs *one* playable rendition to start; the other four are a quality
menu. The sweep now finishes 250 ms after the first answer and lets the rest land
in the cache: `renditions.settled` widens the same array for anyone who waits, so
a fast start does not quietly cost the student their quality choice.

**And then a change that measured faster and was worse.** The grace window did not
move the production number, so the remaining cost had to be the handshake: fifteen
concurrent requests to one mirror, each behind the others. Asking only the
healthiest host for the opening rendition first — one request — looked like a
2400 ms → 577 ms win on simulated load. Production disagreed:

```
before  renditions ["720","480","360","240"]   totalMs 2406
after   renditions ["720","480"]               totalMs 3156
```

Slower *and* two levels instead of four, because the simulated mirror answered
every rendition quickly and the real one does not. Reverted in full: a shorter
quality menu is not a latency win, it is a feature removed. The lesson is the
table above — a faster number is not a better player, and "measure it in
production" is not a formality.

**What the number actually was.** A chapter sweep on the live deployment — six
lectures, seven resolutions — reported `timing { samples: 7, totalMs: 612,
tokenMs: 9 }` while a single cold request to the same lecture reported 3285 ms.
The difference is not the probe: it is a cold serverless instance paying for
connection setup to the mirrors. That is the honest state of the latency work —
steady-state resolution is ~0.6 s, a cold instance is ~3 s, and the instrument now
tells you which one you measured instead of leaving you to guess.

**And the wait says what it is waiting for.** The last honest numbers were ~0.6 s
steady state and ~3 s on a cold instance, and a cold instance is not something the
player can remove — so the wait was made legible instead. The overlay now carries
a live line naming the real work ("Asking Physics Wallah for a signed link…") and a
running count, in a polite live region. "Preparing your lecture…" for eight seconds
is indistinguishable from a hung page; a number tells a student whether to keep
waiting or reload. The clock stops on every exit — error, success, overlay close —
because a counter that keeps running under an error message is worse than none.

**Tests.** 221 total. Ten in `tests/startup-latency.test.mjs`, one in
`tests/player.test.mjs` and one in `tests/stream-fastpath.test.mjs`; each was run
against the previous commit and made to fail first. One existing guard pinned the
exact template layout of the stream query string and broke when `&level=` was
added — it now asserts both parameters are sent.

---

## Round AA — playback works, and the site was saying it did not

**The correction first.** For several rounds this project told students that
lectures could not play, and the copy on the home page, the chapter page and
`/downloads` said so in plain words. That was wrong. Asking the deployment's own
health route:

```
/api/check?batch=…&id=69dce295b4ecb06768828339
→ plan: hls 720 · playlist 200 · 690 segments · key 16 bytes
  · segment 200, 536 KB · decrypt ok · mpegTs ok  → "plays"

/api/check?…&chapter=69dc843271d06abbf3869763&limit=6
→ 6 verified, 6 playing, 0 not playing
```

Signing, AES key resolution, segment relay and decryption all work. It was the
*diagnosis* that was stale, not the pipeline — an earlier signature refusal had
been fixed, the copy had not.

**The damage that did.** The site was actively telling users not to try. The home
hero read "Lecture playback and downloads are not available", the chapter list
carried "stream links need a PW account" under every chapter, the lecture page
answered an access-limit state with "Playing this needs a PW account", and
`/downloads` claimed twice that lecture video "cannot be kept" — while
`/api/download?mode=list` was happily listing 692 slices for that same lecture.
A working feature behind a sign saying it is broken is worse than a broken one.

**What the copy says now.** "Video ready" rows play; "Recording pending" means
the recording genuinely has not been published; lectures are kept in slices, so a
two-hour class takes a few minutes. Three tests were pinned to the old claims and
have been rewritten to pin the new ones — including one that now *forbids* the
site from claiming playback needs an account.

**Player.** Two additions, both about failures the player could not see:

- **Reconnect.** A dropped connection produces no fatal engine error and no stall
  with the playhead moving; the retry budget simply spends itself against a
  network that is not there. The player now listens for `online` and re-resolves
  — but only when the stream is actually broken, never from a hidden tab, and at
  most twice, so a flapping signal cannot become a retry loop against a
  rate-limited signer.
- **The seek slider.** It announced itself as `role="slider"` with
  `aria-valuemin=0 aria-valuemax=100` and then wrote only a percentage, so a
  screen reader read "73" with no unit. It now carries `aria-valuetext` as
  "30:00 of 1:53:19", a real `aria-valuemax` in seconds, and the keys the role
  implies: PageUp/PageDown (a tenth of the lecture, at least a minute) plus
  Home/End.

**Self-healing: a real gap.** `resolveStream` honoured `fresh` for the plan cache
and ignored it for the rendition cache, so a retry rebuilt its plan from rendition
data up to ten minutes old — the plan it had just decided was broken. Half a
bypass is worse than none, because it looks like a fresh probe. `fresh` now
clears both.

**Retries are fast now.** `api/stream` re-read the schedule on every retry: two
upstream calls with 25-second timeouts, to rediscover a video folder the page had
been playing from for the last hour. The player now sends the folder it knows, and
the route probes it directly. If that folder will not sign — a re-encoded
lecture — it falls through to the schedule exactly as before. The shortcut only
accepts a bare UUID, so it cannot be pointed anywhere else.

**Tests.** 206 total. New: the folder fast path (including the fallback that
proves the shortcut is never the reason a playable lecture reports unplayable),
the reconnect heal (fails with the listener removed), and the slider's announced
value (fails without `aria-valuetext`).

---

## Round Z.8 — the tabs were not tabs

**The problem.** The chapter page's section strip — Lectures / Notes / DPPs /
DPP Solutions — is the primary navigation on that page, and it was marked up as
four plain `<button>`s. Consequences, all invisible to a sighted mouse user:

- No `role="tab"`, no `role="tablist"`, no `aria-selected`. A screen reader
  announced "Lectures, button" with no way to tell which section was open, and
  the panel had no `role="tabpanel"` to be associated with.
- Every one of the four was its own Tab stop. Reaching the list meant pressing
  Tab five times, and a keyboard user had no arrow-key navigation between
  sections — the control did not behave like a tab strip in any respect except
  that clicking one swapped the content.
- The strip is horizontally scrollable, so a keyboard user who could not reach
  the last section had no way to discover it.

**What changed.** `chapter.html` carries the roles and a roving `tabindex`;
`chapter.js` keeps `aria-selected`, `tabindex`, the `.active` class and the
panel's `aria-labelledby` in sync on every render, and handles `ArrowLeft` /
`ArrowRight` (wrapping) plus `Home` / `End`. The panel is labelled by whichever
section is open, so the list is announced as "Lectures, tab panel" rather than
as an anonymous region.

**Tests.** 200 total. The new test drives the real page with real keyboard
events: it asserts one and only one Tab stop, that `ArrowRight` opens the next
section *and* moves focus and the panel label with it, that the arrows wrap, and
that `Home`/`End` reach the ends. Verified to fail against the previous markup.

---

## Round Z.7 — the warning belonged to the wrong tab

**The bug.** Round Z.5 taught the chapter page to say "Some files did not resolve
— **Load the rest**" when a notes tab came back shorter than the chapter really
is. The flag behind it, `partial`, was a single module-level variable, and every
tab switch goes through the same `load()`. Worse, it was reset *after* the
cache-hit early return:

```js
if (cache.has(type)) return render(cache.get(type));  // ← stale flag
partial = false;
```

So the flag belonged to whichever tab rendered *last*, and it was wrong in
both directions, silently:

- **notes (short) → any tab that fetches → notes.** The fetching tab reset
  `partial` to `false`; the cached notes tab then rendered with it. A tab showing
  3 of the chapter's 24 notes dropped its own warning and presented the short
  list as the whole chapter — exactly the failure Z.5 existed to prevent,
  reintroduced by a cache hit.
- **The reverse is a false alarm**: a complete list could wear the previous
  tab's "did not resolve".

**What changed.** `cache` is now `type -> { items, partial }`: the flag is stored
*with* the list it describes, so a cached render reports what that list actually
is. The empty-state tab suggestions read `.items` accordingly. Also, `fetchData`
now `await`s its normaliser — the browser-relay normaliser resolves keyless
attachments through `GetPdf` (Round Z.6) and is `async`.

**Tests.** 199 total. The new test opens a short notes tab, switches to a tab
that fetches, switches back, and requires the warning to still be there. It was
confirmed to fail against the previous `chapter.js` — the first version I wrote
passed by luck, because the tab I switched to happened to be one that never
renders a docs warning at all.

---

## Round Z.6 — the relay made up a PDF link

**The bug.** Round Z.5 fixed the resolver *on the server*. There is a second code
path with its own copy of the logic: when the server cannot reach PW at all,
`/api/contents` answers `{ needsProxy: true }` and `data.js` refetches the same
JSON in the browser through a CORS relay. Two faults lived there, and both were
invisible from the server-side tests because the server resolves the key before
it answers:

- `asset()` ends with `if (input._id) return base + "/" + input._id`. PW sends
  every Class Notes attachment with a `key` field that is **empty** — that is PW
  saying "this object has no storage key, ask `GetPdf`". The fallback ignored
  that and produced `https://static.pw.live/6a01ef0c6c4a24dd586b1d8c`: a URL
  that looks exactly like a real one. The row rendered a PDF badge, an **Open**
  and a **Download** button, and every one of them 403s.
- The relay never called `GetPdf`. So on this path nothing ever filled the gap,
  and the fabricated link was the *only* thing the student got.

The result is the worst shape a bug can take: a chapter whose notes look
complete and are all broken, with no way to tell that from the chapter simply not
having notes.

**What changed.** `public/assets/client-api.js`:

- `asset()` no longer invents a URL from an `_id` when the descriptor carries a
  `key`/`path` field that is empty. Descriptors with *no* key field at all (some
  cover images are addressed by id) still resolve, so nothing else regressed.
- `normalizeContents` and `normalizeSchedule` keep keyless attachments as
  `pending` instead of dropping them, then resolve them through
  `GetPdf?BatchId&SubjectId&PdfId&AttachmentId` at the same three-at-a-time
  concurrency the server uses — a 118-entry chapter asked all at once is
  throttled into returning nothing.
- Same cache discipline as the server: **only successes** are remembered, so one
  throttled response does not poison the attachment for the rest of the session.
- The relay now returns the same `diagnostics` shape the server route does, so
  the chapter page's "Some files did not resolve / **Load the rest**" affordance
  works identically on both paths. That includes dropping a row whose only
  attachment failed, rather than rendering it as "No file attached" — which would
  be a claim about the chapter instead of about the lookup.

**Tests.** 198 total. A new page test drives the real chapter page through the
relay path with PW throttling the first attempt, and asserts that no
`static.pw.live/<attachmentId>` link is ever rendered, that the tab says it is
short, and that the retry resolves the real key. Verified to fail against the
previous `client-api.js`.

---

## Round Z.5 — the notes tab was shorter than the chapter

**The bug.** Every note and DPP PDF arrives from PW's listing *without* a storage
key, so each attachment needs its own `GetPdf` lookup before its row can render.
That loop cached the result — but it cached **failures too**, writing
`undefined` under `pdfUrlCache`, and the guard read `url === undefined`. So a
single throttled `GetPdf` marked that attachment permanently unresolvable for
the life of the process. PW rate-limits these calls as a matter of course, so
this happened routinely: a chapter with 24 notes rendered 3, the rest invisible,
and reloading did not help because the "no" was already remembered. Only
successes are cached now.

**The second fault: unbounded work.** A long chapter is up to 120 listed entries
across six pages — 40 sequential rounds at three-at-a-time. Against a throttled
upstream that exceeds the function timeout, and the tab renders *nothing at all*
rather than a short list. The loop now has a 12-second deadline and reports what
it skipped as `diagnostics.skipped` instead of being killed mid-flight.

**Said out loud.** When a docs tab does come back short, it now says so — "Some
files did not resolve" with a **Load the rest** button that re-fetches — instead
of presenting an incomplete list as the chapter's true contents.

**Tests.** 197 total, plus a new `tests/notes-resolution.test.mjs` that drives
the real resolver against a stub upstream which throttles past `upstreamJson`'s
internal retry. It was verified to fail against the old cache and pass against
the new one, so it pins the fix rather than describing it.

The no-promise test now also rejects "Live lectures", "plays here" and "in
lectures", so chrome cannot drift back.

---

## Round Z.3 — the sort dropdown had a key collision

**The problem.** The price sort was encoded as `?sort=free` for "Price: high to
low" — the same string the price *filter* uses for "Free only". The two
controls therefore could not be reasoned about separately, and the sort was
silently dropped: `/api/batches?price=free&sort=price-asc` came back with
`filters.sort: "default"` and rows in catalogue order. Nothing errored, which is
why it survived the filter round.

**What changed.** Sort keys are now self-describing — `price-asc` and
`price-desc` — and cannot collide with `free` / `paid` / `all`:

- `lib/catalog.mjs` exports `normaliseSort`, which maps the old bookmarked keys
  (`price` → `price-asc`, `free` → `price-desc`) so existing links keep working,
  and `applyFilters` normalises before checking the sort set.
- `/api/batches` echoes the sort it actually applied rather than the raw query
  string, so a legacy `?sort=price` reports `price-asc` instead of a key the API
  no longer has.
- The dropdown values match, and `batches.js` resolves aliases when reading
  `?sort=`.

A new test asserts the two controls stay separate: no sort key may equal a price
filter value, and the legacy aliases keep their original meaning. 195 total.

**Also in this round: the install manifest.** `manifest.webmanifest` is what a
phone shows when someone installs the site, and its description still read
"Every Physics Wallah batch, chapter, lecture, class note and DPP … Works
offline once a lecture is saved", with a Downloads shortcut described as
"Lectures saved on this device". Both promised an offline lecture that cannot
exist. It now describes notes and DPPs, which do work offline.

---

## Round Y1 — a lecture that will not play now says why

**The problem.** A lecture whose stream URL was clearly present in the schedule —
a plain, non-DRM `master.mpd` — was reported as *"PW has not published a playable
stream for this lecture. It is either an upcoming live class, a notes-only entry,
or a video the source has not finished processing."* Every one of those
explanations was false. The recording existed; what failed was the step that turns
a folder into playable bytes.

**What changed.**

- The rendition probe now records *why* it came back empty — a 401/403 refusal, a
  signer it could not reach, or a genuine "no such rendition" — instead of
  collapsing all three into an empty list.
- The failure message is chosen from that evidence. A refusal now reads: the
  recording exists and its address is in the schedule, PW's signing service
  refuses to mint a playable link for it, this site holds only a guest session,
  and its notes and DPPs still open and download normally.
- A signer that cannot be reached is reported as a transport problem with a
  reload hint, no longer as "not published".
- The genuine case — every signer answering 404 — keeps the original message,
  because that one is true.

**Verified live.** A real lecture in Arjuna JEE 2027 returns the new sentence, with
`sourceUrl` still naming the real `.mpd` so the failure stays diagnosable. The
notes for the same lecture return 13 PDFs, and one was fetched and read end to
end — so the promise in the message is true, not hopeful.

**Tests.** 3 new (182 total): a signer refusal must not say "has not published",
an unreachable signer must read as transport, and the original no-rendition case
still passes.

---

## Round Y — an access limit is named as an access limit

**The problem.** A chapter with 148 lectures rendered as an *empty* chapter. PW
answers a guest session with 401 on the chapters and contents routes, and the
page turned that refusal into "this section has no content". Worse, the browser
then retried through a public relay with the same rejected guest credential, so
the wait was longer and the answer no better.

**What changed.**

- `lib/api-data.mjs` gained `explainUpstream()`. 401/403 becomes *"Physics Wallah
  is not serving this content to guest sessions right now. The catalogue and batch
  pages still work; the lectures under a chapter need a signed-in PW account,
  which this site does not have."* A 404 becomes *"Physics Wallah no longer serves
  this section at the address the catalogue points to."* The raw
  `upstream 401; upstream 404` string is gone.
- Both `/api/contents` and `/api/chapters` carry `auth: boolean`, `proxyFallback`
  propagates it, and the browser stops relaying when it is set — no second attempt
  with a credential that was just rejected.
- The chapter page renders "This chapter needs a PW account" with a link back to
  the batch list, and a quiet informational toast instead of a red error.

**Also fixed in this round.** `.toast.bad` and `.toast.info` had no CSS at all —
call sites were already using those names, so those toasts were unstyled. Both
exist now.

**Tests.** 2 new: an upstream auth refusal is reported as access rather than as an
empty chapter, and a migrated batch page is not reported as degraded.

---

## Round X — batch pages showed zero subjects, and that was fixed at the source

**The problem.** PW retired `/BatchInfo`. Every batch page silently rendered with
*no subjects* — not an error, just an empty list, which reads as "this batch is
empty" rather than "we asked the wrong address". Expired guest tokens also poisoned
the in-process path, so a bad token kept being reused.

**What changed.**

- `fetchBatch` falls through from the retired legacy route to
  `/v3/batches/<id>/details`, which is the one detail route PW still serves.
- `pwFetch` walks the signer ladder in two passes and re-mints the guest token
  when a request is rejected, instead of carrying the dead credential forward.

**Verified live.** Arjuna JEE 2027 now returns its full subject list — Physics with
Rajwant Singh (148 lectures), Physical Chemistry with Rahul Dudi (106), Inorganic
with Kunwar Om Pandey (49), Maths with Sachin Jakhar (136), and so on.

**Tests.** 1 new: a batch still lists its subjects when the legacy detail route is
gone.

---

## Round W — installable, readable offline, and findable

**What changed.**

- **Installable.** A real web manifest, three icons (including a maskable one) and
  a service worker, so the site installs to a home screen and opens without a
  network.
- **Readable offline.** Notes and DPPs can be kept with a "Keep" button, and the
  downloads page shows what is saved. Offline is a first-class page
  (`offline.html`), not a browser error.
- **A never-stale worker.** Shell changes arrive with an update prompt rather than
  a stale cache, and the worker matches an exact URL before an identical query —
  see the bug note below.
- **Findable.** Canonical URLs, Open Graph and Twitter cards, and JSON-LD for the
  site, batch pages and lectures. The batch count is honest: 14,000+.
- **Accessible.** Skip links, landmarks, `sr-only` text, visible focus rings, an
  ARIA-correct nav disclosure, and a command palette that traps focus, returns it,
  and announces result counts.
- **Hardened.** Security headers on every response, the dev server parses and
  mirrors the same rules so local and production agree, `modulepreload` is
  build-enforced into `<head>`, and `scripts/build.mjs` fails the build if the
  manifest, icons, offline page, per-page meta or any relative import breaks.

**Two real bugs found while building it, both caught by tests rather than by luck.**

1. `offline.html` was not pre-cached, so the one page meant for an offline visitor
   was the one page missing offline.
2. The worker used `ignoreSearch: true`, which served the wrong entity for a
   different query — a chapter's notes could come back as its videos. Matching is
   now exact-first.

A jsdom test flake was also tracked to an unstubbed `/api/sign` probe and fixed at
the stub, not by weakening the assertion.

**Tests.** 15 new — 7 in `tests/shell.test.mjs` (the file was created here) and 8
in `tests/pages.test.mjs`.

---

## Where the site stands

This is the honest state, not the aspirational one, verified against production on
2026-11-08.

| Layer | Status |
| --- | --- |
| Catalogue (14,201 batches) | **Works** — searchable, filterable by language and price across the whole catalogue |
| Batch pages and subject lists | **Works** |
| Chapter lists | **Works** |
| Free / paid split | **Works** — 5,854 free, 8,347 paid, filterable |
| Lecture lists per chapter | **Works** — 13 lectures in one chapter verified |
| Notes and DPPs | **Works** — PDFs open and download |
| Lecture playback | **Does not work** — see below |
| Lecture downloads | **Does not work** — same cause |

**Why playback and downloads do not work.** PW's signing service answers 401/403
for the guest session this site holds, so a signed playlist cannot be minted. The
site now says exactly that, names the lecture's real stream address for diagnosis,
and keeps notes and DPPs working. Fixing it needs an operator-supplied `PW_TOKEN`
that can sign content — it is not a code defect, and no amount of retrying or
relaying changes the answer.

Nothing that gates downloads behind a generated key was reintroduced; that
approach was removed and has stayed removed.

**Gates at this commit.** `npm test` → 192 passing. `node scripts/build.mjs` → 15
pages, 10 API functions, 39 assets, 14,201 batches indexed.
