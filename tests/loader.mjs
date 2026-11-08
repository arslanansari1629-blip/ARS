/**
 * Node module-resolution shim for tests.
 *
 * Browser modules import site-absolute paths ("/assets/app.js"). This hook maps
 * them onto the real files under public/ so page modules can be executed by
 * Node against a jsdom document.
 */

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("/") && !specifier.startsWith("/api/")) {
    const [pathname, search] = specifier.split("?");
    const file = path.join(PUBLIC, pathname.replace(/^\/+/, ""));
    return { url: `${pathToFileURL(file).href}${search ? `?${search}` : ""}`, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.includes("?")) {
    const { readFile } = await import("node:fs/promises");
    const clean = url.split("?")[0];
    return {
      format: "module",
      source: await readFile(new URL(clean)),
      shortCircuit: true,
    };
  }
  return next(url, context);
}
