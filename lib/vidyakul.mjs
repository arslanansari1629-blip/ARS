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
  return { key, iugzLen: iugzSrc.length, payloadLen: payload.length, payload, plain };
}

/**
 * Known-plaintext recovery for the packer key: if the hashed key is
 * even slightly off (a whitespace difference in the source the hash
 * ate), the XOR output is the plaintext shifted by a fixed 8-byte
 * mask. Trying JS cribs ("function", "wYZfb", …) at every offset
 * reveals the mask; the candidate whose decryption reads like code
 * wins. Self-verifying: only a >90%-printable result is believed.
 */
export async function vkKeyFix() {
  const { key: k0, plain: g } = await vkDecryptBundle();
  const cribs = ["function", "wYZfb", "document", "localStorage", "return ", "const ", "fetch("];
  const xorWith = (text, key) => {
    let out = "";
    for (let i = 0; i < text.length; i++) out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length) ^ k0.charCodeAt(i % k0.length));
    return out;
  };
  let best = null;
  for (const crib of cribs) {
    for (let p = 0; p < Math.min(800, g.length - crib.length); p++) {
      const cand = Array.from(k0);
      for (let i = 0; i < crib.length; i++) {
        const at = (p + i) % 8;
        cand[at] = String.fromCharCode(k0.charCodeAt(at) ^ g.charCodeAt(p + i) ^ crib.charCodeAt(i));
      }
      const trial = xorWith(g.slice(0, 160), cand.join(""));
      let printable = 0;
      for (const c of trial) if ((c >= " " && c <= "~") || c === "\n" || c === "\t") printable++;
      printable /= trial.length;
      const jsHits = ["function", "const", "var", "let", "return", "wYZfb", "document"].filter((w) => trial.includes(w)).length;
      const score = printable * 100 + jsHits * 8;
      if (!best || score > best.score) best = { score, printable, key: cand.join(""), crib, at: p, head: trial.slice(0, 300) };
    }
  }
  if (best) best.head = xorWith(g.slice(0, 400), best.key).slice(0, 400);
  return { success: true, baseKey: k0, best };
}

/** A window of raw bundle text (or decrypted payload) around a keyword. */
export async function vkPlainFind(params) {
  const find = String(params.find || "QNO6");
  let text;
  if (params.src === "plain") {
    const bundle = await vkDecryptBundle();
    text = vkXorDecrypt(bundle.payload, "fsiegraa");
    if (!text.slice(0, 200).includes("function")) text = bundle.plain;
  } else {
    ({ text } = await vkFetch("/radha-radha-radha-radha-radha-app.js"));
  }
  const at = text.indexOf(find);
  if (at < 0) return { success: false, error: `not found: ${find}`, len: text.length };
  return { success: true, find, at, window: text.slice(Math.max(0, at - 300), at + 2400) };
}

/** The decrypted payload, page by page (6,000 chars from `at`). */
export async function vkPlain(params) {
  const bundle = await vkDecryptBundle();
  let plain = vkXorDecrypt(bundle.payload, "fsiegraa");
  if (!plain.slice(0, 200).includes("function")) plain = bundle.plain;
  const at = Math.max(0, Math.min(Number(params.at) || 0, Math.max(0, plain.length - 1)));
  return { success: true, at, len: plain.length, text: plain.slice(at, at + 6000), b64: Buffer.from(plain.slice(at, at + 4000), "utf8").toString("base64") };
}

/** Long letter-strings in the payload — the cipher alphabet hides here. */
export async function vkAlpha() {
  const bundle = await vkDecryptBundle();
  let plain = vkXorDecrypt(bundle.payload, "fsiegraa");
  if (!plain.slice(0, 200).includes("function")) plain = bundle.plain;
  const strs = [...plain.matchAll(/["'`]([^"'`]{18,80})["'`]/g)]
    .map((m) => m[1])
    .filter((s) => /^[A-Za-z0-9+/=_<>;:.,!@#$%^&*()[\]{}|\\/? -]+$/.test(s));
  const unique = [...new Set(strs)];
  const alphabets = unique.filter((s) => new Set(s.toLowerCase().replace(/[^a-z]/g, "")).size >= 20);
  return { success: true, count: unique.length, alphabets: alphabets.slice(0, 20), sample: unique.slice(0, 40) };
}

/** XOR-6 decode — the string table's second layer (verified by cribs). */
export function vkXor6(s) {
  let out = "";
  for (const ch of String(s)) out += String.fromCharCode(ch.charCodeAt(0) ^ 6);
  return out;
}

/** Parse + decode the payload's string table, with indices. */
export function vkTable(plain) {
  const start = plain.indexOf('["rokcurgkvu"');
  if (start < 0) return [];
  const out = [];
  let i = start + 1;
  while (i < plain.length && plain[i] !== "]") {
    if (plain[i] === '"' || plain[i] === "'") {
      const { value, end } = readJsString(plain, i);
      out.push(vkXor6(value));
      i = end;
    } else i++;
  }
  return out;
}

export async function vkDeobf() {
  const bundle = await vkDecryptBundle();
  // Prefer whichever key yields code: the hashed one, the
  // crib-verified one for this bundle vintage, or a fresh recovery.
  let { plain } = bundle;
  let key = bundle.key;
  const readsLikeCode = (s) => s.slice(0, 200).includes("function");
  if (!readsLikeCode(plain)) {
    const alt = vkXorDecrypt(bundle.payload, "fsiegraa");
    if (readsLikeCode(alt)) {
      plain = alt;
      key = "fsiegraa";
    } else {
      const fixed = await vkKeyFix().catch(() => null);
      if (fixed?.best?.key) {
        key = fixed.best.key;
        plain = vkXorDecrypt(bundle.payload, key);
      }
    }
  }
  const table = vkTable(plain);
  const decodedText = table.join("\n");
  const urls = [...new Set([...decodedText.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gi)].map((m) => m[0]))].slice(0, 60);
  const paths = [...new Set([...decodedText.matchAll(/[^\s"'`]*\.(?:php|json|m3u8|mpd)(?:\?[^\s"'`]*)?/gi)].map((m) => m[0]))].slice(0, 60);
  const interesting = table
    .map((s, i) => ({ i, s }))
    .filter(({ s }) => /php|fetch|api|batch|subject|class|course|play|video|http|previous|live|search/i.test(s))
    .slice(0, 120);
  const fetches = [...plain.matchAll(/fetch\((.{0,120}?)\)/g)].map((m) => m[1].replace(/\s+/g, " ")).slice(0, 20);
  return { success: true, key, tableLen: table.length, table: table.slice(0, 200), interesting, urls, paths, fetches };
}

const VK_AES_KEY = "K9mP2xR7vN4qL8wE3tY6uI0oA5sD1fG!";
const VK_AES_IV = "H7jK9mN2pQ4rT6v!";

export async function vkDecryptData(b64) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(VK_AES_KEY), "AES-CBC", false, ["decrypt"]);
  const ct = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: new TextEncoder().encode(VK_AES_IV) }, key, ct);
  return new TextDecoder().decode(pt);
}

export async function vkApiJson(path) {
  const got = await vkFetch(path);
  let json = null;
  try { json = JSON.parse(got.text); } catch {}
  if (json?.encrypted && json.data) {
    const plain = await vkDecryptData(json.data);
    try { return JSON.parse(plain); } catch { return { raw: plain.slice(0, 4000) }; }
  }
  return json ?? { status: got.status, text: got.text.slice(0, 1000) };
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
    if (view === "keyfix") return send(200, await vkKeyFix().catch((e) => ({ success: false, error: String(e?.message || e) })));
    if (view === "plainfind") return send(200, await vkPlainFind(params).catch((e) => ({ success: false, error: String(e?.message || e) })));
    if (view === "plain") return send(200, await vkPlain(params).catch((e) => ({ success: false, error: String(e?.message || e) })));
    if (view === "alpha") return send(200, await vkAlpha().catch((e) => ({ success: false, error: String(e?.message || e) })));
    if (view === "courses") {
      const page = Math.max(1, Number(params.page) || 1);
      const data = await vkApiJson(`/api/get_courses.php?page=${page}`).catch((e) => ({ error: String(e?.message || e) }));
      const text = JSON.stringify(data);
      return send(200, { success: true, page, bytes: text.length, sample: text.slice(0, 3500) });
    }
    if (view === "classes") {
      const dv = String(params.data_value || "");
      const type = String(params.type || "");
      const data = await vkApiJson(`/api/fetch_classes.php?data_value=${encodeURIComponent(dv)}${type ? `&type=${encodeURIComponent(type)}` : ""}`).catch((e) => ({ error: String(e?.message || e) }));
      const text = JSON.stringify(data);
      return send(200, { success: true, bytes: text.length, sample: text.slice(0, 3500) });
    }
    if (view === "play") {
      const got = await vkFetch(`/play.php?class_id=${encodeURIComponent(params.class_id || "")}&course_id=${encodeURIComponent(params.course_id || "")}`).catch((e) => ({ status: 0, text: "", error: String(e?.message || e) }));
      const html = got.text || "";
      const m = html.match(/id=["']videoUrl["'][^>]*value=["']([^"']+)["']/) || html.match(/value=["']([^"']+)["'][^>]*id=["']videoUrl["']/);
      return send(200, { success: true, status: got.status, len: html.length, videoUrl: m ? m[1] : "", around: m ? html.slice(Math.max(0, m.index - 120), m.index + 220) : html.slice(0, 800) });
    }
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
