# Migrating ArsVibe PW to Cloudflare Pages (free, no domain needed)

The site runs on Cloudflare's free tier under a free `*.pages.dev`
subdomain. No custom domain, no card. The Vercel project stays untouched
as a fallback; both read the same repository.

## What was prepared in this repo

- `cloudflare/worker.js` — the Worker entry: `/api/*` is dispatched to
  the handlers, everything else is served from `public/` by Workers
  Static Assets, and a daily cron re-runs the scanner.
- `functions/api/[[route]].js` — the fetch adapter that runs all twelve
  Vercel handlers in `api/*.mjs` **unchanged**. It re-creates the
  `vercel.json` route table (`/api/sign`, `/api/hls`, `/api/download`,
  `/api/repair`, `/api/scan`, `/api/client-error`, `/api/pw/<path>`).
- `wrangler.toml` — Worker name `arsvibe`, static assets bound from
  `public/`, `nodejs_compat` (the shared library uses `Buffer` /
  `process.env`), daily scanner cron.
- `tests/cloudflare-*.test.mjs` — adapter + worker regression tests,
  part of `npm test`.

## Your steps (≈5 minutes)

1. Create a free account at <https://cloudflare.com> (no card).
2. **Workers & Pages → Create application → Connect to Git** (a Worker),
   choose the `ARS` repository, branch `arena/04face6a-ars`, worker
   name `arsvibe`.
3. Build settings (**Settings → Build** if the project already exists):
   - **Build command:** `node scripts/build.mjs`
   - **Deploy command:** `npx wrangler deploy` (the default)
4. **Save and Deploy.** Every later push to the branch rebuilds and
   redeploys automatically.
5. Your site is live at **`https://arsvibe.<your-subdomain>.workers.dev`**
   (the exact address is shown on the worker's overview page).

Environment variables are optional and set under
**Settings → Environment variables** when needed: `PW_TOKEN`,
`ARS_SIGNER_URL`, `KV_REST_API_URL` / `KV_REST_API_TOKEN` — same names
as on Vercel; the adapter copies them to `process.env` for the library.

## Differences to know

- The daily scanner cron runs as a Worker cron trigger
  (`cloudflare/worker.js`), same 03:00 UTC cadence as Vercel Cron.
- Free-tier Worker budget is 100k requests/day; playlists and segments
  carry immutable edge cache headers, so repeat views are served from
  Cloudflare's cache rather than the Worker.
- Static asset bandwidth is unlimited on the free plan — the quota
  that blocked Vercel does not exist here.
