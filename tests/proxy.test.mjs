/**
 * /api/pw and /api/token — the authenticated proxy.
 *
 * These routes exist because the lecture API answers 401 to an unauthenticated
 * call: the credentials have to be attached somewhere, and that somewhere is
 * the server, never the browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/* ----------------------------- harness -------------------------------- */

const realFetch = globalThis.fetch;

/** Run `fn` with fetch replaced; restore afterwards even on a throw. */
async function withFetch(handler, fn) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, headers: init.headers || {}, method: init.method || "GET" });
    return handler(url, init);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal Vercel-style req/res pair. */
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[String(k).toLowerCase()];
    },
    write(chunk) {
      if (Buffer.isBuffer(chunk)) {
        this.chunks = this.chunks || [];
        this.chunks.push(chunk);
        this.body += chunk.toString();
      } else {
        this.body += String(chunk);
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.done = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}

function req(pathname) {
  return { method: "GET", url: pathname, headers: { host: "localhost:3000" } };
}

/* --------------------------- /api/pw ---------------------------------- */

test("/api/pw attaches the guest token server-side", async () => {
  const { default: handler } = await import("../lib/pw-proxy.mjs");

  const { result, calls } = await withFetch(
    (url) => {
      if (url.includes("generate_token")) {
        return new Response("proxy-guest-token-abcdef123456", { status: 200 });
      }
      return jsonResponse({ success: true, data: { name: "Arjuna JEE 2027" } });
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/v3/batches/698ad3519549b300a5e1cc6a/details"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.json().data.name, "Arjuna JEE 2027");

  // The API call must carry the credential; the browser never sees it.
  const api = calls.find((c) => c.url.includes("/v3/batches/"));
  assert.ok(api, "expected the API to be called");
  const auth = api.headers.authorization || api.headers.Authorization || "";
  assert.match(auth, /Bearer proxy-guest-token-abcdef123456/);
  assert.equal(api.headers["client-id"], "5eb393ee95fab7468a79d189");
  assert.equal(api.headers["client-type"], "WEB");
  assert.ok(api.headers.randomid);
  // The token source is recorded for debugging, but the token itself is not.
  assert.match(String(result.getHeader("x-pw-auth")), /generate_token/);
});

test("/api/pw rejects a path traversal and a foreign host", async () => {
  const { default: handler } = await import("../lib/pw-proxy.mjs");

  const evil = mockRes();
  await handler(req("/api/pw/../../etc/passwd"), evil);
  assert.equal(evil.statusCode, 400);

  const foreign = mockRes();
  await handler(req("/api/pw/v3/batches/x/details?upstream=https://evil.example.com"), foreign);
  assert.equal(foreign.statusCode, 400);
  assert.match(foreign.json().error, /allowlisted/i);
  assert.ok(foreign.json().allowed.includes("api.penpencil.co"));
});

test("/api/pw walks the other hosts when one is unreachable", async () => {
  const { default: handler } = await import("../lib/pw-proxy.mjs");
  const hosts = [];

  const { result } = await withFetch(
    (url) => {
      if (url.includes("generate_token")) return new Response("token-value-1234567890", { status: 200 });
      const host = new URL(url).hostname;
      hosts.push(host);
      // First allowlisted host is "blocked"; the next one answers.
      if (host === "api.penpencil.co") throw new Error("connect ECONNREFUSED");
      return jsonResponse({ success: true, data: { ok: true } });
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/v3/batches/x/details"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 200);
  assert.ok(hosts.length >= 2, `expected a failover, got ${hosts.join(",")}`);
  assert.equal(hosts[0], "api.penpencil.co");
  assert.match(result.getHeader("x-pw-tried"), /api\.penpencil\.co:0/);
});

test("/api/pw streams binary payloads untouched", async () => {
  const { default: handler } = await import("../lib/pw-proxy.mjs");
  const key = Buffer.from("0123456789abcdef");

  const { result } = await withFetch(
    (url) => {
      if (url.includes("generate_token")) return new Response("token-value-1234567890", { status: 200 });
      return new Response(key, { status: 200, headers: { "content-type": "application/octet-stream" } });
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/v1/videos/get-hls-key?videoKey=abc&key=enc.key"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 200);
  // Buffers are written as-is: a .ts segment must never be re-encoded as text.
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].length, 16);
});

test("/api/pw explains a locked endpoint instead of leaking a 401", async () => {
  const { default: handler } = await import("../lib/pw-proxy.mjs");

  const { result } = await withFetch(
    (url) => {
      if (url.includes("generate_token")) return new Response("short", { status: 200 });
      return jsonResponse({ success: false, message: "Unauthorised Access" }, 401);
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/v1/videos/get-otp?key=deadbeef"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 502);
  const body = result.json();
  assert.equal(body.success, false);
  assert.equal(body.upstreamStatus, 401);
  assert.match(body.hint, /PW_TOKEN/);
});

/* --------------------------- /api/token ------------------------------- */

test("/api/token reports the token, its source and the signer probes", async () => {
  const { default: handler } = await import("../api/token.mjs");

  const { result } = await withFetch(
    (url) => {
      if (url.includes("generate_token")) return new Response("probe-token-abcdefghijkl", { status: 200 });
      if (url.includes("get-hls-key")) {
        return new Response(Buffer.alloc(16, 7), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return jsonResponse({ success: true, data: { _id: "x" } });
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/token?fresh=1"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 200);
  const body = result.json();
  assert.equal(body.success, true);
  assert.equal(body.lectureSigning, "working");
  // Never echo the credential itself.
  assert.ok(!body.token.value.includes("probe-token-abcdefghijkl"));
  assert.match(body.token.value, /^probe-…/);
  assert.ok(body.probes.length >= 3);
  assert.ok(body.probes.every((p) => typeof p.ms === "number"));
});
