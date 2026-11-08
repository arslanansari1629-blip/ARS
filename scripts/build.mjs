/**
 * Build step.
 *
 * The front end is plain HTML/CSS/ES modules — there is nothing to bundle.
 * This step validates the deployable tree and writes a build stamp so the
 * deployment is traceable. Output directory: public/
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const API = path.join(ROOT, "api");

const REQUIRED_PAGES = [
  "index.html",
  "batches.html",
  "batch.html",
  "subject.html",
  "chapter.html",
  "lecture.html",
  "viewer.html",
  "login.html",
  "dashboard.html",
  "library.html",
  "404.html",
];

const REQUIRED_API = [
  "batches.mjs",
  "batch.mjs",
  "contents.mjs",
  "lecture.mjs",
  "stream.mjs",
  "hls.mjs",
  "sign.mjs",
  "pdf.mjs",
  "media.mjs",
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const problems = [];

  for (const page of REQUIRED_PAGES) {
    if (!(await exists(path.join(PUBLIC, page)))) problems.push(`missing page: public/${page}`);
  }
  for (const fn of REQUIRED_API) {
    if (!(await exists(path.join(API, fn)))) problems.push(`missing function: api/${fn}`);
  }

  // sanity check: every page that loads a module script must reference a real file
  const pages = (await readdir(PUBLIC)).filter((f) => f.endsWith(".html"));
  for (const page of pages) {
    const html = await readFile(path.join(PUBLIC, page), "utf8");
    const matches = [...html.matchAll(/<script[^>]+src="(\/assets\/[^"]+)"/g)];
    for (const [, src] of matches) {
      if (!(await exists(path.join(PUBLIC, src.replace(/^\//, ""))))) {
        problems.push(`${page} references missing asset ${src}`);
      }
    }
  }

  const assets = await readdir(path.join(PUBLIC, "assets"));
  if (!assets.includes("theme.css")) problems.push("missing assets/theme.css");

  // page modules must not reference identifiers they never imported
  const { execFile } = await import("node:child_process");
  const moduleCheck = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "scripts", "check-modules.mjs")], (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
  if (!moduleCheck.ok) problems.push(moduleCheck.output);

  if (problems.length) {
    console.error("Build validation failed:\n - " + problems.join("\n - "));
    process.exit(1);
  }

  const stamp = {
    builtAt: new Date().toISOString(),
    pages: pages.sort(),
    functions: REQUIRED_API,
    source: "https://www.learnxpw.site/api",
  };
  await writeFile(path.join(PUBLIC, "build.json"), JSON.stringify(stamp, null, 2));

  console.log(`OK — ${pages.length} pages, ${REQUIRED_API.length} API functions, ${assets.length} assets`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
