# Changelog

What changed, in the order it shipped. Each round was built, tested and deployed to
<https://arsvibe-pw-sepia.vercel.app> before the next one started.

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
