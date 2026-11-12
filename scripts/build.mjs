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
  "open.html",
  "offline.html",
  "batches.html",
  "batch.html",
  "subject.html",
  "chapter.html",
  "lecture.html",
  "viewer.html",
  "login.html",
  "dashboard.html",
  "library.html",
  "favourites.html",
  "downloads.html",
  "leaderboard.html",
  "admin.html",
  "404.html",
];

const REQUIRED_API = [
  "batches.mjs",
  "batch.mjs",
  "contents.mjs",
  "lecture.mjs",
  "stream.mjs",
  "pdf.mjs",
  "media.mjs",
  "pw.mjs",
  "token.mjs",
  "admin.mjs",
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

  // Vercel's Hobby plan rejects a deployment with more than 12 serverless
  // functions ("exceeded_serverless_functions_per_deployment"). Catch that here
  // rather than after a two-minute build.
  const functions = (await readdir(API)).filter((f) => f.endsWith(".mjs"));
  // Routes mounted inside another function still need their library, or a
  // rewrite would point at nothing.
  for (const mounted of ["hls.mjs", "sign.mjs", "download-route.mjs"]) {
    if (!(await exists(path.join(ROOT, "lib", mounted)))) {
      problems.push(`missing mounted route: lib/${mounted}`);
    }
  }
  if (functions.length > 12) {
    problems.push(
      `too many serverless functions: ${functions.length} (Hobby plan allows 12) — ` +
        `fold the extra route into an existing file and rewrite it in vercel.json`
    );
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
  // One stylesheet carries the design; the earlier layers are gone.
  if (!assets.includes("arsvibe.css")) problems.push("missing assets/arsvibe.css");

  // The identity is four files that must ship together: the mark every header
  // uses, the tab icon, its PNG touch icon, and the share card.
  for (const brand of ["logo.svg", "icon.svg", "icon.png", "og.png"]) {
    if (!(await exists(path.join(PUBLIC, "assets", brand)))) {
      problems.push(`missing assets/${brand}`);
    }
  }

  // The player libraries ship with the site so playback never depends on a
  // third-party CDN being reachable from the user's network.
  for (const vendor of ["hls.min.js", "dash.all.min.js"]) {
    if (!(await exists(path.join(PUBLIC, "assets", "vendor", vendor)))) {
      problems.push(`missing assets/vendor/${vendor}`);
    }
  }

  // The complete batch catalogue (vidcloud's own source list) must be present:
  // /api/batches searches it locally, so without it the site falls back to the
  // upstream search, which cannot see parts of the catalogue.
  try {
    const { loadCatalogIndex } = await import("../lib/catalog.mjs");
    const index = await loadCatalogIndex();
    if (!index || index.batches.length < 1000) {
      problems.push(`batch catalogue looks incomplete (${index ? index.batches.length : 0} rows)`);
    } else {
      console.log(`catalogue OK — ${index.batches.length} batches indexed`);
    }
  } catch (err) {
    problems.push(`batch catalogue unavailable: ${err.message}`);
  }

  /* Relative imports must point at a file that exists.
     A browser reports a 404 module as "Failed to fetch dynamically imported
     module" and nothing else, so a typo here is invisible until the feature
     silently does nothing in production. The page-module check does not cover
     this because it compares syntax, not paths. */
  for (const file of assets.filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))) {
    const source = await readFile(path.join(PUBLIC, "assets", file), "utf8");
    for (const [, spec] of source.matchAll(/import\s*(?:\(\s*)?["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(PUBLIC, "assets", spec);
      if (!(await exists(target))) {
        problems.push(`assets/${file} imports a missing module: ${spec}`);
      }
    }
  }

  // page modules must not reference identifiers they never imported
  const { execFile } = await import("node:child_process");
  const moduleCheck = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "scripts", "check-modules.mjs")], (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
  if (!moduleCheck.ok) problems.push(moduleCheck.output);

  /* ---------------------------------------------------------------------
     Site-wide contract of the "shell" upgrades. These are the things that are
     invisible when wrong — a page without a canonical URL, a manifest pointing
     at an icon that does not exist, a worker nobody registers — so they are
     asserted at build time instead of noticed in production.
     --------------------------------------------------------------------- */
  const PWA_FILES = ["manifest.webmanifest", "sw.js"];
  for (const file of PWA_FILES) {
    if (!(await exists(path.join(PUBLIC, file)))) problems.push(`missing ${file}`);
  }

  // Every icon the manifest promises must exist, at the size it claims.
  try {
    const manifest = JSON.parse(await readFile(path.join(PUBLIC, "manifest.webmanifest"), "utf8"));
    for (const icon of manifest.icons || []) {
      const rel = String(icon.src || "").replace(/^\//, "");
      if (!(await exists(path.join(PUBLIC, rel)))) {
        problems.push(`manifest promises a missing icon: ${icon.src}`);
      }
    }
    if (!manifest.start_url) problems.push("manifest has no start_url");
    if (!manifest.icons || !manifest.icons.length) problems.push("manifest has no icons");
  } catch (err) {
    problems.push(`manifest.webmanifest is not valid JSON: ${err.message}`);
  }

  const NOINDEX_PAGES = new Set(["404.html", "admin.html", "login.html", "offline.html"]);
  for (const page of pages) {
    const html = await readFile(path.join(PUBLIC, page), "utf8");
    if (!/rel="manifest"/.test(html)) problems.push(`${page} does not link the web manifest`);
    if (!/offline-boot\.js/.test(html)) problems.push(`${page} does not load the offline boot module`);
    // The browser is the only instrument that can see a page throw after a 200.
    // A page without it is silently blind to its own worst failure mode.
    if (!/telemetry\.js/.test(html)) problems.push(`${page} does not load the browser telemetry module`);
    if (!/class="skip-link"/.test(html)) problems.push(`${page} has no skip-to-content link`);

    // `modulepreload` only saves a round trip if the browser sees it before the
    // module graph is requested — i.e. in <head>, never at the bottom of <body>.
    const head = html.slice(0, html.indexOf("</head>"));
    const body = html.slice(html.indexOf("</head>"));
    if (head.includes("modulepreload") === false && body.includes("modulepreload")) {
      problems.push(`${page} preloads modules from <body>, too late to help`);
    }
    if (!/id="main"/.test(html)) problems.push(`${page} has no <main id="main"> landmark`);
    if (NOINDEX_PAGES.has(page)) {
      if (!/name="robots" content="noindex/.test(html)) problems.push(`${page} should be noindex`);
    } else if (!/rel="canonical"/.test(html)) {
      problems.push(`${page} has no canonical URL`);
    }
    if (!NOINDEX_PAGES.has(page) && !/name="description"/.test(html)) {
      problems.push(`${page} has no meta description`);
    }
  }

  // The worker is only useful if it stays small enough to fetch on a bad line.
  const swSource = await readFile(path.join(PUBLIC, "sw.js"), "utf8");
  if (Buffer.byteLength(swSource) > 24 * 1024) {
    problems.push(`sw.js is ${Buffer.byteLength(swSource)} bytes — keep it under 24 KB`);
  }

  if (problems.length) {
    console.error("Build validation failed:\n - " + problems.join("\n - "));
    process.exit(1);
  }

  const stamp = {
    builtAt: new Date().toISOString(),
    pages: pages.sort(),
    functions: REQUIRED_API,
    source: "/api/pw (authenticated pass-through to the PW API)",
  };
  await writeFile(path.join(PUBLIC, "build.json"), JSON.stringify(stamp, null, 2));

  console.log(`OK — ${pages.length} pages, ${REQUIRED_API.length} API functions, ${assets.length} assets`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
