/**
 * Language names, normalised.
 *
 * The upstream catalogue is inconsistent about language labels in three ways that
 * each became a visible bug:
 *
 *   1. One language is spelled two ways — "Assamese" and "ASSAMESE" — which made
 *      the filter offer the same language twice and split its batches in half.
 *   2. Two are misspelled — "Gujrati" and "Bangla" — so the dropdown said
 *      "Gujarati" while the card beside it said "Gujrati".
 *   3. Common alternate spellings ("Oriya", "Bengali") appear in what people type
 *      into a search box, not necessarily in the data.
 *
 * Everything that groups, filters, labels or displays a language goes through this
 * file, so all four surfaces agree by construction. It lives on its own because
 * both the upstream normaliser and the catalogue index need it, and importing one
 * from the other would be a cycle.
 */

/** Spelling variants → one key. */
const ALIASES = {
  gujrati: "gujarati",
  gujarati: "gujarati",
  bangla: "bengali",
  bengali: "bengali",
  oriya: "odia",
  odia: "odia",
};

/** The spelling we show, for keys the source gets wrong or shouts. */
const DISPLAY = {
  gujarati: "Gujarati",
  bengali: "Bengali",
  odia: "Odia",
  assamese: "Assamese",
};

/** A stable grouping key: lowercased, alias-resolved. */
export function languageKey(value) {
  const k = String(value || "").trim().toLowerCase();
  return ALIASES[k] || k;
}

/** The label to show a reader. */
export function displayLanguage(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = languageKey(raw);
  if (DISPLAY[key]) return DISPLAY[key];
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}
