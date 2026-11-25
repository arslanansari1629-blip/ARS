# ars-signer

ArsVibe's own Physics Wallah signing lane, deployed on Vercel as the
project **ars-signer** (files deployment, no build step).

- `GET /api/health` → `{ ok: true, service: "ars-signer" }`
- `GET /api/v1/videos/get-hls-key?videoKey=<folder>&key=<asset>` →
  signed playlist/segment bytes (same contract as every partner relay
  the site already speaks to).

It exists because the site's Cloudflare Worker egress is bot-blocked
(403) by the third-party signing relays while Vercel egress is not.
The site's signer ladders (`lib/sign.mjs`, `lib/api-data.mjs`) carry
this deployment's URL as the built-in first lane (`OWN_SIGNER_URL`);
`ARS_SIGNER_URL` on the Worker still overrides it.

Redeploy: push these files to the `ars-signer` Vercel project
(or `vercel --prod` from this folder).
