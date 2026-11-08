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

test("/api/pw keeps walking hosts through a 4xx and signs on the right one", async () => {
  // Real behaviour: get-hls-key answers 401 on api.penpencil.co and 200 with a
  // 16-byte AES key on vidcloud.eu.org/api, for the same token. A 401 is "wrong
  // host", not "give up", or every lecture key would look locked.
  const { default: handler } = await import("../lib/pw-proxy.mjs");
  const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");

  const { result, calls } = await withFetch(
    async (url) => {
      if (url.includes("vidcloud.eu.org")) {
        return new Response(KEY, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return jsonResponse({ success: false, message: "Unauthorised Access" }, 401);
    },
    async () => {
      const res = mockRes();
      await handler(
        req("/api/pw/v1/videos/get-hls-key?videoKey=abc&key=enc.key"),
        res
      );
      return res;
    }
  );

  assert.equal(result.statusCode, 200, "the host that can sign must be used");
  assert.deepEqual(Buffer.concat(result.chunks || []), KEY, "exact key bytes");
  assert.match(
    result.headers["x-pw-upstream"],
    /vidcloud\.eu\.org/,
    "reports the host that answered, not the one it started with"
  );
  assert.ok(
    calls.length >= 2,
    "should have tried more than one host before succeeding"
  );
});

test("/api/pw also walks hosts through a 404", async () => {
  // Not hypothetical: the legacy /Schedule route 404s on api.penpencil.co and is
  // served by the mirrors, so treating 404 as definitive made every lecture
  // resolve to "no video" while the endpoint plainly existed one host over.
  const { default: handler } = await import("../lib/pw-proxy.mjs");
  const { result, calls } = await withFetch(
    async (url) => {
      if (url.includes("learnxpw.site")) {
        return jsonResponse({ success: true, data: { _id: "content-1" } });
      }
      return jsonResponse({ success: false, message: "Not Found" }, 404);
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/Schedule?BatchId=b&SubjectId=s&ContentId=c"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.json().data._id, "content-1");
  assert.ok(calls.length > 1, "should have kept looking after the 404");
  assert.match(result.headers["x-pw-upstream"], /learnxpw\.site/);
});

test("/api/pw still answers a path no host serves", async () => {
  const { default: handler } = await import("../lib/pw-proxy.mjs");
  const { result, calls } = await withFetch(
    async () => jsonResponse({ success: false, message: "Not Found" }, 404),
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/v1/videos/get-dash-key?key=abc"), res);
      return res;
    }
  );

  assert.ok(calls.length > 1, "every host is tried before giving up");
  assert.notEqual(result.statusCode, 200);
  assert.equal(result.json().upstreamStatus, 404, "reports the honest upstream answer");
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
  // The state block must not be a hole in that redaction — it used to carry the
  // whole bearer.
  assert.ok(
    !JSON.stringify(body.token.state).includes("probe-token-abcdefghijkl"),
    "token.state must not echo the credential"
  );
  assert.match(body.token.state.prefix, /^probe-…/);
  assert.ok(body.probes.length >= 3);
  assert.ok(body.probes.every((p) => typeof p.ms === "number"));
  // Signing and entitlement are reported separately, with a verdict.
  assert.equal(typeof body.entitlement.lectures, "number");
  assert.ok(["working", "metadata-only", "unavailable"].includes(body.lecturePlayback));
});

test("/api/pw passes the bearer as a query param to the signing endpoints", async () => {
  // get-hls-key and get-otp reject the same token as a header (401) and accept it
  // in the query string. Sending both is how the working clients do it.
  const { default: handler } = await import("../lib/pw-proxy.mjs");
  const seen = [];
  const { result } = await withFetch(
    async (url) => {
      seen.push(url);
      return new Response(Buffer.alloc(16, 7), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    },
    async () => {
      const res = mockRes();
      await handler(req("/api/pw/v1/videos/get-hls-key?videoKey=abc&key=enc.key"), res);
      return res;
    }
  );

  assert.equal(result.statusCode, 200);
  assert.match(seen[0], /[?&]authorization=/, "signing call must carry the token in the query");
  assert.equal(Buffer.concat(result.chunks || []).length, 16);

  // …and a normal data route must not leak the token into the URL, where it
  // would end up in logs and Referer headers for no reason.
  const second = [];
  await withFetch(
    async (url) => {
      second.push(url);
      return jsonResponse({ success: true, data: [] });
    },
    async () => {
      await handler(req("/api/pw/v3/batches/abc/details"), mockRes());
    }
  );
  assert.doesNotMatch(second[0], /authorization=/, "data routes keep the token in the header");
});

test("pwFetch (the in-process path) walks hosts through a 404 too", async () => {
  // The site's own reads use pwFetch, not the HTTP route. It kept a copy of the
  // old "404 is final" rule, so GetPdf answered "PDF is not available" for a PDF
  // the mirror served — while the same call through /api/pw worked. Both paths
  // must fail over identically.
  const { pwFetch } = await import("../lib/pw-proxy.mjs");
  const { result, calls } = await withFetch(
    async (url) => {
      if (url.includes("vidcloud.eu.org/api")) {
        return jsonResponse({ success: true, data: { key: "a/b.pdf" } });
      }
      return jsonResponse({ success: false, message: "Not Found" }, 404);
    },
    () =>
      pwFetch("/GetPdf?BatchId=b&SubjectId=s&PdfId=p&AttachmentId=a")
  );

  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.key, "a/b.pdf");
  const dataCalls = calls.filter((c) => c.url.includes("GetPdf"));
  assert.ok(
    dataCalls.length >= 2,
    `should have walked past the first host, saw ${dataCalls.map((c) => c.url.split("/")[2]).join(",")}`
  );
  assert.ok(dataCalls.some((c) => !c.url.includes("api.penpencil.co")), "reached a mirror");
});
