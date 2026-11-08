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

async function loadHandler(name) {
  const file = path.join(API, `${name}.mjs`);
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

  // --- API routes -------------------------------------------------------
  if (pathname.startsWith("/api/")) {
    const name = pathname.slice(5).replace(/\/+$/, "");
    const file = path.join(API, `${name}.mjs`);
    try {
      await stat(file);
    } catch {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ success: false, error: `Unknown API route: ${name}` }));
    }
    try {
      const handler = await loadHandler(name);
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
  console.log(`EduVibe PW running → http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
