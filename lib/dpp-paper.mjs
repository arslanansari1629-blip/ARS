/**
 * DPP papers, as questions.
 *
 * The interactive DPP quiz behind Physics Wallah's test service needs a paid
 * student token, which this site does not have and cannot mint. The *paper*
 * does not: every DPP PDF is guest-readable on static.pw.live, and it contains
 * the questions, the options and the answer key.
 *
 * So this module reads the PDF and turns it into a question list. The layout is
 * hostile. Inline maths lands as its own text run, images appear as placeholders,
 * and — the part that matters — an option's letter and its value are *separate
 * runs*, sometimes on the same line and sometimes in a column beside it:
 *
 *      (A) 6 cm   (B) 6.5 cm      ← one run per cell
 *      (A)        (B)             ← markers on one line,
 *      6 cm       6.5 cm          ← values on the next
 *
 * Reading such a page as a stream of lines yields `(A) (B)` then `5 4`, which
 * pairs the letters with the wrong values. So there are two readers here:
 *
 *   · `parseDppPaperFromItems` — positions. Text runs are grouped into visual
 *     lines by y, and each run is attributed to the nearest option marker to its
 *     left on that line. This is the one that reads a real paper correctly.
 *   · `parseDppPaper` — plain text, kept as the fallback for a PDF whose runs
 *     carry no usable geometry, and for the older fixtures.
 *
 * Neither invents anything: a question whose options could not be recovered is
 * still shown, with its answer, and marked `textOnly`, and `stats.unreadable`
 * counts them. Running a test from a paper we half-read is fine; scoring a
 * student against an answer we guessed is not.
 */

import { extractText, extractTextItems, getDocumentProxy } from "unpdf";

/** Paper PDFs are a few hundred KB; anything past this is not a DPP. */
const MAX_PDF_BYTES = 12 * 1024 * 1024;

/** How far right of a marker its value may start, in PDF units (~points). */
const MAX_OPTION_GAP = 240;

/** Two runs are on the same visual line within this vertical distance. */
const LINE_TOLERANCE = 3;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/* ------------------------------------------------------------- the bytes */

/** Fetch the PDF bytes for a paper URL (static.pw.live or a relay of it). */
export async function fetchPaperBytes(url, { fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, error: "No paper URL was given.", bytes: null };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "The paper URL must be absolute.", bytes: null };
  }
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: "application/pdf,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      return { ok: false, error: `The paper answered ${res.status}.`, bytes: null };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: "The paper came back empty.", bytes: null };
    if (buf.length > MAX_PDF_BYTES) {
      return { ok: false, error: "That file is too large to be a DPP paper.", bytes: null };
    }
    const magic = String.fromCharCode(...buf.subarray(0, 5));
    if (!magic.startsWith("%PDF")) {
      return { ok: false, error: "That link is not a PDF.", bytes: null };
    }
    return { ok: true, bytes: buf, error: "" };
  } catch (err) {
    const message = err?.name === "TimeoutError" ? "The paper took too long to download." : err?.message;
    return { ok: false, error: message || "The paper could not be downloaded.", bytes: null };
  }
}

/**
 * PDF bytes → text *and* positioned runs, in one open of the document.
 *
 * The bytes are copied before they are parsed: the PDF engine takes ownership of
 * the buffer it is handed and detaches it, so measuring the caller's `bytes`
 * *after* this call reports a zero-length paper. (That is not a cosmetic detail —
 * it is what made the panel say "0 bytes" for a paper it had just read.)
 */
export async function extractPdfDocument(bytes) {
  const empty = { ok: false, pages: 0, text: "", pageTexts: [], items: [], error: "" };
  try {
    const copy = new Uint8Array(bytes);
    const doc = await getDocumentProxy(copy);
    const pages = Number(doc.numPages) || 0;

    // Text and positions are each optional once the document has opened: a paper
    // whose runs have no geometry can still be read as text, and vice versa.
    let pageTexts = [];
    try {
      const out = await extractText(doc, { mergePages: false });
      pageTexts = Array.isArray(out.text) ? out.text : [String(out.text || "")];
    } catch {
      pageTexts = [];
    }

    let items = [];
    try {
      const out = await extractTextItems(doc);
      items = (out.items || []).map((page) =>
        (page || [])
          .filter((it) => it && typeof it.str === "string" && it.str.trim())
          .map((it) => ({
            str: it.str,
            x: Number(it.x) || 0,
            y: Number(it.y) || 0,
            width: Number(it.width) || 0,
            height: Number(it.height) || 0,
            fontSize: Number(it.fontSize) || Number(it.height) || 10,
          }))
      );
    } catch {
      items = [];
    }

    return {
      ok: true,
      pages,
      text: pageTexts.join("\n"),
      pageTexts,
      items,
      error: "",
    };
  } catch (err) {
    return {
      ...empty,
      error:
        err?.message ||
        "This paper's text could not be read. It may be a scan rather than a text PDF.",
    };
  }
}

/** PDF bytes → plain text. Kept because it is the simplest thing to assert on. */
export async function extractPdfText(bytes) {
  const doc = await extractPdfDocument(bytes);
  if (!doc.ok) return { ok: false, text: "", pages: 0, error: doc.error };
  return { ok: true, text: doc.text, pages: doc.pages, error: "" };
}

/* --------------------------------------------------------------- the parse */

const BOILERPLATE =
  /^(master ncert|download|pw books|arjuna jee|physics by|chemistry by|maths by|mathematics by|jee\b.*dpp\s*\d*\s*$)/i;

/** Lines that are noise in every PW paper: image placeholders and rules. */
function isNoise(line) {
  if (!line) return true;
  if (/^\[image:\s*[^\]]*\]$/i.test(line)) return true;
  if (/^[-—=]{3,}$/.test(line)) return true;
  if (/^\$+$/.test(line)) return true;
  return false;
}

export function normaliseText(raw) {
  return String(raw || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => !isNoise(line));
}

/**
 * Split the paper into the questions section and the answer key.
 *
 * Two key formats ship, and both are read here:
 *
 *   · a list — `Q1 (B)` on its own line;
 *   · a table — `| Q1 | (B) | Q8 (D) |`, where the *number* and the *letter* are
 *     separate cells. That second one is the trap: a cell-wise read pairs the
 *     wrong marker with the wrong letter, so a row like `| Q6 | (A) | Q12 (B) |`
 *     turned into "6 is A" and then lost "12 is B" entirely. Each number is
 *     therefore matched to the nearest letter *after* it, across cells.
 */
export function splitKey(lines) {
  let keyAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^answer\s*key\b/i.test(lines[i]) || /\|?\s*answer key\s*\|/i.test(lines[i])) {
      keyAt = i;
      break;
    }
  }
  if (keyAt < 0) return { body: lines, key: new Map(), found: false, keyAt: -1 };

  const key = new Map();
  for (const line of lines.slice(keyAt)) {
    // Every number and every letter on the line, in the order printed.
    const tokens = [];
    for (const m of line.matchAll(/Q\s*(\d+)|\(([A-Da-d])\)|(?<=[\s|])([A-Da-d])(?=[\s|]|$)/g)) {
      if (m[1]) tokens.push({ kind: "n", value: Number(m[1]) });
      else tokens.push({ kind: "a", value: String(m[2] || m[3]).toUpperCase() });
    }
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].kind !== "n") continue;
      const after = tokens.slice(i + 1).find((t) => t.kind === "a");
      if (after) key.set(tokens[i].value, after.value);
    }
  }
  return { body: lines.slice(0, keyAt), key, found: true, keyAt };
}

/** Pull option markers out of one line: "(A) 6 cm (B) 6.5 cm (C) …". */
function optionsFromLine(line) {
  const out = [];
  const re = /\(([A-Ha-h])\)\s*([^()]*?)(?=\s*\([A-Ha-h]\)|$)/g;
  for (const m of line.matchAll(re)) {
    const text = m[2].replace(/\s+/g, " ").trim();
    out.push({ letter: m[1].toUpperCase(), text });
  }
  return out;
}

/**
 * Re-pair markers with the values printed underneath them.
 *
 * When a paper sets the letters in one row and the values in the next —
 *
 *     (A)        (B)        (C)        (D)
 *     9.98 m     9.980 m    9.9 m      9.9801 m
 *
 * — the plain-text reader sees two lines and every letter loses its value. This
 * joins them, but only when the pairing is unambiguous: markers with no text of
 * their own, followed by a line of values and *no* further markers.
 */
function recombineOptionLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const parsed = optionsFromLine(line);
    const bare = parsed.length > 0 && parsed.every((o) => !o.text);
    if (!bare) {
      out.push(line);
      continue;
    }
    const next = lines[i + 1] || "";
    const nextHasMarker = /\([A-Ha-h]\)/.test(next);
    if (!next || nextHasMarker) {
      out.push(line);
      continue;
    }
    if (parsed.length === 1) {
      // One marker per line: the value follows on the very next line.
      out.push(`(${parsed[0].letter}) ${next}`);
      i += 1;
      continue;
    }
    // Several markers on one line. The values are separated by runs of spaces in
    // the original layout; if that survived, use it, otherwise leave both lines
    // alone rather than guess which number belongs to which letter.
    const values = next.split(/\s{2,}/).map((v) => v.trim()).filter(Boolean);
    if (values.length === parsed.length) {
      out.push(parsed.map((o, n) => `(${o.letter}) ${values[n]}`).join("  "));
      i += 1;
      continue;
    }
    // Two columns, four values: the letters come in pairs. Pair the first
    // letter of each half with the value under it, which is how a two-column
    // paper actually reads.
    const perRow = parsed.length / 2;
    if (Number.isInteger(perRow) && values.length === parsed.length / 2) {
      out.push(parsed.map((o, n) => `(${o.letter}) ${values[n % values.length]}`).join("  "));
      i += 1;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Parse the extracted text into questions.
 *
 * Returns `questions` even when it understood little: `raw` keeps the passage
 * so the panel can always show the paper, and `textOnly` says the options were
 * not recovered. Never throws.
 */
export function parseDppPaper(rawText, { name = "" } = {}) {
  const lines = normaliseText(rawText);
  const { body, key, found: keyFound } = splitKey(lines);
  const segments = segmentQuestions(body);
  const questions = segments.map((segment) => {
    const repaired = recombineOptionLines(segment.lines);
    const options = [];
    const stemLines = [];
    for (const line of repaired) {
      const found = optionsFromLine(line);
      // A line is an option row only if it *starts* with a marker; otherwise the
      // parenthesised letters are part of the stem ("(A) and (B) are equal").
      if (found.length && /^\([A-Ha-h]\)/.test(line)) {
        for (const option of found) {
          if (!options.some((o) => o.letter === option.letter)) options.push(option);
        }
        continue;
      }
      stemLines.push(line);
    }
    return buildQuestion({
      number: segment.number,
      stem: stemLines.join(" "),
      options,
      answer: key.get(segment.number) || "",
      raw: segment.lines.join("\n"),
    });
  });

  return paperFrom(questions, { key, keyFound, name, header: headerOf(body), parser: "text" });
}

/* ------------------------------------------------------- positions, not text */

/** Join the runs of one visual line, keeping word breaks where they matter. */
function layoutLineText(items) {
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  let out = "";
  let prevEnd = null;
  for (const it of sorted) {
    const piece = String(it.str).replace(/\u00a0/g, " ");
    if (prevEnd !== null && out && !/\s$/.test(out) && !/^\s/.test(piece)) {
      // A gap wider than a quarter of the font size is a word break; anything
      // tighter is how PDF runs split a single word.
      const gap = it.x - prevEnd;
      if (gap > (it.fontSize || 10) * 0.24) out += " ";
    }
    out += piece;
    prevEnd = it.x + (it.width || 0);
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

/**
 * Group one page's runs into visual lines, top to bottom.
 *
 * Runs are bucketed by y; the bucket's text is rebuilt left to right. Reading
 * order in a PDF's content stream is not visual order, which is exactly why a
 * stream-based read scrambles a two-column option row.
 */
export function layoutLines(items) {
  const rows = [];
  const sorted = (items || [])
    .filter((it) => it && typeof it.str === "string" && it.str.trim())
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x);

  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= LINE_TOLERANCE) last.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  return rows
    .map((row) => ({ y: row.y, items: row.items, text: layoutLineText(row.items) }))
    .filter((row) => row.text && !isNoise(row.text));
}

const MARKER_ONLY = /^\(([A-Ha-h])\)$/;

/**
 * Decide which runs are option letters, and which runs are the values beside
 * them.
 *
 * A run is a marker when it is `(A)`..`(D)`, or starts with one and carries
 * nothing but a short value after it. A stem that happens to contain `(A) and
 * (B) are equal` is *not* a marker row: its inline text contains another marker,
 * which is the signal that this is prose.
 *
 * Values are then attributed to the nearest marker to their left on the same
 * visual line, so a two-column row pairs correctly, and a value printed one line
 * below its letter is still found.
 */
function optionRuns(items) {
  const marks = [];
  for (const it of items || []) {
    const text = String(it.str || "").replace(/\u00a0/g, " ").trim();
    if (!text) continue;
    const whole = text.match(MARKER_ONLY);
    const lead = whole ? null : text.match(/^\(([A-Ha-h])\)\s*(.+)$/);
    if (whole) {
      marks.push({ letter: whole[1].toUpperCase(), item: it, inline: "" });
      continue;
    }
    if (lead) {
      const inline = lead[2].trim();
      // `(A) and (B) are equal` is a sentence, not an option row.
      if (inline.length > 90 || /\([A-Ha-h]\)/.test(inline)) continue;
      marks.push({ letter: lead[1].toUpperCase(), item: it, inline });
    }
  }
  if (marks.length < 2) return { options: [], used: new Set() };

  const used = new Set();
  const byLetter = new Map();
  for (const mark of marks) {
    used.add(mark.item);
    if (mark.inline) pushValue(byLetter, mark.letter, mark.inline);
  }

  const lineOf = (it) => Math.max(LINE_TOLERANCE, (it.fontSize || 10) * 0.7);
  for (const it of items) {
    if (used.has(it)) continue;
    const text = String(it.str || "").replace(/\u00a0/g, " ").trim();
    if (!text) continue;

    let best = null;
    let bestGap = Infinity;
    for (const mark of marks) {
      const mi = mark.item;
      if (Math.abs(mi.y - it.y) > lineOf(it)) continue;
      const gap = it.x - (mi.x + (mi.width || 0));
      if (gap < -1) continue; // the marker sits to the right of this run
      if (gap < bestGap) {
        best = mark;
        bestGap = gap;
      }
    }
    if (best && bestGap <= MAX_OPTION_GAP) {
      used.add(it);
      pushValue(byLetter, best.letter, text);
    }
  }

  // A letter whose value was printed on the line below (a stacked layout) has no
  // same-line value yet. Take the nearest unclaimed run directly beneath it.
  const haveLetter = new Set([...byLetter.keys()]);
  const orphans = marks.filter((m) => !haveLetter.has(m.letter));
  if (orphans.length) {
    for (const mark of orphans) {
      let best = null;
      let bestDy = Infinity;
      for (const it of items) {
        if (used.has(it)) continue;
        const text = String(it.str || "").trim();
        if (!text) continue;
        const dy = mark.item.y - it.y; // below = smaller y
        if (dy <= 0 || dy > 40) continue;
        if (it.x < mark.item.x - 2) continue;
        if (dy < bestDy) {
          best = it;
          bestDy = dy;
        }
      }
      if (best) {
        used.add(best);
        pushValue(byLetter, mark.letter, String(best.str).trim());
      }
    }
  }

  const options = [...byLetter.entries()]
    .map(([letter, values]) => ({
      letter,
      text: values.join(" ").replace(/\s+/g, " ").trim(),
    }))
    .filter((o) => o.text)
    // `(A)` is not always the answer to be called "first": sort by the letters as
    // printed, which is what the paper's own key refers to.
    .sort((a, b) => orderOf(a.letter) - orderOf(b.letter));

  return { options, used };
}

const LETTERS = "ABCDEFGH".split("");
const orderOf = (letter) => {
  const at = LETTERS.indexOf(String(letter || "").toUpperCase());
  return at < 0 ? LETTERS.length : at;
};

function pushValue(map, letter, text) {
  const list = map.get(letter) || [];
  list.push(text);
  map.set(letter, list);
}

/**
 * Parse positioned runs into questions.
 *
 * Same contract as `parseDppPaper`, better reading. `items` is either one page's
 * runs or an array of pages.
 */
export function parseDppPaperFromItems(items, { name = "" } = {}) {
  const pages = Array.isArray(items) && Array.isArray(items[0]) ? items : [items || []];
  const lines = [];
  pages.forEach((pageItems, pageIndex) => {
    for (const line of layoutLines(pageItems)) lines.push({ ...line, page: pageIndex });
    // A page break ends the current question: a stem never continues across it.
    lines.push({ y: -1, items: [], text: "", page: pageIndex, gap: true });
  });

  const texts = lines.map((l) => l.text);
  const { key, found: keyFound, keyAt } = splitKey(texts);
  const end = keyAt < 0 ? lines.length : keyAt;

  const header = headerOf(texts.slice(0, firstQuestionAt(texts)));
  const segments = [];
  let current = null;

  for (let i = 0; i < end; i += 1) {
    const line = lines[i];
    if (!line.text) {
      if (current) current.lines.push(line);
      continue;
    }
    const marker = line.text.match(/^Q\s*(\d+)\s*[.):-]?\s*(.*)$/);
    if (marker) {
      if (current) segments.push(current);
      current = { number: Number(marker[1]), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) segments.push(current);

  const questions = segments.map((segment) => {
    const runs = segment.lines.flatMap((l) => l.items || []);
    const { options, used } = optionRuns(runs);
    // The stem is every run that belongs to no option — rebuilt per line so the
    // question's own wording keeps its line breaks and reading order.
    const stem = segment.lines
      .map((line) => {
        const keep = (line.items || []).filter((it) => !used.has(it));
        return keep.length ? layoutLineText(keep) : "";
      })
      .filter(Boolean)
      .join(" ")
      .replace(/^Q\s*\d+\s*[.):-]?\s*/, "")
      .replace(/\s+/g, " ")
      .trim();

    return buildQuestion({
      number: segment.number,
      stem,
      options,
      answer: key.get(segment.number) || "",
      raw: segment.lines.map((l) => l.text).filter(Boolean).join("\n"),
    });
  });

  return paperFrom(questions, { key, keyFound, name, header, parser: "layout" });
}

/* ------------------------------------------------------------------ shared */

/** Split the body at each `Q<number>` marker. */
function segmentQuestions(body) {
  const segments = [];
  let current = null;
  for (const line of body) {
    const marker = line.match(/^Q\s*(\d+)\s*[.):-]?\s*(.*)$/);
    if (marker) {
      if (current) segments.push(current);
      current = { number: Number(marker[1]), lines: marker[2] ? [marker[2]] : [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) segments.push(current);
  return segments;
}

function firstQuestionAt(texts) {
  const at = texts.findIndex((l) => /^Q\s*\d+\b/.test(l));
  return at < 0 ? 0 : at;
}

/** The paper's title and its time limit, from whatever precedes question 1. */
function headerOf(headerLines) {
  let duration = 0;
  for (const line of headerLines) {
    const m = line.match(/(\d{1,3})\s*(?:min|minutes)/i);
    if (m) {
      duration = Number(m[1]);
      break;
    }
  }
  return { duration, lines: headerLines };
}

function buildQuestion({ number, stem, options, answer, raw }) {
  const labelled = (options || [])
    .filter((o) => o && o.text)
    .map((o) => ({ letter: o.letter, text: String(o.text).replace(/\s+/g, " ").trim() }))
    // De-duplicate letters; a marker seen twice is the same option.
    .filter((o, i, arr) => arr.findIndex((x) => x.letter === o.letter) === i);
  const answerIndex = labelled.findIndex((o) => o.letter === answer);
  return {
    number,
    text: String(stem || "").replace(/\s+/g, " ").trim(),
    options: labelled,
    answer,
    answerIndex,
    // A question is only answerable if we have the key *and* at least two
    // readable options; otherwise the page shows it as text.
    textOnly: !answer || labelled.length < 2,
    raw: raw || "",
  };
}

function paperFrom(questions, { key, keyFound, name, header, parser }) {
  const headerTitle = (header?.lines || []).find(
    (l) => /dpp|practice|assignment/i.test(l) && l.length < 90
  );
  const answerable = questions.filter((q) => !q.textOnly).length;
  return {
    title: String(headerTitle || name || "DPP paper").replace(/^[|\s]+|[|\s]+$/g, ""),
    duration: Number(header?.duration) || 0,
    questions,
    answerKeyFound: keyFound,
    answerKey: Object.fromEntries([...key.entries()].sort((a, b) => a[0] - b[0])),
    parser,
    stats: {
      total: questions.length,
      answerable,
      withAnswer: questions.filter((q) => q.answer).length,
      // The number the panel shows when something went wrong with the layout.
      unreadable: questions.length - answerable,
    },
  };
}

/* -------------------------------------------------------------- the reading */

const CACHE_TTL = 30 * 60 * 1000;
const CACHE_MAX = 16;
/** `url → { at, doc, paper }`. A paper PDF never changes at its URL. */
const paperCache = new Map();

function cacheGet(url) {
  const hit = paperCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    paperCache.delete(url);
    return null;
  }
  // Refresh recency so a paper being practised stays warm.
  paperCache.delete(url);
  paperCache.set(url, hit);
  return hit;
}

function cacheSet(url, value) {
  if (paperCache.size >= CACHE_MAX) {
    const oldest = paperCache.keys().next().value;
    if (oldest !== undefined) paperCache.delete(oldest);
  }
  paperCache.set(url, { at: Date.now(), ...value });
}

/**
 * The whole thing: URL → parsed paper.
 *
 * `mediaBase` is this deployment's `/api/media` relay, used when the direct
 * fetch fails — PW's CDN sometimes refuses a bare server request but answers the
 * relay, which sends a browser-shaped one from the same region.
 *
 * Both readers run and the better one wins: `layout` (positions) normally, and
 * `text` when a PDF carries no usable geometry. `parser` says which answered.
 */
export async function readDppPaper({ url, name = "", mediaBase = "", fetchImpl = fetch } = {}) {
  const fail = (error) => ({
    ok: false,
    error,
    questions: [],
    stats: { total: 0, answerable: 0, withAnswer: 0, unreadable: 0 },
  });
  if (!url) return fail("No paper URL was given.");

  // Cached reads are only safe for the default fetcher: a test that injects one
  // is asking for *its* bytes, not whatever this process saw before.
  const cacheable = fetchImpl === fetch;
  if (cacheable) {
    const hit = cacheGet(url);
    if (hit) return { ...hit.paper, cached: true };
  }

  const direct = await fetchPaperBytes(url, { fetchImpl });
  let bytes = direct.bytes;
  let error = direct.error;

  if (!bytes && mediaBase) {
    const relayed = await fetchPaperBytes(
      `${mediaBase}${mediaBase.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}`,
      { fetchImpl }
    );
    if (relayed.bytes) {
      bytes = relayed.bytes;
    } else if (!error) {
      // Keep the *first* reason. The relay is a fallback, so its failure is the
      // less informative of the two: overwriting "the paper answered 404" with
      // the relay's "400" reports a diagnosis about our own proxy as if it were
      // the paper's fault.
      error = relayed.error;
    }
  }

  if (!bytes) return fail(error);

  const doc = await extractPdfDocument(bytes);
  if (!doc.ok) return fail(doc.error);

  // Read it both ways and keep the better answer.
  const fromText = parseDppPaper(doc.text, { name });
  const fromItems = doc.items.some((page) => page.length)
    ? parseDppPaperFromItems(doc.items, { name })
    : null;

  const best =
    fromItems && (fromItems.stats.answerable > fromText.stats.answerable ||
      (fromItems.stats.answerable === fromText.stats.answerable &&
        fromItems.stats.total >= fromText.stats.total))
      ? fromItems
      : fromText;

  const paper = {
    ok: best.questions.length > 0,
    error: best.questions.length
      ? ""
      : "The PDF opened but no questions were found in it. It is probably a scanned image.",
    url,
    pages: doc.pages,
    bytes: bytes.length,
    ...best,
  };

  if (cacheable) cacheSet(url, { paper });
  return paper;
}

/* --------------------------------------------------------------- the score */

const OUTCOME = {
  CORRECT: "correct",
  WRONG: "wrong",
  SKIPPED: "skipped",
  UNSCORED: "unscored",
};

/**
 * Mark a submitted test against the paper's own key.
 *
 * `answers` is keyed by question *index* (as sent by the runner, which is the
 * order the questions arrived in) unless `keyedBy: "number"` is passed, in which
 * case it is keyed by the paper's own question numbers. Values are option
 * letters. The two are never mixed, because for a paper numbered from 1 they
 * disagree about what "1" means. Anything the reader could not recover — no key, fewer than two
 * options — is reported as `unscored` rather than counted wrong: a student is
 * not penalised for our parse.
 */
export function scorePaper(paper, answers = {}, { elapsedMs = 0, keyedBy = "index" } = {}) {
  const questions = Array.isArray(paper?.questions) ? paper.questions : [];
  const rows = [];
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let unscored = 0;

  questions.forEach((question, index) => {
    // Keyed by position or by the paper's own numbering — never guessed between
    // the two: for a paper numbered from 1, question 1 and index 1 are different
    // questions, and a silent guess marks the wrong one.
    const raw =
      keyedBy === "number"
        ? answers?.[question.number] ?? answers?.[String(question.number)] ?? ""
        : answers?.[index] ?? answers?.[String(index)] ?? "";
    const chosen = String(raw || "").trim().toUpperCase().slice(0, 1);
    const basis = {
      number: question.number,
      index,
      text: question.text,
      options: question.options || [],
      answer: question.answer || "",
      chosen,
    };

    if (question.textOnly) {
      unscored += 1;
      rows.push({ ...basis, outcome: OUTCOME.UNSCORED });
      return;
    }
    if (!chosen) {
      skipped += 1;
      rows.push({ ...basis, outcome: OUTCOME.SKIPPED });
      return;
    }
    if (chosen === question.answer) {
      correct += 1;
      rows.push({ ...basis, outcome: OUTCOME.CORRECT });
      return;
    }
    wrong += 1;
    rows.push({ ...basis, outcome: OUTCOME.WRONG });
  });

  const scored = correct + wrong + skipped;
  const percent = scored ? Math.round((correct / scored) * 100) : 0;
  const marks = 4 * correct - (scored ? wrong : 0); // JEE-style +4 / −1, shown as advice only

  return {
    total: questions.length,
    scored,
    correct,
    wrong,
    skipped,
    unscored,
    percent,
    marks,
    elapsedMs: Math.max(0, Number(elapsedMs) || 0),
    verdict: verdictFor(percent, scored),
    focus: rows.filter((r) => r.outcome === OUTCOME.WRONG).map((r) => r.number),
    rows,
  };
}

function verdictFor(percent, scored) {
  if (!scored) return "Nothing to mark";
  if (percent >= 90) return "Excellent — nearly every answer landed";
  if (percent >= 75) return "Strong — a few to tighten";
  if (percent >= 50) return "Getting there — half the paper is solid";
  if (percent > 0) return "Needs work — go back over this chapter";
  return "Start again from the chapter notes";
}

/**
 * The pre-submit view of a paper: questions and options, *without* the key.
 *
 * This is what the student's browser receives. The answers stay on the server
 * until the test is submitted, so "view source" cannot reveal them — the same
 * reason `lib/dpp.mjs` refuses to hand out a locked quiz.
 */
export function testPayload(paper) {
  return {
    title: paper.title,
    duration: paper.duration,
    pages: paper.pages,
    stats: {
      total: paper.stats?.total ?? (paper.questions || []).length,
      answerable: paper.stats?.answerable ?? 0,
      unreadable: paper.stats?.unreadable ?? 0,
    },
    questions: (paper.questions || []).map((q) => ({
      number: q.number,
      text: q.text,
      options: q.options,
      // The runner needs to know which questions it may score, but not why.
      scorable: !q.textOnly,
    })),
  };
}

/* ------------------------------------------------------------ the paper list */

/**
 * Walk a subject's chapters (or one chapter) and flatten their DPP attachments
 * into a paper list.
 *
 * Chapters with no lectures can still carry DPPs, so only the ones the source
 * itself reports as completely empty are skipped.
 */
export async function collectDppPapers({
  batch,
  subject,
  wantedChapter = "",
  maxChapters = 12,
  fetchChapters,
  fetchChapterContents,
}) {
  const chaptersOut = await fetchChapters(batch, subject);
  if (!chaptersOut.ok) {
    return { ok: false, error: chaptersOut.error || "The chapter list could not be read.", papers: [] };
  }
  const all = chaptersOut.chapters || [];
  const withVideos = all.filter((c) => (Number(c.videos) || 0) > 0 || (Number(c.notes) || 0) > 0);
  const pool = wantedChapter
    ? all.filter((c) => c.id === wantedChapter)
    : withVideos.length
      ? withVideos
      : all;

  const chosen = pool.slice(0, maxChapters);
  const papers = [];
  const notes = [];

  for (const chapter of chosen) {
    try {
      const out = await fetchChapterContents(batch, subject, chapter.id, "DppNotes");
      if (!out.ok) {
        notes.push(`${chapter.name}: ${out.error}`);
        continue;
      }
      for (const item of out.items || []) {
        for (const doc of item.docs || []) {
          if (!doc.url) continue;
          papers.push({
            id: doc.pdfId || item.id,
            title: (doc.topic || item.title || doc.name || "DPP").trim(),
            file: doc.name || "",
            url: doc.url,
            date: item.date || "",
            chapter: chapter.name,
            chapterId: chapter.id,
            attachmentId: doc.attachmentId || "",
            pdfId: doc.pdfId || "",
          });
        }
      }
    } catch (err) {
      notes.push(`${chapter.name}: ${err?.message || "could not be read"}`);
    }
  }

  // Newest first, but keep the chapter grouping visible by sorting on date.
  papers.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return {
    ok: true,
    papers,
    notes,
    total: pool.length,
    scanned: chosen.length,
    truncated: pool.length > chosen.length,
  };
}

/** For tests and callers that want a clean slate. */
export function clearPaperCache() {
  paperCache.clear();
}
