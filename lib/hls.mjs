/**
 * `GET /api/hls?folder=&asset=&sig=&host=` — the CORS-safe media gateway.
 *
 * PW publishes signed DASH/HLS URLs on CloudFront, and CloudFront sends no CORS
 * headers on segments: a browser player cannot read them directly. Every
 * manifest, segment and key is streamed through this module instead, and
 * playlists are rewritten so all child requests come back here.
 *
 * Mounted, not routed
 * -------------------
 * This was `api/hls.mjs`. The Hobby plan allows twelve serverless functions per
 * deployment and this project needs thirteen routes, so it now lives here and
 * `api/admin.mjs` dispatches it (`/api/hls` is rewritten in `vercel.json`). The
 * player-visible URL is unchanged.
 */

import { cors } from "../lib/http.mjs";
import { resolveStream, parseFolder } from "./api-data.mjs";
import { fetchSigned } from "./sign.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_HOST = "d1d34p8vz63oiq.cloudfront.net";

function selfBase(req) {
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  if (!host) return "";
  const local = /^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|$)/.test(host);
  const proto = local
    ? "http"
    : (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

function wrap(ctx, asset) {
  const q = new URLSearchParams({
    folder: ctx.folder,
    asset,
    host: ctx.host,
  });
  if (ctx.sig) q.set("sig", ctx.sig);
  return `/api/hls?${q.toString()}`;
}

function rewritePlaylist(text, ctx, absoluteSelf) {
  return text
    .split("\n")
    .map((line) => {
      const raw = line.trim();
      if (!raw || raw.startsWith("#")) {
        // rewrite URI="..." attributes inside tags (EXT-X-KEY, EXT-X-MAP, ...)
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          let rel = uri;
          try {
            const u = new URL(uri, `https://${ctx.host}/${ctx.folder}/`);
            rel = u.pathname.split(`/${ctx.folder}/`)[1] || uri;
          } catch {
            /* keep as is */
          }
          return `URI="${absoluteSelf}${wrap(ctx, rel)}"`;
        });
      }
      let rel = raw;
      try {
        const u = new URL(raw, `https://${ctx.host}/${ctx.folder}/`);
        rel = u.pathname.split(`/${ctx.folder}/`)[1] || raw;
      } catch {
        /* relative already */
      }
      return `${absoluteSelf}${wrap(ctx, rel.replace(/^\//, ""))}`;
    })
    .join("\n");
}

/**
 * Rewrite a DASH manifest so every child request comes back through us.
 *
 * A declared `<BaseURL>` is replaced with our gateway, but a manifest that
 * declares none — which is the norm for the PW CDN — is resolved relative to
 * the *manifest's* location, so the player would ask the CDN directly and hit
 * the same missing CORS headers HLS avoids. `$RepresentationID$` and
 * `$Number$` templates have to survive untouched: they are resolved by the
 * player, not by us.
 *
 * The gateway is one folder deep (`/api/hls?asset=<file>`), so an asset name
 * must not contain a slash; nested paths are encoded with `~` and expanded
 * again when the request arrives.
 */
function rewriteMpd(text, ctx, absoluteSelf) {
  const cleanSig = ctx.sig || "";
  const gateway = (asset = "") =>
    `${absoluteSelf}/api/hls?folder=${encodeURIComponent(ctx.folder)}&host=${encodeURIComponent(
      ctx.host
    )}${cleanSig ? `&sig=${encodeURIComponent(cleanSig)}` : ""}&asset=${encodeURIComponent(asset)}`;

  let out = text.replace(/<BaseURL[\s\S]*?<\/BaseURL>/gi, "");
  out = out.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${gateway("")}</BaseURL>`);
  return out;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const folder = url.searchParams.get("folder") || "";
  // The plan tells us which manifest to start from: a signed DASH URL carries
  // `master.mpd`, but the rendition probe path is HLS, and asking the DASH
  // gateway for the wrong one used to be a mystery 403 in the player.
  const asset = url.searchParams.get("asset") || "master.mpd";
  const host = url.searchParams.get("host") || DEFAULT_HOST;
  const sig = url.searchParams.get("sig") || "";

  if (!folder) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "folder is required" }));
  }

  // Only the CDN hosts PW actually uses: this route must not be usable as an
  // open proxy for arbitrary URLs.
  if (!/\.(cloudfront\.net|pw\.live|penpencil\.xyz)$/i.test(host)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "host is not a media host" }));
  }

  const signed = Boolean(sig);
  const target = `https://${host}/${folder}/${asset.replace(/^\/+/, "")}${sig ? `?${sig}` : ""}`;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "*/*", Referer: `https://${host}/` },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(
      JSON.stringify({
        success: false,
        error: err?.message || "media host unreachable",
        asset,
        hint: "The CDN did not answer. Retry — the player asks for a fresh plan on its own.",
      })
    );
  }

  if (upstream.ok) return relay(req, res, upstream, { asset, folder, host, sig });

  /**
   * No signature: the CDN refuses, and this used to be the end of playback.
   *
   * When the schedule hands out a bare CDN URL its signature has already been
   * stripped (or never attached), so CloudFront answers 403 and the player sat
   * on "media host answered 403" with no way forward. The signer relays *can*
   * still mint that exact file — that is what `/api/sign` is for — so the
   * gateway falls back to them and relays the bytes. One URL for the player,
   * whichever route is able to produce the file.
   */
  // A signature can also be *stale* rather than absent: an expired key pair makes
  // CloudFront answer the same 403, and the signer can mint a fresh file from the
  // folder alone. Both cases get the same second chance.
  if (upstream.status === 403 || upstream.status === 401) {
    const key = asset.replace(/^\/+/, "");
    const viaSigner = await resolveStream({
      rawUrl: `https://${host}/${folder}/${key}`,
      folder: parseFolder(`https://${host}/${folder}/${key}`) || folder,
    }).catch(() => null);

    if (viaSigner && viaSigner.playable) {
      // A master manifest has to be *the plan's* master: the signer stores one
      // playlist per rendition and does not serve a master at all, so asking it
      // for `master.mpd` is the same 403 we just got from the CDN.
      if (/master\.(mpd|m3u8)$/i.test(key)) {
        res.statusCode = 302;
        res.setHeader("Location", viaSigner.url);
        res.setHeader("Cache-Control", "no-store");
        return res.end();
      }
      // Anything else (a key, a segment) is a single file the relay can mint.
      // Called in process: a loopback `fetch` of our own origin only works when
      // the function can reach itself, which is not something to rely on.
      const minted = await fetchSigned(folder, key).catch(() => null);
      if (minted && minted.ok) {
        return relay(req, res, minted.response, { asset, folder, host, sig: "" });
      }
    }
  }

  res.statusCode = upstream.status;
  res.setHeader("Content-Type", "application/json");
  return res.end(
    JSON.stringify({
      success: false,
      error: `media host answered ${upstream.status}`,
      asset,
      hint: signed
        ? "The signature on this URL has expired: reload the lecture for a fresh plan."
        : "These bytes need a fresh signature; reload the lecture so the player asks for a new plan.",
    })
  );
}

/**
 * Send an upstream manifest (rewritten) or media bytes to the browser.
 *
 * Playlists are read as text and rewritten so every child request comes back
 * here; segments are piped straight through, because buffering one would double
 * the memory and delay the first frame.
 */
async function relay(req, res, upstream, ctx) {
  const { asset, folder, host, sig } = ctx;

  const type = upstream.headers.get("content-type") || "";
  // The file name is the stronger signal. `text/plain` alone used to be enough,
  // and a segment served without a content-type was then "rewritten" as if it
  // were a playlist — which corrupts the bytes the player needs most.
  const isPlaylist =
    /\.(m3u8|mpd)$/i.test(asset) ||
    /mpegurl|dash\+xml/i.test(type) ||
    (!/\.[a-z0-9]{1,5}$/i.test(asset) && /text\/plain/i.test(type));
  const base = selfBase(req);

  if (isPlaylist) {
    const text = await upstream.text();
    const rewritten = /<MPD/i.test(text)
      ? rewriteMpd(text, { folder, host, sig }, base)
      : rewritePlaylist(text, { folder, host, sig }, base);
    res.statusCode = 200;
    res.setHeader("Content-Type", /<MPD/i.test(text) ? "application/dash+xml" : "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "public, max-age=30");
    return res.end(rewritten);
  }

  // Media bytes pass straight through: buffering a segment would double the
  // memory and delay the first frame by however long the segment takes.
  res.statusCode = 200;
  res.setHeader("Content-Type", type || "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=86400");
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);

  if (!upstream.body) return res.end(Buffer.from(await upstream.arrayBuffer()));

  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  return res.end();
}
