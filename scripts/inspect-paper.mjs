/**
 * Print an extraction report for a DPP paper.
 *
 * The parser is forgiving on purpose, but "forgiving" is not the same as
 * "correct": when someone reports that a paper came out with the wrong options,
 * the only useful answer is the runs the PDF actually contains and how they were
 * paired. This prints exactly that, so a bad paper can be diagnosed without a
 * debugger.
 *
 *   node scripts/inspect-paper.mjs <url-or-path> [--json]
 *
 * A URL is fetched the way the server fetches it (browser UA, PDF magic check);
 * a path is read from disk. Nothing here writes to the network.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  extractPdfDocument,
  fetchPaperBytes,
  layoutLines,
  parseDppPaper,
  parseDppPaperFromItems,
  readDppPaper,
} from "../lib/dpp-paper.mjs";

const [, , target, ...rest] = process.argv;
const asJson = rest.includes("--json");

if (!target) {
  console.error("usage: node scripts/inspect-paper.mjs <url-or-path> [--json]");
  process.exit(2);
}

async function bytesOf(input) {
  if (/^https?:\/\//i.test(input)) {
    const out = await fetchPaperBytes(input);
    if (!out.bytes) throw new Error(out.error);
    return out.bytes;
  }
  return new Uint8Array(await readFile(path.resolve(input)));
}

const bytes = await bytesOf(target);
const doc = await extractPdfDocument(bytes);
if (!doc.ok) {
  console.error(`could not read the paper: ${doc.error}`);
  process.exit(1);
}

const fromText = parseDppPaper(doc.text, {});
const fromItems = doc.items.some((page) => page.length)
  ? parseDppPaperFromItems(doc.items, {})
  : null;

if (asJson) {
  console.log(
    JSON.stringify(
      { pages: doc.pages, bytes: bytes.length, fromText, fromItems },
      null,
      2
    )
  );
  process.exit(0);
}

const bar = (label) => console.log(`\n${label}\n${"—".repeat(label.length)}`);

console.log(`${target}`);
console.log(`${doc.pages} page(s) · ${bytes.length} bytes`);
console.log(`text reader:   ${describe(fromText)}`);
console.log(`layout reader: ${fromItems ? describe(fromItems) : "no positioned runs"}`);

bar("how the readers differ");
for (const [name, paper] of [["text", fromText], ["layout", fromItems]]) {
  if (!paper) continue;
  const bad = paper.questions.filter((q) => q.textOnly).length;
  console.log(
    `${name.padEnd(7)} ${String(paper.stats.answerable).padStart(2)} scorable, ${bad} not` +
      ` · parser would be ${name === "layout" ? "preferred" : "fallback"} here`
  );
}

bar("questions");
const chosen = (fromItems && fromItems.stats.answerable >= fromText.stats.answerable) || !fromItems
  ? fromItems || fromText
  : fromText;
for (const q of chosen.questions) {
  const options = q.options.length
    ? q.options.map((o) => `${o.letter}=${o.text || "?"}`).join("  ")
    : "(options not recovered)";
  const key = q.answer ? `→ ${q.answer}${q.textOnly ? " (not scorable)" : ""}` : "→ (no key)";
  console.log(`Q${String(q.number).padEnd(3)} ${key}`);
  console.log(`     ${options}`);
  console.log(`     ${q.text.slice(0, 130)}`);
}

if (process.env.DPP_DUMP_LINES) {
  bar("visual lines");
  doc.items.forEach((page, index) => {
    console.log(`— page ${index + 1}`);
    for (const line of layoutLines(page)) console.log(`  ${line.text}`);
  });
}

function describe(paper) {
  return (
    `${paper.stats.total} question(s), ${paper.stats.answerable} scorable, ` +
    `${paper.stats.unreadable} not · key ${paper.answerKeyFound ? "found" : "missing"} · ` +
    `${paper.duration || "no"} min · ${JSON.stringify(paper.title)}`
  );
}
