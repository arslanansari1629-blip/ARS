# ArsVibe signer worker (our own `get-hls-key`)

Playback used to depend on third-party signer relays (vidcloud,
streamvideo, studyspark). When vidcloud's owner hit their Cloudflare
plan limit (Error 1027), every lecture stopped playing. This Worker is
the same protocol on our own Cloudflare account: it mints the public PW
guest token, presents it to PW's official API, and streams the answer.

## Deploy from the Cloudflare dashboard (≈2 minutes, no CLI)

1. Open <https://dash.cloudflare.com> → **Workers & Pages** → **Create**
   → **Create Worker**.
2. Name it `ars-signer` and click **Deploy** (the hello-world is fine).
3. Click **Edit code**, delete the placeholder, and paste the entire
   contents of [`signer-worker.js`](./signer-worker.js). **Save and deploy**.
4. (Optional but recommended) **Settings → Variables and Secrets → Add**:
   - Type **Secret**, name `PW_TOKEN`, value = a PW bearer token. With
     this set the Worker never depends on the public token mints.
5. Copy the worker URL (looks like
   `https://ars-signer.<your-subdomain>.workers.dev`) and give it to the
   site maintainer — it becomes the `ARS_SIGNER_URL` env var on Vercel,
   which makes every client try our signer first.

Check it works: open `<worker-url>/health` — it reports where the guest
token came from. Then
`<worker-url>/api/v1/videos/get-hls-key?videoKey=<folder>&key=360/main.m3u8`
should return an HLS playlist.

## Deploy with wrangler (alternative)

```sh
npx wrangler deploy            # from this folder
npx wrangler secret put PW_TOKEN   # optional
```

## How the site uses it

`lib/sign.mjs` and the probe in `lib/api-data.mjs` read `ARS_SIGNER_URL`;
when set, `<ARS_SIGNER_URL>/api/v1/videos/get-hls-key` leads both signer
ladders and the partner relays become the fallback instead of the only
path. Segments that PW playlists already carry as signed absolute URLs
never reach any signer — the site proxies those from PW's CDN directly —
so one lecture view costs this Worker a few requests, nowhere near the
free plan's daily allowance.
