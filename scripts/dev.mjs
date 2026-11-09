/**
 * Local dev server + same-origin API shim.
 *
 * Mirrors the Vercel layout (public/ static, api/*.mjs functions receiving
 * (req, res)) so the site behaves exactly like the deployment.
 *
 *   npm run dev   →  http://0.0.0.0:3000
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const API = path.join(ROOT, "api");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

const modules = new Map();

async function loadHandler(name, explicitFile = "") {
  const file = explicitFile || path.join(API, `${name}.mjs`);
  if (modules.has(file)) return modules.get(file).default;
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  modules.set(file, mod);
  return mod.default;
}

function sendStatic(res, filePath) {
  return readFile(filePath).then((buf) => {
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", TYPES[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  // --- rewrites ---------------------------------------------------------
  // Mirrors vercel.json: the media routes are their own URLs on the outside and
  // share one function on the inside (the Hobby plan's 12-function cap).
  if (pathname === "/api/hls" || pathname === "/api/sign") {
    // `/api/sign` is mounted on the admin function; `/api/hls` rides on stream,
    // which is how both keep their own URL inside a 12-function budget.
    const action = pathname.slice(5);
    const target = action === "hls" ? "/api/stream" : "/api/admin";
    url.searchParams.set("action", action);
    pathname = target;
    req.url = `${target}?${url.searchParams.toString()}`;
  }

  // --- API routes -------------------------------------------------------
  if (pathname.startsWith("/api/")) {
    const name = pathname.slice(5).replace(/\/+$/, "");

    // Exact route first, then a Vercel-style catch-all (`api/x/[...path].mjs`)
    // so same shaped routes behave identically here and in production.
    let file = path.join(API, `${name}.mjs`);
    let wildcard = null;
    try {
      await stat(file);
    } catch {
      const segments = name.split("/");
      let found = null;
      for (let cut = segments.length; cut >= 1 && !found; cut--) {
        const dir = segments.slice(0, cut).join("/");
        const rest = segments.slice(cut).join("/");
        const candidate = path.join(API, dir, "[...path].mjs");
        try {
          await stat(candidate);
          found = { candidate, rest, dir };
        } catch {
          /* keep shrinking */
        }
      }
      if (!found) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ success: false, error: `Unknown API route: ${name}` }));
      }
      file = found.candidate;
      wildcard = { dir: found.dir, rest: found.rest };
    }

    if (wildcard) {
      // Mirror Vercel: the handler reads `req.query.path` from the wildcard.
      const url2 = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (!url2.searchParams.get("path")) {
        url2.searchParams.set("path", wildcard.rest);
        req.url = `${url2.pathname}?${url2.searchParams.toString()}`;
      }
    }
    try {
      const handler = await loadHandler(name, file);
      return await handler(req, res);
    } catch (err) {
      console.error(`[api:${name}]`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return res.end();
    }
  }

  // --- static files -----------------------------------------------------
  if (pathname === "/") pathname = "/index.html";
  let filePath = path.join(PUBLIC, pathname);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
    return await sendStatic(res, filePath);
  } catch {
    // pretty URLs: /batch → /batch.html
    try {
      return await sendStatic(res, `${filePath}.html`);
    } catch {
      try {
        return await sendStatic(res, path.join(PUBLIC, "404.html"));
      } catch {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        return res.end("Not found");
      }
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ArsVibe PW running → http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
