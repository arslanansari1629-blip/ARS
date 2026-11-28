/**
 * Selection Way (STUDY HULK {SW}) — TEST-MODE platform client.
 *
 * Built on the operator's instruction: everything comes from
 * https://swstudyhulk.edgeone.dev (a Base44 app) starting from the
 * batch `6a8d695d6a1aff889c4dccf2`. The platform stays in test mode
 * (unlinked, landing card remains Coming Soon) until the operator
 * says "live". This module begins with the confined raw/probe views
 * used to map the upstream honestly; the catalogue views grow on
 * top of whatever the probes prove.
 */

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

export const SW_APP_ID = "6abcc36739e6600c007def69";
export const SW_SITE = "https://swstudyhulk.edgeone.dev";
export const SW_SAMPLE_BATCH = "6a8d695d6a1aff889c4dccf2";

const RAW_ORIGINS = ["https://swstudyhulk.edgeone.dev", "https://app.base44.com", "https://base44.app"];

async function swFetch(url, { method = "GET" } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "User-Agent": UA, Accept: "text/html,application/json,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, type: res.headers.get("content-type") || "", text, url: res.url };
}

/**
 * Raw read, confined to the Selection Way upstreams: the discovery
 * tool the platform is mapped with. `find=` returns the window
 * around a keyword so one call can reach inside a big bundle.
 */
export async function swRaw(params) {
  const path = String(params.path || "/");
  let url;
  try {
    url = new URL(path, `${SW_SITE}/`);
  } catch {
    return { success: false, error: "bad path" };
  }
  if (!RAW_ORIGINS.includes(url.origin)) {
    return { success: false, error: "raw reads stay on the Selection Way upstreams" };
  }
  const got = await swFetch(url.toString()).catch((e) => ({ status: 0, type: "", text: "", url: String(url), error: String(e?.message || e) }));
  const find = String(params.find || "");
  const at = Math.max(0, Number(params.at) || 0);
  let snippet = at ? got.text.slice(at, at + 6000) : got.text.slice(0, 6000);
  if (find) {
    const at = got.text.toLowerCase().indexOf(find.toLowerCase());
    snippet = at >= 0 ? got.text.slice(Math.max(0, at - 400), at + 5600) : `(not found: ${find}) ` + snippet;
  }
  const scripts = [...got.text.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]).slice(0, 30);
  let hits;
  if (find && params.all) {
    hits = [];
    const hay = got.text.toLowerCase();
    const needle = find.toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0 && hits.length < 80; i = hay.indexOf(needle, i + 1)) hits.push(i);
  }
  return {
    success: got.status > 0,
    status: got.status,
    type: got.type,
    length: got.text.length,
    url: got.url,
    scripts,
    snippet,
    ...(hits ? { hits } : {}),
    ...(got.error ? { error: got.error } : {}),
  };
}

/** Map the Base44 surface: candidate entity endpoints, both hosts/styles. */
export async function swProbe() {
  const home = await swRaw({ path: "/" });
  const names = ["Course", "Batch", "Class", "Lecture", "Video", "Note", "Notes", "Subject", "Chapter", "Banner"];
  const tries = [];
  for (const host of ["https://app.base44.com", "https://base44.app"]) {
    for (const style of ["entities", "entities-v2"]) {
      for (const name of names.slice(0, 4)) {
        const u = style === "entities"
          ? `${host}/api/apps/${SW_APP_ID}/entities/${name}`
          : `${host}/api/apps/${SW_APP_ID}/entities/${name}/v2/list`;
        const got = await swFetch(u).catch((e) => ({ status: 0, text: "", error: String(e?.message || e) }));
        tries.push({ url: u, status: got.status, sample: got.text.slice(0, 220) });
      }
    }
    break; // first host pass is enough to learn the shape; extend once we see it
  }
  return {
    success: true,
    appId: SW_APP_ID,
    site: SW_SITE,
    sampleBatch: SW_SAMPLE_BATCH,
    home: { status: home.status, length: home.length, scripts: home.scripts, snippet: (home.snippet || "").slice(0, 800) },
    tries,
  };
}

export async function selectionWayApi(req, res, params) {
  const send = (status, payload) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify(payload));
  };
  const view = String(params.view || "probe");
  try {
    if (view === "probe") return send(200, await swProbe());
    if (view === "raw") return send(200, await swRaw(params));
    return send(400, { success: false, error: `unknown Selection Way view: ${view}` });
  } catch (err) {
    return send(502, { success: false, error: String(err?.message || err).slice(0, 200) });
  }
}
