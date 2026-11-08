/**
 * `GET /api/pw/<anything>` — the catch-all mount for the PW API proxy.
 *
 * Vercel only treats a file as a wildcard route when the bracket syntax is in
 * the filename, so the implementation lives in `lib/pw-proxy.mjs` and both this
 * file and the local dev server reach it with the same helper shape.
 */
export { default } from "../../lib/pw-proxy.mjs";
