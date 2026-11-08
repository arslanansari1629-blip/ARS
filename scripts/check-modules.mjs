/**
 * Static sanity check for the browser page modules.
 *
 * The pages are plain ES modules loaded by `<script type="module">` in the
 * browser, so a missing import (e.g. calling `api()` without importing it)
 * only shows up at runtime — as it once did on the lecture page. This script
 * strips comments and string/template literals, then flags bare function calls
 * whose identifier is neither imported, declared locally, nor a known global.
 *
 * Run with `node scripts/check-modules.mjs` (also part of npm run build).
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "assets");

const GLOBALS = new Set([
  "fetch", "document", "window", "console", "location", "localStorage", "sessionStorage",
  "history", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "alert", "confirm", "prompt",
  "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Date", "Promise",
  "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "URL", "URLSearchParams",
  "Intl", "RegExp", "Symbol", "decodeURIComponent", "encodeURIComponent", "parseInt",
  "parseFloat", "isNaN", "isFinite", "structuredClone", "CustomEvent", "Event", "Blob",
  "File", "FormData", "Response", "Request", "Headers", "AbortController",
  "AbortSignal", "IntersectionObserver", "MutationObserver", "ResizeObserver",
  "performance", "navigator", "crypto", "atob", "btoa", "queueMicrotask", "globalThis",
  "Uint8Array", "MediaSource", "HTMLElement", "Node", "Element", "getComputedStyle",
  "Image", "Audio", "matchMedia", "TextEncoder", "TextDecoder", "requestIdleCallback",
]);

/** Remove comments and string/template literals so only real code is scanned. */
function stripLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function collectDeclared(src) {
  const declared = new Set(GLOBALS);

  for (const m of src.matchAll(
    /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))\s+from/g
  )) {
    for (const g of [m[1], m[3], m[4]]) if (g) declared.add(g);
    if (m[2]) {
      for (const part of m[2].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) declared.add(name);
      }
    }
  }

  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/g)) {
    declared.add(m[1]);
  }
  // destructuring, including function-parameter destructuring
  for (const m of src.matchAll(/[{[]([^{}[\]]*)[}\]]\s*(?:=[^,;)\n]*)?\s*(?:=>|\)|,|;|\n)/g)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .replace(/\.\.\./, "")
        .split("=")[0]
        .split(":")
        .pop()
        .trim();
      if (/^[\w$]+$/.test(name)) declared.add(name);
    }
  }
  // function parameters (declarations and method shorthand)
  for (const m of src.matchAll(/(?:function\s+[\w$]+\s*|(?:async\s+)?)\s*\(([^)]*)\)\s*\{/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split("=")[0].split(":").pop().trim();
      if (/^[\w$]+$/.test(name)) declared.add(name);
    }
  }
  for (const m of src.matchAll(/(?:^|[\s{(,;])(?:async\s+)?\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (name) declared.add(name);
    }
  }
  for (const m of src.matchAll(/(?:^|[\s{(,;])([\w$]+)\s*=>/g)) declared.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*([\w$]+)\s*\)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([\w$]+)/g)) declared.add(m[1]);
  // Class methods: `player.js` is written as a class, so its members are
  // declarations too — the object-literal heuristic below does not see them.
  for (const m of src.matchAll(/^\s{2,}(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([\w$]+)\s*\(/gm)) {
    declared.add(m[1]);
  }

  return declared;
}

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "new", "function",
  "await", "yield", "do", "else", "delete", "void", "in", "of", "instanceof", "case",
  "throw", "async", "get", "set", "super", "import", "export", "with",
]);

async function main() {
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".js"));
  const problems = [];

  for (const file of files) {
    const src = stripLiterals(await readFile(path.join(DIR, file), "utf8"));
    const declared = collectDeclared(src);
    const missing = new Set();

    for (const m of src.matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (declared.has(name) || KEYWORDS.has(name)) continue;
      // method shorthand / object keys: `name(...) {` inside an object literal
      const after = src.slice(m.index + m[0].length);
      if (/^\s*\{/.test(after) && !/^\s*\{\s*\}/.test(after) && after.includes("\n")) continue;
      missing.add(name);
    }

    if (missing.size) problems.push(`${file}: undefined call(s) → ${[...missing].join(", ")}`);
  }

  if (problems.length) {
    console.error("Page-module check failed:\n - " + problems.join("\n - "));
    process.exit(1);
  }
  console.log(`OK — ${files.length} page modules look self-consistent`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
