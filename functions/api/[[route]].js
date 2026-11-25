/**
 * Cloudflare Pages adapter for the ArsVibe PW API.
 *
 * The twelve handlers in `/api/*.mjs` were written for Vercel's Node
 * `(req, res)` runtime. Pages Functions speak fetch (`Request` in,
 * `Response` out), so this single catch-all translates between the two
 * and re-creates the route table `vercel.json` + `scripts/dev.mjs`
 * define: the media aliases (`/api/sign`, `/api/hls`, `/api/download`,
 * `/api/repair`, `/api/scan`, `/api/client-error`) are mounted on the
 * admin/stream functions with an `action` parameter, and `/api/pw/<rest>`
 * forwards its tail as `?path=`. No handler was modified.
 *
 * Requires `nodejs_compat` (see wrangler.toml): the shared library uses
 * `Buffer` and `process.env`, both provided by that flag.
 */

import { EventEmitter } from "node:events";

import admin from "../../api/admin.mjs";
import batch from "../../api/batch.mjs";
import batches from "../../api/batches.mjs";
import check from "../../api/check.mjs";
import contents from "../../api/contents.mjs";
import lecture from "../../api/lecture.mjs";
import media from "../../api/media.mjs";
import pdf from "../../api/pdf.mjs";
import pw from "../../api/pw.mjs";
import sign from "../../api/sign.mjs";
import stream from "../../api/stream.mjs";
import token from "../../api/token.mjs";

const HANDLERS = { admin, batch, batches, check, contents, lecture, media, pdf, pw, sign, stream, token };

/** Mounted aliases: public URL → [handler, action] (mirrors vercel.json). */
const ALIASES = {
  sign: ["admin", "sign"],
  hls: ["stream", "hls"],
  download: ["stream", "download"],
  repair: ["admin", "repair"],
  scan: ["admin", "scan"],
  "client-error": ["admin", "client-error"],
  // The Allen platform's API rides on the batches function.
  allen: ["batches", "allen"],
};

function resolveRoute(url) {
  const name = url.pathname.slice("/api/".length).replace(/\/+$/, "");
  const [head, ...rest] = name.split("/");

  // `/api/pw/<rest>` — the tail becomes the upstream path.
  if (head === "pw" && rest.length) {
    return { handler: pw, search: withParam(url, "path", rest.join("/")) };
  }
  // Mounted aliases, bare or with a path tail (`/api/sign/<rest>`).
  if (ALIASES[head]) {
    const [target, action] = ALIASES[head];
    let search = withParam(url, "action", action);
    if (rest.length) search = withParam(new URL(`http://x${search}`), "path", rest.join("/"));
    return { handler: HANDLERS[target], search };
  }
  if (HANDLERS[name]) return { handler: HANDLERS[name], search: url.search };
  return null;
}

function withParam(url, key, value) {
  const u = new URL(url.href || `http://x${url.pathname}${url.search || ""}`);
  u.searchParams.set(key, value);
  return u.search;
}

/** A Vercel-shaped `req`: method/url/headers/body plus the `data`/`end` event stream body readers expect. */
function shimRequest(request, search, rawBody) {
  const url = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;

  let body;
  const type = headers["content-type"] || "";
  if (rawBody.length && type.includes("application/json")) {
    try { body = JSON.parse(new TextDecoder().decode(rawBody)); } catch { body = undefined; }
  }

  const req = new EventEmitter();
  req.method = request.method;
  req.url = url.pathname + search;
  req.headers = headers;
  req.body = body;
  req.socket = { remoteAddress: headers["cf-connecting-ip"] || headers["x-forwarded-for"] || "" };
  req.destroy = () => {};
  // Body readers attach `data` then `end` synchronously, then wait: replay
  // the buffered body once the first `data` listener lands.
  const baseOn = req.on.bind(req);
  let replayed = false;
  req.on = (event, fn) => {
    const out = baseOn(event, fn);
    if (event === "data" && !replayed) {
      replayed = true;
      queueMicrotask(() => {
        if (rawBody.length) req.emit("data", Buffer.from(rawBody));
        req.emit("end");
      });
    }
    return out;
  };
  return req;
}

/** A Vercel-shaped `res` that collects into a fetch `Response`. */
function shimResponse(onFinished) {
  const res = new EventEmitter();
  const headers = new Map();
  const chunks = [];
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (k, v) => { headers.set(String(k).toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)); return res; };
  res.getHeader = (k) => headers.get(String(k).toLowerCase());
  res.removeHeader = (k) => headers.delete(String(k).toLowerCase());
  res.hasHeader = (k) => headers.has(String(k).toLowerCase());
  res.writeHead = (code, hdrs) => {
    res.statusCode = code;
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
    res.headersSent = true;
    return res;
  };
  res.flushHeaders = () => { res.headersSent = true; };
  res.write = (chunk) => {
    if (chunk) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    res.headersSent = true;
    return true;
  };
  res.end = (chunk) => {
    if (chunk && typeof chunk !== "function") res.write(chunk);
    res.headersSent = true;
    onFinished({ status: res.statusCode, headers, chunks });
    return res;
  };
  return res;
}

export async function dispatch(request, env) {
  // Workers expose bindings as `env`; the library reads `process.env`.
  if (env) {
    try {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string" && process.env[k] === undefined) process.env[k] = v;
      }
      // A KV namespace is an object, not a string: hand it to the store
      // directly so documents (bots, comments, the repair ledger) are
      // durable across cold starts with nothing left to attach.
      if (env.ARS_KV) {
        const { setKvBinding } = await import("../../lib/store.mjs");
        setKvBinding(env.ARS_KV);
      }
    } catch { /* process may be read-only in some runtimes */ }
  }

  const url = new URL(request.url);
  const route = url.pathname.startsWith("/api/") ? resolveRoute(url) : null;
  if (!route) {
    return new Response(JSON.stringify({ success: false, error: `Unknown API route: ${url.pathname}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const rawBody = request.method === "GET" || request.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer());
  const req = shimRequest(request, route.search, rawBody);

  const finished = new Promise((resolve) => {
    const res = shimResponse(resolve);
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
        }
        try { res.end(JSON.stringify({ success: false, error: String((err && err.message) || err) })); } catch { resolve({ status: 500, headers: new Map(), chunks: [] }); }
      });
  });

  const { status, headers, chunks } = await finished;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.length; }
  const noBody = status === 204 || status === 304 || request.method === "HEAD";
  return new Response(noBody ? null : body, { status, headers: Object.fromEntries(headers) });
}

export async function onRequest(context) {
  return dispatch(context.request, context.env);
}
