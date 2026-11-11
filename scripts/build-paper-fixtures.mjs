/**
 * Build the DPP paper fixtures.
 *
 * Two PDFs, on purpose:
 *
 *   · `dpp-paper.pdf` — the original two-question page, written as ordinary
 *     left-to-right text lines. This is the easy layout, and it is kept because
 *     it is what the first reader was written against.
 *   · `dpp-paper-real.pdf` — a reproduction of the *actual* DPP 11 layout from
 *     Arjuna JEE 2027 (Units and Measurements). Here the option letter and its
 *     value are separate text runs, the stem is interleaved with its inline
 *     maths, and the values are set in a column beside the letters. Read as a
 *     stream of lines it pairs every letter with the wrong number: `(A) (B)`
 *     followed by `5 4`. Only the positioned reader gets it right, so this is
 *     the fixture that decides whether the feature works on a real paper.
 *
 * Run with `node scripts/build-paper-fixtures.mjs` (needs the dev dependency
 * `pdf-lib`); the generated files are committed, so the test suite does not.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests", "fixtures");
const PAGE_W = 595; // A4 at 72 dpi
const PAGE_H = 842;
const LEFT = 50;
const RIGHT = PAGE_W - 50;

/**
 * A tiny typesetter: places one run per call at an absolute position, the way a
 * PDF writer does. Nothing here wraps text automatically — a paper's numbers
 * land where the source put them, not where a layout engine would.
 */
function sheet(pdf) {
  let page = null;
  const font = { normal: null, bold: null };
  const api = {
    async init() {
      font.normal = await pdf.embedFont(StandardFonts.Helvetica);
      font.bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      return api;
    },
    newPage() {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      return api;
    },
    /** `at` is the run's left edge; `y` is measured from the top of the page. */
    run(text, { x = LEFT, y, size = 11, bold = false } = {}) {
      page.drawText(String(text), {
        x,
        y: PAGE_H - y,
        size,
        font: bold ? font.bold : font.normal,
      });
      return api;
    },
    /** A run and its measured width, so a column can be laid out beside it. */
    width(text, size = 11, bold = false) {
      return (bold ? font.bold : font.normal).widthOfTextAtSize(String(text), size);
    },
    save: () => pdf.save(),
  };
  return api;
}

async function questionPaper() {
  const pdf = await PDFDocument.create();
  const t = await sheet(pdf).init();
  t.newPage();

  t.run("JEE", { y: 40 });
  t.run("Arjuna JEE 2027", { y: 58, bold: true });
  t.run("Physics by Rajwant Singh Sir  Units and Measurements", { y: 78, size: 10 });
  t.run("DPP: 11", { y: 104, size: 14, bold: true });
  t.run("Time duration - 30 min", { y: 124, size: 10, bold: true });

  /**
   * Where a paper says `… significant figures in 0.06900 is:` and then prints the
   * letters on one line and the values beneath them. The numbers 5 / 4 / 2 / 3
   * are the four options in *visual* order, which is the whole trap.
   */
  const stack = (y, lettersAt, valuesAt) => {
    lettersAt.forEach((x, i) => t.run(`(${String.fromCharCode(65 + i)})`, { x, y }));
    valuesAt.forEach((value, i) => t.run(value, { x: lettersAt[i] + 16, y: y + 14 }));
  };

  t.run("Q1  The most accurate reading of the length of", { y: 150 });
  t.run("long fibre is 6.28 cm", { y: 166, size: 10 }); // inline maths, its own run
  stack(186, [LEFT, 200, 340, 470], ["6 cm", "6.5 cm", "5.99 cm", "6.0 cm"]);

  t.run("Q2  The number of significant figures in", { y: 226 });
  t.run("0.06900", { y: 242, size: 10 });
  t.run("is:", { x: 106, y: 242 });
  stack(258, [LEFT, 200, 340, 470], ["5", "4", "2", "3"]);

  t.run("Q6  Taking into account the significant figures, what", { y: 298 });
  t.run("is the value of (9.99 m - 0.0099 m) ?", { y: 314 });
  stack(334, [LEFT, 200, 340, 470], ["9.98 m", "9.980 m", "9.9 m", "9.9801 m"]);

  t.run("Q12  The mass and radius of the earth are", { y: 374 });
  t.run("5.975 x 10^24 kg and 6.37 x 10^6 m", { y: 390, size: 10 });
  t.run("respectively. Calculate the average earth's density", { y: 404 });
  stack(424, [LEFT, 200, 340, 470], [
    "5.53 x 10^3",
    "5.52 x 10^3",
    "5.54 x 10^3",
    "5.5 x 10^3",
  ]);

  // A question whose options are images only: nothing can be scored there.
  t.run("Q14  If L = 242.33 cm, B = 31 cm and L+B = 2.1 cm then", { y: 464 });
  t.run("[Image: X12]", { y: 480, size: 9 });

  // The key, in the table shape the source uses.
  t.run("Answer Key", { y: 520, size: 11, bold: true });
  const key = [
    ["Q1", "(B)", "Q2", "(B)"],
    ["Q6", "(A)", "Q12", "(B)"],
    ["Q14", "(C)", ""],
  ];
  key.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell) t.run(cell, { x: LEFT + c * 110, y: 542 + r * 16, size: 10 });
      if (c % 2 === 0) {
        // The pipe rules the source prints around every key cell. One pipe per
        // boundary, or the row stops looking like the table it is.
        t.run("|", { x: LEFT - 12, y: 542 + r * 16, size: 10 });
        t.run("|", { x: LEFT + 100, y: 542 + r * 16, size: 10 });
      }
    });
  });

  t.run("Master NCERT with PW Books APP", { y: 720, size: 9 });
  return t.save();
}

/** One question whose values are printed *below* their letters, each alone. */
async function stackedPaper() {
  const pdf = await PDFDocument.create();
  const t = await sheet(pdf).init();
  t.newPage();
  t.run("DPP: 03", { y: 60, size: 13, bold: true });
  t.run("Time duration - 45 min", { y: 80, size: 10 });
  t.run("Q1  The decimal equivalent of upto three", { y: 110 });
  t.run("significant figures is 1/20", { y: 126 });
  const letters = [LEFT, 200, 340, 470];
  const values = ["0.0500", "0.05000", "0.0050", "5.0 x 10"];
  letters.forEach((x, i) => {
    t.run(`(${String.fromCharCode(65 + i)})`, { x, y: 146 });
    t.run(values[i], { x: x + 18, y: 160 });
  });
  t.run("Q2  The sum of the numbers 436.32, 227.2 and 0.301", { y: 200 });
  t.run("in appropriate significant figures is:", { y: 216 });
  letters.forEach((x, i) => {
    t.run(`(${String.fromCharCode(65 + i)})`, { x, y: 236 });
    t.run(["663.821", "664", "663.8", "663.82"][i], { x: x + 18, y: 250 });
  });
  t.run("Answer Key", { y: 300, size: 11, bold: true });
  t.run("Q1 (A)", { y: 320, size: 10 });
  t.run("Q2 (C)", { y: 336, size: 10 });
  return t.save();
}

const files = [
  ["dpp-paper-real.pdf", questionPaper],
  ["dpp-paper-stacked.pdf", stackedPaper],
];

for (const [name, build] of files) {
  const bytes = await build();
  await writeFile(path.join(FIX, name), bytes);
  console.log(`${name} — ${bytes.length} B`);
}
