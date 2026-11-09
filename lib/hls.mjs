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

function rewriteMpd(text, ctx, absoluteSelf) {
  const cleanSig = ctx.sig || "";
  let out = text.replace(/<BaseURL[\s\S]*?<\/BaseURL>/gi, "");
  out = out.replace(
    /(<MPD[^>]*>)/i,
    `$1\n  <BaseURL>${absoluteSelf}/api/hls?folder=${encodeURIComponent(ctx.folder)}&host=${encodeURIComponent(ctx.host)}${cleanSig ? `&sig=${encodeURIComponent(cleanSig)}` : ""}&asset=</BaseURL>`
  );
  out = out.replace(
    /(initialization|media|sourceURL)="([^"]+)"/g,
    (_m, attr, value) => `${attr}="${value}"`
  );
  return out;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const folder = url.searchParams.get("folder") || "";
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
    return res.end(JSON.stringify({ success: false, error: err?.message || "media host unreachable" }));
  }

  if (!upstream.ok) {
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({ success: false, error: `media host answered ${upstream.status}`, asset })
    );
  }

  const type = upstream.headers.get("content-type") || "";
  const isPlaylist = /mpegurl|dash\+xml|text\/plain/i.test(type) || /\.(m3u8|mpd)$/i.test(asset);
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
