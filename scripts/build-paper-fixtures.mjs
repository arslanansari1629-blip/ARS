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
 *   · `dpp-paper-columns.pdf` — DPP 11 as PW actually prints it: **two questions
 *     side by side**, question 1 beside question 8, and the left column setting
 *     its options **two to a line** so that option (B)'s value falls past the
 *     midpoint of the two columns. This is the layout that broke the positioned
 *     reader in production — twice. Reading across splices Q8's values into Q1's
 *     options; and a gutter drawn at the midpoint splits Q2 in half, leaving it
 *     with options A and C only. The runs are the real paper's, measured, not
 *     drawn to look right.
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
const PAGE_H = 900; // the source sheet is 548 x 900pt, not A4
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
    /**
     * `at` is the run's left edge; `y` is measured from the top of the page.
     *
     * The source uses Unicode minus and pi, which the built-in WinAnsi font
     * cannot encode. They are folded to ASCII here: the reader only ever compares
     * text, and a fixture that will not build is worse than one that spells `-`
     * for `−`.
     */
    run(text, { x = LEFT, y, size = 11, bold = false } = {}) {
      page.drawText(winAnsi(text), {
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

const winAnsi = (text) =>
  String(text).replace(/\u2212/g, "-").replace(/\u03c0/g, "pi").replace(/\u00a0/g, " ");

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

/**
 * DPP 11 as the source actually prints it: two questions to a row.
 *
 * The question set, the options and the key are the real paper's (Arjuna JEE
 * 2027, Units and Measurements, DPP 11). Only the geometry is reproduced — but
 * the geometry *is* the feature: a row here spans Q1 and Q8, so any reader that
 * groups by line and reads across will hand Q1 the wrong four options.
 */
const DPP11 = [
  {
    n: 1,
    stem: ["The most accurate reading of the length of", "long fibre is 6.28 cm"],
    options: ["6 cm", "6.5 cm", "5.99 cm", "6.0 cm"],
    key: "B",
  },
  {
    n: 2,
    stem: ["The number of significant figures in", "0.06900 is:"],
    options: ["5", "4", "2", "3"],
    key: "B",
  },
  {
    n: 3,
    stem: ["The number of significant figures in", "0.0006032 m2 is:"],
    options: ["4", "5", "7", "3"],
    key: "A",
  },
  {
    n: 4,
    stem: ["What is the number of significant figures in", "0.310 x 10^3?"],
    options: ["2", "3", "4", "6"],
    key: "B",
  },
  {
    n: 5,
    stem: ["The sum of the numbers 436.32, 227.2 and", "0.301 in appropriate significant figures is:"],
    options: ["663.821", "664", "663.8", "663.82"],
    key: "C",
  },
  {
    n: 6,
    stem: ["Taking into account the significant figures,", "what is the value of (9.99 m - 0.0099 m)?"],
    options: ["9.98 m", "9.980 m", "9.9 m", "9.9801 m"],
    key: "A",
  },
  {
    n: 7,
    stem: ["The decimal equivalent of 1/20 upto three", "significant figures is"],
    options: ["0.0500", "0.05000", "0.0050", "5.0 x 10"],
    key: "A",
  },
  {
    n: 8,
    stem: ["The numbers 2.745 and 2.735 on rounding off", "to 3 significant figures will give:"],
    options: ["2.75 and 2.74", "2.74 and 2.73", "2.75 and 2.73", "2.74 2.74"],
    key: "D",
  },
  {
    n: 9,
    stem: ["The length, breadth and thickness of a block", "are l = 12 cm, b = 6 cm, t = 2.45 cm."],
    options: ["1 x 10^2 cm3", "2 x 10^2 cm3", "1.764 x 10^2", "None of these"],
    key: "B",
  },
  {
    n: 10,
    stem: ["The mass and volume of a body are 4.237 g", "and 2.5 cm3. Its density is:"],
    options: ["1.6048", "1.69", "1.7", "1.695"],
    key: "C",
  },
  {
    n: 11,
    stem: ["Subtract 2.5 x 10^-6 from 4.0 x 10^-4 with", "due regard to significant figures"],
    options: ["4.0 x 10^-4", "6.0 x 10^-4", "4.0 x 10^-3", "4.0 x 10^-5"],
    key: "A",
  },
  {
    n: 12,
    stem: ["The mass and radius of the earth are", "5.975 x 10^24 kg and 6.37 x 10^6 m."],
    options: ["5.53 x 10^3", "5.52 x 10^3", "5.54 x 10^3", "5.5 x 10^3"],
    key: "B",
  },
  {
    n: 13,
    stem: ["The significant figures of the number", "6.0023 are:"],
    options: ["1", "5", "4", "2"],
    key: "B",
  },
  {
    n: 14,
    stem: ["If L = 242.33 cm, B = 2.1 cm", "then L + B ="],
    options: ["4.423 cm", "4.43 cm", "4.4 cm", "4 cm"],
    key: "C",
  },
];

/**
 * The real paper's runs, as measured.
 *
 * DPP 11 was read back from production (`/api/pdf?dpp=…&lines=1&runs=1`) and its
 * runs are copied here verbatim — same text, same x/y, same font size — because
 * the layout *is* the bug. A hand-drawn two-column page is smooth and evenly
 * spaced; this one is not:
 *
 *   · the left column sets its options **two to a line**, `(A)` at x=53 and `(B)`
 *     at x=165, with `(B)`'s value at x=181 — *past the midpoint of the two
 *     columns*, which is where the first reader put its gutter. Only the left
 *     column does this; the right column sets one option per line.
 *   · columns start at x=29 and x=311, and the right column's `Q10` is 19pt wide
 *     while `Q1` is 13, so "the same column" is a range, not a value.
 *   · option values are set at 12.3pt while letters are 10.2pt, and superscripts
 *     are 8.7pt runs a few points above the line.
 *   · the sheet is 548pt wide, not A4, so proportional scaling would move every
 *     number.
 *
 * Regenerating by hand would lose all of that, so the numbers are copied. Each
 * tuple is `[text, x, y, size]`.
 */
const REAL_PAGE_1 = [
  ["JEE", 545.87, 54, 10.2],
  ["Arjuna JEE 2027", 226, 87, 19.2],
  ["Physics by Rajwant Singh Sir", 194, 114, 16],
  ["Units and Measurements", 209, 143, 16],
  ["DPP: 11", 513.87, 143, 12.8],
  ["Time duration -", 217, 175, 16],
  ["30", 333.87, 175, 18],
  ["min", 355.87, 175, 16],

  // Q1 — left column, options one to a line, all well inside the column.
  ["Q1", 29, 212, 10.2],
  ["The most accurate reading of the length of", 51, 212, 10.2],
  ["long", 95, 228, 10.2],
  ["fi", 118, 228, 10.2],
  ["bre is", 124, 228, 10.2],
  ["6.28 cm", 51, 228, 12.3],
  ["(A)", 51, 244, 10.2],
  ["6 cm", 67, 244, 12.3],
  ["(B)", 51, 260, 10.2],
  ["6.5 cm", 67, 260, 12.3],
  ["(C)", 51, 276, 10.2],
  ["5.99 cm", 67, 276, 12.3],
  ["(D)", 51, 292, 10.2],
  ["6.0 cm", 67, 292, 12.3],

  // Q8 — right column, at the same height as Q1.
  ["Q8", 310.87, 254, 10.2],
  ["The numbers", 334.87, 254, 10.2],
  ["2.745", 396.87, 254, 12.3],
  ["and", 427.87, 254, 10.2],
  ["2.735", 446.87, 254, 12.3],
  ["on rounding off", 477.87, 254, 10.2],
  ["to", 334.87, 270, 10.2],
  ["3", 346.87, 270, 12.3],
  ["signi", 355.87, 270, 10.2],
  ["fi", 376.87, 270, 10.2],
  ["cant", 382.87, 270, 10.2],
  ["fi", 404.87, 270, 10.2],
  ["gures will give:", 410.87, 270, 10.2],
  ["(A)", 334.87, 286, 10.2],
  ["2.75", 350.87, 286, 12.3],
  ["and", 374.87, 286, 10.2],
  ["2.74", 394.87, 286, 12.3],
  ["(B)", 334.87, 302, 10.2],
  ["2.74", 349.87, 302, 12.3],
  ["and", 374.87, 302, 10.2],
  ["2.73", 394.87, 302, 12.3],
  ["(C)", 334.87, 318, 10.2],
  ["2.75", 350.87, 318, 12.3],
  ["and", 374.87, 318, 10.2],
  ["2.73", 394.87, 318, 12.3],
  ["(D)", 334.87, 334, 10.2],
  ["2.74", 350.87, 334, 12.3],
  ["and", 374.87, 334, 10.2],
  ["2.74", 394.87, 334, 12.3],

  /*
   * Q2 — the one that broke. Its options are set **two to a line**, so `(B)` sits
   * at x=165 and its value `4` at x=181 — to the right of the midpoint 170. Any
   * gutter drawn between the columns splits this question in half: (A) keeps its
   * `5`, (C) keeps its `2`, and B and D lose their values across the gutter.
   */
  ["Q2", 29, 318, 10.2],
  ["The number of signi", 53, 318, 10.2],
  ["fi", 143, 318, 10.2],
  ["cant", 149, 318, 10.2],
  ["fi", 171, 318, 10.2],
  ["gures in", 178, 318, 10.2],
  ["0.06900", 216, 318, 12.3],
  ["is:", 259, 318, 10.2],
  ["(A)", 53, 334, 10.2],
  ["5", 69, 334, 12.3],
  ["(B)", 165, 334, 10.2],
  ["4", 181, 334, 12.3],
  ["(C)", 53, 350, 10.2],
  ["2", 69, 350, 12.3],
  ["(D)", 165, 350, 10.2],
  ["3", 181, 350, 12.3],

  // Q9 — right column, beside Q2.
  ["Q9", 310.87, 359, 10.2],
  ["The length, breadth, and thickness of a block are", 334.87, 359, 10.2],
  ["given by", 334.87, 375, 10.2],
  ["l", 375.87, 375, 12.3],
  ["= 12 cm, b = 6 cm", 382.87, 375, 12.3],
  ["and", 485.87, 375, 10.2],
  ["t = 2.45 cm", 334.87, 391, 10.2],
  [". The volume of the block according", 396.87, 391, 10.2],
  ["to the idea of signi", 334.87, 407, 10.2],
  ["fi", 418.87, 407, 10.2],
  ["cant", 424.87, 407, 10.2],
  ["fi", 447.87, 407, 10.2],
  ["gures should be:", 453.87, 407, 10.2],
  ["(A)", 334.87, 423, 10.2],
  ["1 × 10", 350.87, 423, 12.3],
  ["cm", 391.87, 423, 12.3],
  ["2", 382.87, 434, 8.7],
  ["3", 406.87, 435, 8.7],
  ["(B)", 334.87, 439, 10.2],
  ["2 × 10", 349.87, 439, 12.3],
  ["cm", 390.87, 439, 12.3],
  ["(C)", 334.87, 455, 10.2],
  ["1.764 × 10", 349.87, 455, 12.3],
  ["cm", 413.87, 455, 12.3],
  ["3", 407.87, 466, 8.7],
  ["(D)", 334.87, 471, 10.2],
  ["None of these", 350.87, 471, 10.2],

  // Q3 — left column, two options to a line again.
  ["Q3", 29, 375, 10.2],
  ["The number of signi", 53, 375, 10.2],
  ["fi", 143, 375, 10.2],
  ["cant", 149, 375, 10.2],
  ["fi", 171, 375, 10.2],
  ["gures in", 178, 375, 10.2],
  ["2", 119, 387, 8.7],
  ["0.0006032 m", 53, 391, 12.3],
  ["is:", 127, 391, 10.2],
  ["(A)", 53, 407, 10.2],
  ["4", 69, 407, 12.3],
  ["(B)", 165, 407, 10.2],
  ["5", 180, 407, 12.3],
  ["(C)", 53, 423, 10.2],
  ["7", 69, 423, 12.3],
  ["(D)", 165, 423, 10.2],
  ["3", 181, 423, 12.3],

  // Q10 — right column, beside Q3.
  ["Q10", 310.87, 489, 10.2],
  ["The mass and volume of a body are", 339.87, 489, 10.2],
  ["and", 500.87, 489, 10.2],
  ["4.237 g", 502.87, 505, 12.3],
  [", respectively. The density of the", 379.87, 521, 10.2],
  ["2.5 cm", 339.87, 521, 12.3],
  ["3", 373.87, 530, 8.7],
  ["material of the body in correct signi", 339.87, 537, 10.2],
  ["fi", 500.87, 537, 10.2],
  ["cant", 506.87, 537, 10.2],
  ["fi", 528.87, 537, 10.2],
  ["gures", 535.87, 537, 10.2],
  ["is:", 339.87, 553, 10.2],
  ["(A)", 339.87, 569, 10.2],
  ["1.6048 g cm", 355.87, 569, 12.3],
  ["−3", 417.87, 564, 8.7],
  ["(B)", 339.87, 585, 10.2],
  ["1.69 g cm", 354.87, 585, 12.3],
  ["−3", 404.87, 581, 8.7],
  ["(C)", 339.87, 601, 10.2],
  ["1.7 g cm", 354.87, 601, 12.3],
  ["−3", 398.87, 597, 8.7],
  ["(D)", 339.87, 617, 10.2],
  ["1.695 g cm", 355.87, 617, 12.3],
  ["−3", 411.87, 613, 8.7],

  // Q4 — left column.
  ["Q4", 29, 457, 10.2],
  ["What is the number of signi", 53, 457, 10.2],
  ["fi", 178, 457, 10.2],
  ["cant", 184, 457, 10.2],
  ["fi", 206, 457, 10.2],
  ["gures in", 212, 457, 10.2],
  ["0.310 × 10", 53, 473, 12.3],
  ["3", 108, 468, 8.7],
  ["?", 116, 473, 10.2],
  ["(A)", 53, 489, 10.2],
  ["2", 69, 489, 12.3],
  ["(B)", 166, 489, 10.2],
  ["3", 181, 489, 12.3],
  ["(C)", 53, 505, 10.2],
  ["4", 69, 505, 12.3],
  ["(D)", 165, 505, 10.2],
  ["3", 181, 505, 12.3],

  // Q11 — right column, beside Q4.
  ["Q11", 310.87, 643, 10.2],
  ["Subtract", 337.87, 643, 10.2],
  ["2.5 × 10", 378.87, 643, 12.3],
  ["from", 436.87, 643, 10.2],
  ["4.0 × 10", 460.87, 643, 12.3],
  ["with due", 518.87, 643, 10.2],
  ["−6", 420.87, 638, 8.7],
  ["−4", 503.87, 638, 8.7],
  ["regard to signi", 337.87, 659, 10.2],
  ["fi", 402.87, 659, 10.2],
  ["cant", 408.87, 659, 10.2],
  ["fi", 430.87, 659, 10.2],
  ["gures", 436.87, 659, 10.2],
  ["(A)", 337.87, 675, 10.2],
  ["4.0 × 10", 352.87, 675, 12.3],
  ["−4", 395.87, 670, 8.7],
  ["(B)", 337.87, 691, 10.2],
  ["6.0 × 10", 352.87, 691, 12.3],
  ["−4", 394.87, 686, 8.7],
  ["(C)", 337.87, 707, 10.2],
  ["4.0 × 10", 352.87, 707, 12.3],
  ["−3", 395.87, 702, 8.7],
  ["(D)", 337.87, 723, 10.2],
  ["4.0 × 10", 352.87, 723, 12.3],
  ["−5", 395.87, 718, 8.7],

  // Q5 — left column.
  ["Q5", 29, 531, 10.2],
  ["The sum of the numbers", 53, 531, 10.2],
  ["436.32, 227.2", 166, 531, 12.3],
  ["and", 235, 531, 10.2],
  ["0.301", 53, 547, 12.3],
  ["in appropriate signi", 84, 547, 10.2],
  ["fi", 171, 547, 10.2],
  ["cant", 177, 547, 10.2],
  ["fi", 199, 547, 10.2],
  ["gures is:", 205, 547, 10.2],
  ["(A)", 53, 563, 10.2],
  ["663.821", 69, 563, 12.3],
  ["(B)", 165, 563, 10.2],
  ["664", 180, 563, 12.3],
  ["(C)", 53, 579, 10.2],
  ["663.8", 69, 579, 12.3],
  ["(D)", 165, 579, 10.2],
  ["663.82", 181, 579, 12.3],

  // Q12 — right column, beside Q5.
  ["Q12", 310.87, 727, 10.2],
  ["The mass and radius of the earth are", 338.87, 727, 10.2],
  ["24", 393.87, 739, 8.7],
  ["5.975 ×", 338.87, 744, 12.3],
  ["kg", 406.87, 744, 12.3],
  ["6.37 ×", 441.87, 744, 12.3],
  ["m", 498.87, 744, 12.3],
  ["10", 381.87, 744, 12.3],
  ["10", 477.87, 744, 12.3],
  ["6", 489.87, 739, 8.7],
  ["and", 421.87, 748, 10.2],
  ["respectively. Calculate the average earth's", 338.87, 760, 10.2],
  ["density to correct significant figures. Take", 338.87, 776, 10.2],
  ["π = 3.142", 338.87, 792, 10.2],
  ["(A)", 338.87, 808, 10.2],
  ["5.53 × 10", 353.87, 808, 12.3],
  ["3", 395.87, 803, 8.7],
  ["(B)", 338.87, 824, 10.2],
  ["5.52 × 10", 353.87, 824, 12.3],
  ["3", 395.87, 819, 8.7],
  ["(C)", 338.87, 840, 10.2],
  ["5.54 × 10", 353.87, 840, 12.3],
  ["3", 395.87, 835, 8.7],
  ["(D)", 338.87, 856, 10.2],
  ["5.5 × 10", 353.87, 856, 12.3],
  ["3", 390.87, 851, 8.7],

  // Q6 — left column.
  ["Q6", 29, 605, 10.2],
  ["Taking into account the signi", 53, 605, 10.2],
  ["fi", 182, 605, 10.2],
  ["cant", 188, 605, 10.2],
  ["fi", 210, 605, 10.2],
  ["gures, what", 216, 605, 10.2],
  ["is the value of", 53, 621, 10.2],
  ["(9.99 m − 0.0099 m)", 119, 621, 12.3],
  ["?", 229, 621, 10.2],
  ["(A)", 53, 637, 10.2],
  ["9.98 m", 69, 637, 12.3],
  ["(B)", 53, 653, 10.2],
  ["9.980 m", 68, 653, 12.3],
  ["(C)", 53, 669, 10.2],
  ["9.9 m", 69, 669, 12.3],
  ["(D)", 53, 685, 10.2],
  ["9.9801 m", 69, 685, 12.3],

  // Q7 — left column, with the sheet's header block beside it.
  ["Q7", 29, 711, 10.2],
  ["The decimal equivalent of", 53, 711, 10.2],
  ["1/20", 172, 711, 12.3],
  ["upto three", 199, 711, 10.2],
  ["signi", 53, 727, 10.2],
  ["fi", 73, 727, 10.2],
  ["cant", 79, 727, 10.2],
  ["fi", 102, 727, 10.2],
  ["gures is", 108, 727, 10.2],
  ["(A)", 53, 743, 10.2],
  ["0.0500", 68, 743, 12.3],
  ["(B)", 53, 759, 10.2],
  ["0.05000", 68, 759, 12.3],
  ["(C)", 53, 775, 10.2],
  ["0.0050", 68, 775, 12.3],
  ["(D)", 53, 791, 10.2],
  ["5.0 × 10", 69, 791, 12.3],
  ["Master NCERT with PW Books APP", 220, 880, 12.3],
];

/**
 * DPP 11, page for page, as the source sets it.
 *
 * `REAL_PAGE_1` holds the runs of page one. Pages two and three are not dumped run
 * by run: page two carries the tail of Q12 and then Q13–Q14, and page three is the
 * key, both in the same two-column shape. What matters for the reader — the two
 * options to a line whose values cross the midpoint — is on page one, and it is
 * reproduced exactly.
 */
async function columnPaper() {
  const pdf = await PDFDocument.create();
  const t = await sheet(pdf).init();

  t.newPage();
  for (const [text, x, y, size] of REAL_PAGE_1) t.run(text, { x, y, size });

  t.newPage();
  // The top of page two is the *rest* of Q12 — no marker, because the question
  // began on page one. A repeated `Q12` here would read as a fifteenth question.
  const tail = [
    ["respectively. Calculate the average earth's", 53, 30, 10.2],
    ["density to correct significant figures. Take", 53, 46, 10.2],
    ["π = 3.142", 53, 62, 10.2],
    ["(A)", 53, 78, 10.2],
    ["5.53 × 10", 68, 78, 12.3],
    ["3", 110, 73, 8.7],
    ["(B)", 53, 94, 10.2],
    ["5.52 × 10", 68, 94, 12.3],
    ["3", 110, 89, 8.7],
    ["(C)", 53, 110, 10.2],
    ["5.54 × 10", 68, 110, 12.3],
    ["3", 110, 105, 8.7],
    ["(D)", 53, 126, 10.2],
    ["5.5 × 10", 68, 126, 12.3],
    ["3", 104, 121, 8.7],
    ["Q13", 29, 152, 10.2],
    ["The significant figures of the number", 53, 152, 10.2],
    ["6.0023", 254, 152, 12.3],
    ["are:", 293, 152, 10.2],
    ["(A)", 53, 168, 10.2],
    ["1", 69, 168, 12.3],
    ["(B)", 165, 168, 10.2],
    ["5", 181, 168, 12.3],
    ["(C)", 53, 184, 10.2],
    ["4", 69, 184, 12.3],
    ["(D)", 165, 184, 10.2],
    ["2", 181, 184, 12.3],
    ["Q14", 29, 210, 10.2],
    ["If", 53, 210, 10.2],
    ["L 2.331 cm", 67, 210, 12.3],
    ["=", 133, 210, 10.2],
    ["B 2.1 cm", 147, 210, 12.3],
    ["= then", 209, 210, 10.2],
    ["L + B", 251, 210, 12.3],
    ["=", 288, 210, 10.2],
    ["(A)", 53, 226, 10.2],
    ["4.423 cm", 69, 226, 12.3],
    ["(B)", 53, 242, 10.2],
    ["4.43 cm", 69, 242, 12.3],
    ["(C)", 53, 258, 10.2],
    ["4.4 cm", 69, 258, 12.3],
    ["(D)", 53, 274, 10.2],
    ["4 cm", 69, 274, 12.3],
    ["JEE", 545.87, 880, 10.2],
  ];
  for (const [text, x, y, size] of tail) t.run(text, { x, y, size });

  // The key, in the source's table shape: `Q1 (B) Q8 (D)` — the left column's
  // markers at x=29 and the right column's at x=311, on the same row.
  t.newPage();
  t.run("Answer Key", { x: 29, y: 60, size: 11, bold: true });
  const KEY = { 1: "B", 2: "B", 3: "A", 4: "B", 5: "C", 6: "A", 7: "A", 8: "D", 9: "B", 10: "C", 11: "A", 12: "B", 13: "B", 14: "C" };
  for (let row = 1; row <= 7; row += 1) {
    const y = 84 + (row - 1) * 22;
    t.run(`Q${row}`, { x: 29, y, size: 9 });
    t.run(`(${KEY[row]})`, { x: 44, y, size: 9 });
    t.run(`Q${row + 7}`, { x: 311, y, size: 9 });
    t.run(`(${KEY[row + 7]})`, { x: 328, y, size: 9 });
  }

  return t.save();
}

const files = [
  ["dpp-paper-real.pdf", questionPaper],
  ["dpp-paper-stacked.pdf", stackedPaper],
  ["dpp-paper-columns.pdf", columnPaper],
];

for (const [name, build] of files) {
  const bytes = await build();
  await writeFile(path.join(FIX, name), bytes);
  console.log(`${name} — ${bytes.length} B`);
}
