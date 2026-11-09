/* Data access layer: server API first, live browser relay fallback second. */

import { upstream, normalizeCatalog, normalizeSearch, normalizeBatch, normalizeChapters, normalizeContents, normalizeAnnouncements, normalizeSchedule, UPSTREAM } from "./client-api.js";

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!data) throw new Error(`Empty response (${res.status})`);
  if (data.success === false && !data.needsProxy) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Run a server route; if the server cannot reach the upstream API (blocked
 * network / datacenter IP), fetch the same JSON in the browser and normalise.
 */
async function fetchData(serverPath, upstreamPath, normalizer) {
  let serverError = null;
  try {
    const data = await getJson(serverPath);
    if (!data.needsProxy) return data;

    // An auth refusal is final. The browser relay presents the same guest
    // credential the server just presented, so it will be refused in exactly the
    // same way — retrying it wastes a round trip and, worse, turns a clear
    // "PW will not serve this to guests" into a vague relay error.
    if (data.auth) {
      const err = new Error(data.reason || "Physics Wallah is not serving this to guests right now.");
      err.auth = true;
      throw err;
    }
  } catch (err) {
    serverError = err;
  }

  const json = await upstream(upstreamPath);
  const out = normalizer(json);
  return out;
}

export async function loadCatalog(page = 1) {
  return fetchData(
    `/api/batches?page=${page}`,
    `/AllBatches?page=${page}`,
    (json) => normalizeCatalog(json, page)
  );
}

export async function searchBatches(term) {
  return fetchData(
    `/api/batches?search=${encodeURIComponent(term)}`,
    `/searchBatch?name=${encodeURIComponent(term)}`,
    (json) => normalizeSearch(json)
  );
}

export async function loadBatch(id) {
  return fetchData(
    `/api/batch?id=${encodeURIComponent(id)}`,
    `/BatchInfo?BatchId=${encodeURIComponent(id)}&Type=details`,
    (json) => normalizeBatch(json, id)
  );
}

/**
 * Header-only variant of `loadBatch`: the shipped catalogue row, no upstream
 * call. The batch page paints its hero from this and then asks for the full
 * record, so a slow `/BatchInfo` costs the subject list — not the whole page.
 */
export async function loadBatchHeader(id) {
  try {
    const data = await getJson(`/api/batch?header=1&id=${encodeURIComponent(id)}`);
    if (data && data.batch && Array.isArray(data.batch.subjects) === false) {
      return { batch: { ...data.batch, subjects: [] }, headerOnly: true };
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadChapters(batch, subject) {
  return fetchData(
    `/api/contents?batch=${encodeURIComponent(batch)}&subject=${encodeURIComponent(subject)}`,
    `/SubjectInfo?BatchId=${encodeURIComponent(batch)}&SubjectId=${encodeURIComponent(subject)}&page=1`,
    (json) => normalizeChapters(json)
  );
}

export async function loadContents(batch, subject, topic, type) {
  return fetchData(
    `/api/contents?batch=${encodeURIComponent(batch)}&subject=${encodeURIComponent(subject)}&topic=${encodeURIComponent(topic)}&type=${encodeURIComponent(type)}`,
    `/TopicInfo?BatchId=${encodeURIComponent(batch)}&SubjectId=${encodeURIComponent(subject)}&TopicId=${encodeURIComponent(topic)}&ContentType=${encodeURIComponent(type)}&page=1`,
    (json) => normalizeContents(json, type)
  );
}

export async function loadAnnouncements(batch) {
  return fetchData(
    `/api/lecture?batch=${encodeURIComponent(batch)}&announcements=1`,
    `/BatchInfo?BatchId=${encodeURIComponent(batch)}&Type=announcement&page=1`,
    (json) => normalizeAnnouncements(json)
  );
}

export async function loadLecture(batch, subject, id) {
  return fetchData(
    `/api/lecture?batch=${encodeURIComponent(batch)}&subject=${encodeURIComponent(subject)}&id=${encodeURIComponent(id)}`,
    `/Schedule?BatchId=${encodeURIComponent(batch)}&SubjectId=${encodeURIComponent(subject)}&ContentId=${encodeURIComponent(id)}`,
    (json) => normalizeSchedule(json, id)
  );
}

export { UPSTREAM };
