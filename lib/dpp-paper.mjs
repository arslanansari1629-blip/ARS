/**
 * DPP papers, as text.
 *
 * The interactive DPP quiz behind Physics Wallah's test service needs a paid
 * student token, which this site does not have and cannot mint. The *paper*
 * does not: every DPP PDF is guest-readable on static.pw.live, and it contains
 * the questions, the options and the answer key.
 *
 * So this module reads the PDF and turns it into a question list. The layout is
 * hostile — inline maths lands on its own line, images appear as `[Image: X12]`,
 * and the key is sometimes a table and sometimes a list — so the parser is
 * deliberately forgiving and *reports what it could not read* rather than
 * inventing it. A question whose options could not be recovered is still shown,
 * with its answer, and marked `textOnly`.
 */

import { extractText, getDocumentProxy } from "unpdf";

/** Paper PDFs are a few hundred KB; anything past this is not a DPP. */
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
 * PDF bytes → plain text, one page per line group.
 *
 * The bytes are copied before they are parsed: the PDF engine takes ownership of
 * the buffer it is handed and detaches it, so measuring the caller's `bytes`
 * *after* this call reports a zero-length paper. (That is not a cosmetic detail —
 * it is what made the panel say "0 bytes" for a paper it had just read.)
 */
export async function extractPdfText(bytes) {
  try {
    const copy = new Uint8Array(bytes);
    const doc = await getDocumentProxy(copy);
    const { text, totalPages } = await extractText(doc, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { ok: true, text: pages.join("\n"), pages: totalPages, error: "" };
  } catch (err) {
    return {
      ok: false,
      text: "",
      pages: 0,
      error:
        err?.message ||
        "This paper's text could not be read. It may be a scan rather than a text PDF.",
    };
  }
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
 * Two key formats ship: a list (`Q1 (B)` on its own line) and a table
 * (`| Q1 | (B) | Q8 (D) |`). Both are read here.
 */
export function splitKey(lines) {
  let keyAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^answer\s*key\b/i.test(lines[i]) || /\|?\s*answer key\s*\|/i.test(lines[i])) {
      keyAt = i;
      break;
    }
  }
  if (keyAt < 0) return { body: lines, key: new Map(), found: false };

  const key = new Map();
  for (const line of lines.slice(keyAt)) {
    // Table rows: "| Q1 | (B) | Q8 (D) |" — take every pair on the line.
    for (const m of line.matchAll(/Q\s*(\d+)\s*\|?\s*\(?([A-Da-d])\)?/g)) {
      key.set(Number(m[1]), m[2].toUpperCase());
    }
    // Plain list rows: "Q1 (B)" or "Q1 B".
    for (const m of line.matchAll(/^Q\s*(\d+)\s*[.):-]?\s*\(?([A-Da-d])\)?$/g)) {
      key.set(Number(m[1]), m[2].toUpperCase());
    }
  }
  return { body: lines.slice(0, keyAt), key, found: true };
}

/** Pull option markers out of one line: "(A) 6 cm (B) 6.5 cm (C) …". */
function optionsFromLine(line) {
  const out = [];
  const re = /\(([A-Da-d])\)\s*([^()]*?)(?=\s*\([A-Da-d]\)|$)/g;
  for (const m of line.matchAll(re)) {
    const text = m[2].replace(/\s+/g, " ").trim();
    out.push({ letter: m[1].toUpperCase(), text });
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

  // Header: the paper's own title and its time limit, before the first Q.
  const firstQ = body.findIndex((l) => /^Q\s*\d+\b/.test(l));
  const header = firstQ > 0 ? body.slice(0, firstQ) : [];
  const duration = (() => {
    for (const line of header) {
      const m = line.match(/(\d{1,3})\s*(?:min|minutes)/i);
      if (m) return Number(m[1]);
    }
    return 0;
  })();
  const title =
    header.find((l) => /dpp|practice|assignment/i.test(l) && l.length < 90) || name || "DPP paper";

  // Body from the first Q onward, split on the question markers.
  const source = firstQ >= 0 ? body.slice(firstQ) : body;
  const segments = [];
  let current = null;
  for (const line of source) {
    const marker = line.match(/^Q\s*(\d+)\s*[.):-]?\s*(.*)$/);
    if (marker) {
      if (current) segments.push(current);
      current = { number: Number(marker[1]), lines: marker[2] ? [marker[2]] : [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) segments.push(current);

  const questions = segments.map((segment) => {
    const options = [];
    const stemLines = [];
    for (const line of segment.lines) {
      const found = optionsFromLine(line);
      // A line is an option row only if it *starts* with a marker; otherwise the
      // parenthesised letters are part of the stem ("(A) and (B) are equal").
      if (found.length && /^\([A-Da-d]\)/.test(line)) {
        for (const option of found) {
          if (!options.some((o) => o.letter === option.letter)) options.push(option);
        }
        continue;
      }
      stemLines.push(line);
    }

    const answer = key.get(segment.number) || "";
    const labelled = options
      .filter((o) => o.text)
      .map((o) => ({ letter: o.letter, text: o.text }));
    const answerIndex = labelled.findIndex((o) => o.letter === answer);

    return {
      number: segment.number,
      text: stemLines.join(" ").replace(/\s+/g, " ").trim(),
      options: labelled,
      answer,
      answerIndex,
      // A question is only answerable if we have the key *and* at least two
      // readable options; otherwise the panel shows it as text.
      textOnly: !answer || labelled.length < 2,
      raw: segment.lines.join("\n"),
    };
  });

  const answerable = questions.filter((q) => !q.textOnly).length;
  return {
    title: title.replace(/^[|\s]+|[|\s]+$/g, ""),
    duration,
    questions,
    answerKeyFound: keyFound,
    answerKey: Object.fromEntries([...key.entries()].sort((a, b) => a[0] - b[0])),
    stats: {
      total: questions.length,
      answerable,
      withAnswer: questions.filter((q) => q.answer).length,
      // The number the panel shows when something went wrong with the layout.
      unreadable: questions.length - answerable,
    },
  };
}

/**
 * The whole thing: URL → parsed paper.
 *
 * `mediaBase` is this deployment's `/api/media` relay, used when the direct
 * fetch fails — PW's CDN sometimes refuses a bare server request but answers the
 * relay, which sends a browser-shaped one from the same region.
 */
export async function readDppPaper({ url, name = "", mediaBase = "", fetchImpl = fetch } = {}) {
  const direct = await fetchPaperBytes(url, { fetchImpl });
  let bytes = direct.bytes;
  let error = direct.error;

  if (!bytes && mediaBase) {
    const relayed = await fetchPaperBytes(
      `${mediaBase}${mediaBase.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}`,
      { fetchImpl }
    );
    if (relayed.bytes) bytes = relayed.bytes;
    else error = relayed.error || error;
  }

  if (!bytes) return { ok: false, error, questions: [], stats: { total: 0, answerable: 0 } };

  const text = await extractPdfText(bytes);
  if (!text.ok) return { ok: false, error: text.error, questions: [], stats: { total: 0, answerable: 0 } };

  const paper = parseDppPaper(text.text, { name });
  return {
    ok: paper.questions.length > 0,
    error: paper.questions.length
      ? ""
      : "The PDF opened but no questions were found in it. It is probably a scanned image.",
    url,
    pages: text.pages,
    bytes: bytes.length,
    ...paper,
  };
}
