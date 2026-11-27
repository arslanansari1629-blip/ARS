/**
 * The Next Toppers section's upstream client.
 *
 * `/nexttopper` is a third platform on this site, modelled on the
 * Allen stack (see lib/allen.mjs) and pointed at the same Nexthope
 * backend that serves Allen — their NT pages live under
 * stream.nexthope.sbs/nexttopper (index → content.html?id=<batch>).
 *
 * This module starts life with a discovery probe (`view=raw`): the
 * NT frontend is a JS app whose API routes are not the Allen ones,
 * so before building on guesses we read the real page source
 * server-side and record what it actually calls. The catalogue /
 * drill-down views land here once the probe has named them.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function ntBase() {
  return String(process.env.NEXTTOPPER_API_BASE || process.env.ALLEN_API_BASE || "https://stream.nexthope.sbs").replace(/\/+$/, "");
}

async function askText(path, timeoutMs = 15000) {
  const url = ntBase() + path;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { url, finalUrl: res.url, status: res.status, ok: res.ok, type: res.headers.get("content-type") || "", text };
  } catch (err) {
    return { url, finalUrl: "", status: 0, ok: false, type: "", text: "", error: String(err?.message || err).slice(0, 160) };
  }
}

/**
 * Discovery probe: fetch one upstream NT page and report its script
 * sources + inline fetch/XHR targets + a bounded slice of source, so
 * the real API shape can be read off instead of guessed. Restricted
 * to /nexttopper/ paths on the configured base — this is a mirror of
 * their public frontend, never an open proxy.
 */
export async function ntRaw(params) {
  const path = String(params.path || "/nexttopper/content.html?id=176");
  if (!path.startsWith("/nexttopper/") || path.includes("..")) {
    return { success: false, error: "path must stay under /nexttopper/" };
  }
  const got = await askText(path);
  const html = got.text || "";
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script(?![^>]+src)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
  const calls = [...new Set([...inline.matchAll(/(?:fetch|axios|url\s*[:=]|api[_-]?url\s*[:=])\s*\(?\s*["'`]([^"'`]{3,180})["'`]/gi)].map((m) => m[1]))].slice(0, 60);
  const endpoints = [...new Set([...html.matchAll(/["'`](\/(?:nexttopper|api)\/[^"'`\s<>]{2,160})["'`]/g)].map((m) => m[1]))].slice(0, 80);
  return {
    success: got.ok,
    view: "raw",
    status: got.status,
    finalUrl: got.finalUrl,
    contentType: got.type,
    bytes: html.length,
    scripts,
    calls,
    endpoints,
    inlineScript: inline.slice(0, 24000),
    htmlHead: html.slice(0, 4000),
    error: got.error || (got.ok ? "" : `upstream answered ${got.status}`),
  };
}

const NT_API_ENDPOINTS = new Set(["all-courses", "course-details", "all-content", "check-status"]);

/**
 * POST probe for the NT JSON API (their frontend POSTs JSON bodies;
 * fetch_page can only GET, so shapes are learned through here).
 * Endpoint is whitelisted — never an open proxy.
 */
export async function ntApiProbe(params) {
  const endpoint = String(params.endpoint || "");
  if (!NT_API_ENDPOINTS.has(endpoint)) return { success: false, error: "endpoint not whitelisted" };
  let body = {};
  try {
    body = params.body ? JSON.parse(String(params.body)) : {};
  } catch {
    return { success: false, error: "body must be JSON" };
  }
  const url = `${ntBase()}/nexttopper/api/${endpoint}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json, */*" },
      body: JSON.stringify(body),
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* bounded raw text below */
    }
    return {
      success: res.ok,
      view: "apiprobe",
      endpoint,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      json: json ? JSON.stringify(json).slice(0, 24000) : "",
      text: json ? "" : text.slice(0, 4000),
    };
  } catch (err) {
    return { success: false, view: "apiprobe", endpoint, status: 0, error: String(err?.message || err).slice(0, 160) };
  }
}

/** The /api/nexttopper handler logic (mounted on the batches function). */
export async function nextTopperApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "raw");
  try {
    if (view === "raw") return send(200, await ntRaw(params));
    if (view === "apiprobe") return send(200, await ntApiProbe(params));
    return send(400, { success: false, error: `unknown Next Toppers view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
