# Changelog

What changed, in the order it shipped. Each round was built, tested and deployed to
<https://arsvibe-pw-sepia.vercel.app> before the next one started.

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
| Catalogue (14,201 batches) | **Works** |
| Batch pages and subject lists | **Works** |
| Chapter lists | **Works** |
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

**Gates at this commit.** `npm test` → 182 passing. `node scripts/build.mjs` → 15
pages, 10 API functions, 39 assets, 14,201 batches indexed.
