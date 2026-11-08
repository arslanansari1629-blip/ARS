/* Shared local library helpers — recent batches, watch history, downloads */

const KEY = "eduvibe.library";

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function write(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function getLibrary() {
  const lib = read();
  return {
    batches: lib.batches || [],
    lectures: lib.lectures || [],
    docs: lib.docs || [],
  };
}

export function trackBatch(batch) {
  if (!batch || !batch.id) return;
  const lib = read();
  const batches = (lib.batches || []).filter((b) => b.id !== batch.id);
  batches.unshift({ ...batch, at: Date.now() });
  write({ ...lib, batches: batches.slice(0, 24) });
}

export function trackLecture(lecture) {
  if (!lecture || !lecture.id) return;
  const lib = read();
  const lectures = (lib.lectures || []).filter((l) => l.id !== lecture.id);
  lectures.unshift({ ...lecture, at: Date.now() });
  write({ ...lib, lectures: lectures.slice(0, 30) });
}

export function trackDoc(doc) {
  if (!doc || !doc.url) return;
  const lib = read();
  const docs = (lib.docs || []).filter((d) => d.url !== doc.url);
  docs.unshift({ ...doc, at: Date.now() });
  write({ ...lib, docs: docs.slice(0, 40) });
}

export function clearLibrary() {
  write({});
}
