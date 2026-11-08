import { cors } from "../lib/http.mjs";

/**
 * GET /api/hls?folder=&asset=&sig=&host=
 *
 * CORS-safe media gateway for PW CloudFront streams.
 * PW publishes signed DASH/HLS URLs; CloudFront does not send CORS headers on
 * segments, so a browser player cannot read them directly. Every manifest,
 * segment and key is streamed through this route instead, and playlists are
 * rewritten so all child requests come back here.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_HOST = "d1d34p8vz63oiq.cloudfront.net";

function selfBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
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
  out = out.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${absoluteSelf}/api/hls?folder=${encodeURIComponent(ctx.folder)}&host=${encodeURIComponent(ctx.host)}${cleanSig ? `&sig=${encodeURIComponent(cleanSig)}` : ""}&asset=</BaseURL>`);
  out = out.replace(
    /(initialization|media|sourceURL)="([^"]+)"/g,
    (_m, attr, value) => `${attr}="${value}"`
  );
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const folder = url.searchParams.get("folder") || "";
  const asset = url.searchParams.get("asset") || "master.mpd";
  const host = url.searchParams.get("host") || DEFAULT_HOST;
  let sig = url.searchParams.get("sig") || "";

  if (!folder) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "folder is required" }));
  }

  if (sig && !sig.startsWith("?")) sig = `?${sig}`;

  const target = `https://${host}/${folder}/${asset.replace(/^\/+/, "")}${sig}`;
  const headers = { "User-Agent": UA, Accept: "*/*" };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(25000) });

    if (!upstream.ok && upstream.status !== 206) {
      res.statusCode = upstream.status === 404 ? 404 : 502;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          success: false,
          error: `Stream upstream returned ${upstream.status}`,
          hint: "The signed stream link may have expired — reload the lecture.",
        })
      );
    }

    const type = upstream.headers.get("content-type") || "";
    const isPlaylist =
      /mpegurl/i.test(type) || asset.endsWith(".m3u8") || asset.endsWith(".mpd");

    if (isPlaylist) {
      const text = await upstream.text();
      const base = selfBase(req);
      const ctx = { folder, host, sig: sig.replace(/^\?/, "") };
      const body = asset.endsWith(".m3u8")
        ? rewritePlaylist(text, ctx, base)
        : rewriteMpd(text, ctx, base);

      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        asset.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "application/dash+xml"
      );
      res.setHeader("Cache-Control", "no-store");
      return res.end(body);
    }

    res.statusCode = upstream.status;
    res.setHeader("Content-Type", type || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: false, error: err?.message || "Stream relay failed" }));
    } else {
      res.end();
    }
  }
}
