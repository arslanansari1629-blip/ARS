/**
 * Vidyakul platform — built from the public mirror at
 * vidyakool.streamfiles.eu.org (linked by the operator). Like the
 * Allen/NT platforms it is an overseer client: catalogue, content
 * tree and playback resolve through `/api/vidyakul?view=…`.
 *
 * This module starts with the probe views used to map the upstream
 * honestly (raw page/API reads confined to that one origin); the
 * platform views grow on top of whatever the probes prove.
 */

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

export function vkBase() {
  return String(process.env.VIDYAKUL_BASE || "https://vidyakool.streamfiles.eu.org").replace(/\/+$/, "");
}

async function vkFetch(path, { method = "GET", body = null, type = "" } = {}) {
  const url = path.startsWith("http") ? path : `${vkBase()}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "User-Agent": UA,
      Accept: type || "text/html,application/json,*/*",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, type: res.headers.get("content-type") || "", text, url: res.url };
}

/**
 * Raw read, confined to the upstream origin: the discovery tool the
 * platform was mapped with. `find=` returns the window around a
 * keyword instead of the head, so one call can reach the interesting
 * part of a big page or bundle.
 */
export async function vkRaw(params) {
  const path = String(params.path || "/");
  let url;
  try {
    url = new URL(path, `${vkBase()}/`);
  } catch {
    return { success: false, error: "bad path" };
  }
  if (url.origin !== new URL(vkBase()).origin) {
    return { success: false, error: "raw reads stay on the Vidyakul upstream" };
  }
  const got = await vkFetch(url.pathname + url.search).catch((e) => ({ status: 0, type: "", text: "", url: String(url), error: String(e?.message || e) }));
  const find = String(params.find || "");
  const at = Math.max(0, Number(params.at) || 0);
  let snippet = at ? got.text.slice(at, at + 6000) : got.text.slice(0, 6000);
  if (find) {
    const at = got.text.toLowerCase().indexOf(find.toLowerCase());
    snippet = at >= 0 ? got.text.slice(Math.max(0, at - 400), at + 5600) : `(not found: ${find}) ` + snippet;
  }
  const scripts = [...got.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 20);
  const links = [...got.text.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]).filter((h) => !h.startsWith("#")).slice(0, 30);
  return {
    success: got.status > 0,
    status: got.status,
    type: got.type,
    finalUrl: got.url,
    length: got.text.length,
    scripts,
    links,
    snippet,
    ...(got.error ? { error: got.error } : {}),
  };
}

/** One named function from the app bundle, base64 — for decoder study. */
export async function vkFunction(params) {
  const name = String(params.name || "");
  if (!/^[\w$]{2,24}$/.test(name)) return { success: false, error: "bad name" };
  const got = await vkFetch("/radha-radha-radha-radha-radha-app.js");
  const at = got.text.indexOf(`function ${name}`);
  if (at < 0) return { success: false, error: `function ${name} not found` };
  const next = got.text.indexOf("function ", at + 10);
  const src = got.text.slice(at, next > at ? next : at + 4000);
  return { success: true, name, length: src.length, b64: Buffer.from(src, "utf8").toString("base64") };
}

/* ---------------- self-decrypt: the bundle's own packer, opened ----
   The app ships as an eval-packer: a small prologue (Iugz) XOR-
   decrypts a percent-escaped payload with a key hashed from Iugz's
   own source (L7fr), then evals the result — the string table the
   whole app reads. No eval here: both functions are re-implemented
   from their published constants (verified numerically), so the
   Worker can open the bundle exactly the way the browser does. */

export function vkHashKey(source) {
  let h = 21866086;
  for (let j = 0; j < source.length; j++) {
    h ^= (source.charCodeAt(j) * 2 + source.charCodeAt(j >>> 4)) ^ 283620571;
  }
  let key = "";
  for (let z = 0; z < 8; z++) {
    const b = h % 28;
    h = Math.floor(h / 27);
    key += String.fromCharCode(b >= 26 ? 65 + (b - 26) : 97 + b);
  }
  return key;
}

export function vkXorDecrypt(data, key) {
  const d = decodeURI(data);
  let out = "";
  for (let i = 0, k = 0; i < d.length; i++) {
    out += String.fromCharCode(d.charCodeAt(i) ^ key.charCodeAt(k));
    k = k + 1 >= key.length ? 0 : k + 1;
  }
  return out;
}

/** Extract a double-quoted JS string literal starting at `open` (index of "). */
function readJsString(text, open) {
  let out = "";
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "x") { out += String.fromCharCode(parseInt(text.substr(i + 2, 2), 16)); i += 3; }
      else if (n === "u" && text[i + 2] === "{") { const end = text.indexOf("}", i); out += String.fromCodePoint(parseInt(text.slice(i + 3, end), 16)); i = end; }
      else if (n === "u") { out += String.fromCharCode(parseInt(text.substr(i + 2, 4), 16)); i += 5; }
      else if (n === "n") { out += "\n"; i++; }
      else if (n === "t") { out += "\t"; i++; }
      else if (n === "r") { out += "\r"; i++; }
      else { out += n; i++; }
    } else if (c === '"') {
      return { value: out, end: i };
    } else out += c;
  }
  return { value: out, end: text.length };
}

export async function vkDecryptBundle() {
  const got = await vkFetch("/radha-radha-radha-radha-radha-app.js");
  const text = got.text;
  // Iugz's source: the string literal handed to the prologue's eval.
  const evalAt = text.indexOf('eval("');
  if (evalAt < 0) throw new Error("prologue eval not found");
  let iugzSrc = readJsString(text, evalAt + 5).value;
  // Function.prototype.toString() returns "function Iugz…{…}" — the
  // eval literal wraps it in parens, which the hash must not see.
  if (iugzSrc.startsWith("(")) iugzSrc = iugzSrc.slice(1);
  if (iugzSrc.endsWith(")")) iugzSrc = iugzSrc.slice(0, -1);
  // The payload: the long percent-escaped literal the prologue feeds
  // Iugz. It does not start with a % code, so find the code run first,
  // then walk back to the opening quote of its literal.
  const pctAt = text.search(/(?:%[0-9A-F]{2}){4,}/i);
  if (pctAt < 0) throw new Error("payload literal not found");
  const open = text.lastIndexOf('"', pctAt);
  const payload = readJsString(text, open).value;
  const key = vkHashKey(iugzSrc);
  const plain = vkXorDecrypt(payload, key);
  return { key, iugzLen: iugzSrc.length, payloadLen: payload.length, plain };
}

export async function vkDeobf() {
  const { key, plain } = await vkDecryptBundle();
  const urls = [...new Set([...plain.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gi)].map((m) => m[0]))].slice(0, 60);
  const paths = [...new Set([...plain.matchAll(/["'`](\/?[\w./-]+\.(?:php|json|m3u8|mpd)(?:\?[^"'`]*)?)["'`]/gi)].map((m) => m[1]))].slice(0, 60);
  const fetches = [...plain.matchAll(/fetch\((.{0,120}?)\)/g)].map((m) => m[1].replace(/\s+/g, " ")).slice(0, 20);
  return { success: true, key, plainLen: plain.length, head: plain.slice(0, 2500), urls, paths, fetches };
}

export async function vidyakulApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "probe");
  try {
    if (view === "raw") return send(200, await vkRaw(params));
    if (view === "fn") return send(200, await vkFunction(params));
    if (view === "deobf") {
      try {
        return send(200, await vkDeobf());
      } catch (e) {
        return send(200, { success: false, error: String(e?.message || e) });
      }
    }
    if (view === "probe") {
      const home = await vkRaw({ path: "/" });
      return send(200, { success: true, base: vkBase(), home: { status: home.status, length: home.length, scripts: home.scripts } });
    }
    return send(400, { success: false, error: `unknown Vidyakul view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
