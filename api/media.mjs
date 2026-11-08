import { cors } from "../lib/http.mjs";

/**
 * GET /api/media?id=<fileId>[&base=...]        → relay a PW PDF / image
 * GET /api/media?url=<absolute url>            → relay any allowed asset
 *
 * Upstream assets live on static.pw.live and CloudFront, which send no CORS
 * headers, so PDFs and thumbnails are streamed through our own origin.
 * HTTP Range is forwarded so big PDFs stream progressively.
 */

const ALLOWED = [
  "pw.live",
  "cloudfront.net",
  "learnxpw.site",
  "penpencil",
  "static.pw.live",
  "d2bps9p1kiy4ka.cloudfront.net",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function allowed(url) {
  try {
    const host = new URL(url).hostname;
    return ALLOWED.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let target = url.searchParams.get("url") || "";

  if (!target) {
    const id = url.searchParams.get("id");
    const base = url.searchParams.get("base") || "https://static.pw.live/";
    if (id) target = `${base.replace(/\/+$/, "")}/${String(id).replace(/^\/+/, "")}`;
  }

  if (!target || !allowed(target)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ success: false, error: "A valid asset url or id is required" }));
  }

  try {
    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(target, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.statusCode = upstream.status === 404 ? 404 : 502;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({ success: false, error: `Upstream returned ${upstream.status}` })
      );
    }

    const type = upstream.headers.get("content-type") || "application/octet-stream";
    cors(res);
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");

    for (const h of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");

    if (req.method === "HEAD" || !upstream.body) return res.end();

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
      res.end(JSON.stringify({ success: false, error: err?.message || "Asset relay failed" }));
    } else {
      res.end();
    }
  }
}
