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

/**
 * Query string for the catalogue filters.
 *
 * These are sent to the server, not applied here: the catalogue is 14,201 rows
 * over 711 pages, and filtering the twenty already on screen is not filtering.
 * An empty value is omitted so the routes keep their cacheable default shape.
 */
function catalogQuery({ page = 1, term = "", lang = "", price = "", sort = "" } = {}) {
  const qs = new URLSearchParams();
  if (term) qs.set("search", term);
  if (lang) qs.set("lang", lang);
  if (price && price !== "all") qs.set("price", price);
  if (sort && sort !== "default") qs.set("sort", sort);
  if (page && page !== 1) qs.set("page", String(page));
  return qs.toString();
}

export async function loadCatalog(page = 1, filters = {}) {
  const query = catalogQuery({ ...filters, page });
  const search = filters.term || filters.lang || (filters.price && filters.price !== "all");
  return fetchData(
    `/api/batches${query ? `?${query}` : ""}`,
    `/AllBatches?page=${page}`,
    // A filtered listing comes back in the search shape (one page of best hits),
    // so it must be normalised the same way or the pager loses its totals.
    (json) => (search ? normalizeSearch(json, page) : normalizeCatalog(json, page))
  );
}

export async function searchBatches(term, filters = {}) {
  const query = catalogQuery({ ...filters, term });
  return fetchData(
    `/api/batches?${query}`,
    `/searchBatch?name=${encodeURIComponent(term)}`,
    (json) => normalizeSearch(json)
  );
}

/** Languages and price counts for the filter controls. */
export async function loadFacets() {
  const data = await getJson("/api/batches?facets=1");
  return {
    languages: Array.isArray(data.languages) ? data.languages : [],
    prices: data.prices || { free: 0, paid: 0, total: 0 },
  };
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
