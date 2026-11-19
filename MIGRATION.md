# Migrating ArsVibe PW to Cloudflare Pages (free, no domain needed)

The site runs on Cloudflare's free tier under a free `*.pages.dev`
subdomain. No custom domain, no card. The Vercel project stays untouched
as a fallback; both read the same repository.

## What was prepared in this repo

- `functions/api/[[route]].js` — one Pages Function that runs all twelve
  Vercel handlers in `api/*.mjs` **unchanged**, behind a small
  `(req, res)` → fetch adapter. It re-creates the `vercel.json` route
  table (`/api/sign`, `/api/hls`, `/api/download`, `/api/repair`,
  `/api/scan`, `/api/client-error`, `/api/pw/<path>`).
- `wrangler.toml` — project name `arsvibe`, output `public`,
  `nodejs_compat` (the shared library uses `Buffer` / `process.env`).
- `tests/cloudflare-adapter.test.mjs` — routing/body/alias regression
  tests, part of `npm test`.

## Your steps (≈5 minutes)

1. Create a free account at <https://cloudflare.com> (no card).
2. **Workers & Pages → Create application → Pages → Connect to Git**,
   choose the `ARS` repository, branch `arena/04face6a-ars`.
3. Build settings:
   - **Build command:** `node scripts/build.mjs`
   - **Build output directory:** `public`
   - (Framework preset: *None*.)
4. **Save and Deploy.** The first build takes ~2 minutes.
5. Your site is live at **`https://arsvibe.pages.dev`** (Cloudflare may
   suggest a different free name if taken — any name works).

Environment variables are optional and set under
**Settings → Environment variables** when needed: `PW_TOKEN`,
`ARS_SIGNER_URL`, `KV_REST_API_URL` / `KV_REST_API_TOKEN` — same names
as on Vercel; the adapter copies them to `process.env` for the library.

## Differences to know

- The daily scanner **cron** (`/api/admin?action=scan&cron=1`) is a
  Vercel feature; on Pages it simply does not run on a schedule (the
  admin panel can still trigger a scan manually).
- Free-tier function budget is 100k requests/day; playlists and
  segments carry immutable edge cache headers, so repeat views are
  served from Cloudflare's cache rather than the function.
- Static bandwidth on Pages is unlimited on the free plan — the quota
  that blocked Vercel does not exist here.
