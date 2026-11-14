import { cors, json, query } from "../lib/http.mjs";
import { maintenanceGate } from "../lib/maintenance.mjs";
import { board, publish } from "../lib/leaderboard.mjs";
import {
  resolveToken,
  pwHeaders,
  tokenState,
  TOKEN_SOURCES,
  FALLBACK_TOKEN,
} from "../lib/pw-auth.mjs";
import { pwFetch } from "../lib/pw-proxy.mjs";
import { fetchSchedule, resolveStream, parseFolder } from "../lib/api-data.mjs";

/**
 * GET /api/token         → token state + which hosts accept it
 * GET /api/token?fresh=1 → re-mint first
 *
 * Answers "why is a lecture 401" without guessing: it shows which token is in
 * use, where it came from, and then actually spends it against the hosts the
 * lecture API needs (the API itself, and the two signer relays that turn a
 * video folder into a signed playlist).
 *
 * The token value is never echoed in full — a redacted prefix is enough to
 * tell two tokens apart, and this route is reachable from a browser.
 */

const PROBES = [
  {
    name: "pw-api",
    url: "https://api.penpencil.co/v3/batches/698ad3519549b300a5e1cc6a/details",
    mode: "header",
  },
  {
    name: "vidcloud-signer",
    url: "https://vidcloud.eu.org/api/v1/videos/get-hls-key?videoKey=bef5b6ef-800a-4d57-ac4d-bd188e2a7aad&key=enc.key",
    mode: "header",
    binary: true,
  },
  {
    name: "studyspark-signer",
    url: "https://api.studyspark.study/api/penpencil/v1/videos/get-hls-key?videoKey=bef5b6ef-800a-4d57-ac4d-bd188e2a7aad&key=enc.key",
    mode: "header",
    binary: true,
  },
];

/**
 * `tokenState()` carries the live token; this route is reachable from a browser,
 * so only its shape leaves the server. (The state block used to ship the full
 * bearer, which defeated the redaction one line above it.)
 */
function redactState(state) {
  return {
    source: state.source,
    expiresIn: state.expiresIn,
    prefix: redact(state.token),
  };
}

function redact(token) {
  if (!token) return "";
  if (token.length < 14) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)`;
}

async function probe(probe) {
  const started = Date.now();
  try {
    const res = await fetch(probe.url, {
      headers: pwHeaders(probe.token),
      signal: AbortSignal.timeout(9000),
      redirect: "follow",
      cache: "no-store",
    });
    const entry = {
      host: probe.name,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - started,
    };
    if (probe.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      entry.bytes = buf.length;
      // An AES-128 key is exactly 16 bytes; anything else is an error page.
      if (res.ok) entry.looksLikeKey = buf.length === 16;
    } else {
      const text = await res.text();
      entry.looksLikeJson = text.trim().startsWith("{");
      if (!res.ok) entry.body = text.slice(0, 200);
    }
    return entry;
  } catch (err) {
    return {
      host: probe.name,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err?.name === "TimeoutError" ? "timed out" : err?.message || "unreachable",
    };
  }
}

/**
 * Ask the API whether the current token actually gets stream URLs.
 *
 * Every failure message about lectures depends on this distinction: signing
 * works fine with a guest token, but the schedule record only includes
 * `videoDetails.videoUrl` for a token that holds the batch. Without this split,
 * "the API refuses the token" and "this token sees no videos" look identical.
 */
async function probeEntitlement(token) {
  const BATCH = "698ad3519549b300a5e1cc6a";
  const SUBJECT = "6a6b44faf834f38ed6f9120d";
  const listing = `/v2/batches/${BATCH}/subject/${SUBJECT}/contents?page=1&contentType=videos`;
  try {
    // Step 1: can we list lectures at all?
    const res = await pwFetch(listing, { headers: pwHeaders(token), timeout: 12000 });
    if (!res.ok) {
      return {
        checked: true,
        status: res.status,
        lectures: 0,
        withVideoUrl: 0,
        error: `upstream ${res.status}`,
      };
    }
    const body = await res.json();
    const items = Array.isArray(body.data) ? body.data : [];
    const first = items[0] || {};

    // Step 2: can we see a *stream*? The listing never carries one — the stream
    // URL lives on the schedule record — so asking only the listing reported
    // "metadata-only" for lectures that play perfectly well.
    const res2 = first._id ? await fetchSchedule(BATCH, SUBJECT, first._id) : null;
    const videoUrl = (res2 && res2.ok && res2.lecture && res2.lecture.videoUrl) || "";
    const forTitle = (res2 && res2.ok && res2.lecture && res2.lecture.title) || first.topic || "";

    return {
      checked: true,
      status: res.status,
      lectures: items.length,
      withVideoUrl: videoUrl ? 1 : 0,
      sampleTitle: forTitle || "no lecture visible",
      sampleVideoUrl: videoUrl,
      scheduleError: (res2 && res2.ok) || !res2 ? "" : res2.error || "schedule unavailable",
    };
  } catch (err) {
    return { checked: true, error: err?.message || "probe failed", lectures: 0, withVideoUrl: 0 };
  }
}

/**
 * Follow a lecture all the way to a playable byte.
 *
 * `lecturePlayback: "working"` used to mean only "the schedule named a stream
 * URL" — which was true while every lecture was unplayable, because the master
 * playlist the plan pointed at did not exist. A status page that cannot tell
 * the difference is worse than none, so this walks the real chain: resolve the
 * plan, read the master it hands the player, read one rendition playlist, and
 * fetch one segment. The first step that fails is named.
 */
export async function probePlayback(videoUrl) {
  if (!videoUrl) return { ok: false, step: "resolve", reason: "no stream URL to resolve" };
  const steps = [];
  try {
    const plan = await resolveStream({ rawUrl: videoUrl, folder: parseFolder(videoUrl), fresh: true });
    steps.push({ step: "plan", ok: Boolean(plan && plan.playable), detail: plan && plan.url ? plan.url : plan && plan.reason });
    if (!plan || !plan.playable || !plan.url) {
      return { ok: false, step: "plan", reason: (plan && plan.reason) || "no playable plan", steps };
    }

    // The plan URL is relative to this deployment; "this deployment" is an
    // origin we cannot assume is reachable from inside the function, so build
    // the same request against the same handlers directly.
    const { default: signRelay } = await import("../lib/sign.mjs");
    const grab = (path) =>
      new Promise((resolve) => {
        const chunks = [];
        const res2 = {
          statusCode: 0,
          setHeader() {},
          write(b) {
            chunks.push(Buffer.from(b));
          },
          end(b) {
            if (b) chunks.push(Buffer.from(b));
            resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
          },
        };
        signRelay({ method: "GET", url: path, headers: { host: "probe.local" } }, res2);
      });

    const master = await grab(plan.url);
    const isRealMaster = master.status === 200 && /#EXTM3U/.test(master.body) && /EXT-X-STREAM-INF/.test(master.body);
    steps.push({ step: "master", ok: isRealMaster, status: master.status });
    if (!isRealMaster) return { ok: false, step: "master", reason: `master answered ${master.status}`, steps };

    const variant = master.body.split("\n").find((l) => l && !l.startsWith("#")) || "";
    const variantPath = variant
      ? `${new URL(variant, "http://probe.local").pathname}${new URL(variant, "http://probe.local").search}`
      : "";
    const media = variantPath ? await grab(variantPath) : { status: 0, body: "" };
    const isRealMedia = media.status === 200 && /#EXTINF/.test(media.body);
    steps.push({ step: "rendition", ok: isRealMedia, status: media.status });
    if (!isRealMedia) return { ok: false, step: "rendition", reason: `rendition answered ${media.status}`, steps };

    const segment = media.body.split("\n").find((l) => l && !l.startsWith("#")) || "";
    const segPath = segment
      ? `${new URL(segment, "http://probe.local").pathname}${new URL(segment, "http://probe.local").search}`
      : "";
    const bytes = segPath ? await grab(segPath) : { status: 0, body: "" };
    const hasBytes = bytes.status === 200 && bytes.body.length > 1000;
    steps.push({ step: "segment", ok: hasBytes, status: bytes.status, bytes: bytes.body.length });
    return hasBytes
      ? { ok: true, step: "segment", steps, renditions: plan.renditions || [] }
      : { ok: false, step: "segment", reason: `segment answered ${bytes.status}`, steps };
  } catch (err) {
    return { ok: false, step: "error", reason: err?.message || "probe failed", steps };
  }
}

/**
 * GET  /api/token?route=board[&me=<browser id>&limit=50]  → the XP leaderboard
 * POST /api/token?route=board                            → publish one row
 *
 * The leaderboard lives here for the same reason the DPP test lives on the PDF
 * route: a deployment may carry only twelve serverless functions and this one is
 * the site's small utility route. `route=board` is explicit, so nothing that
 * already asks for the token state can land here by accident.
 *
 * Why the board is server-side at all, when XP itself is not: points can be a
 * local record, but a *ranking* cannot. Two phones in one classroom have to see
 * the same rows, and a row that a browser can write unchecked is not a board —
 * hence lib/leaderboard.mjs, which validates and caps every write and says
 * plainly whether it is backed by storage or by one instance's memory.
 */
async function leaderboardRoute(req, res) {
  const params = query(req);

  if (req.method === "GET") {
    const out = await board({
      me: String(params.me || "").slice(0, 64),
      limit: Number(params.limit) || 50,
    });
    // A board is read on every dashboard visit and changes slowly; a short
    // shared cache is enough to keep it off the function's critical path.
    return json(res, 200, out, 15);
  }

  if (req.method === "POST") {
    const payload = await readJson(req);
    if (!payload || typeof payload !== "object") {
      return json(res, 400, { success: false, error: "A JSON body is required." });
    }
    const out = await publish(payload);
    return json(res, out.success ? 200 : 400, out);
  }

  res.setHeader("Allow", "GET, POST, OPTIONS");
  return json(res, 405, { success: false, error: "Method not allowed" });
}

/**
 * A bounded JSON body read.
 *
 * Vercel may hand the body over already parsed; the dev server streams it. Both
 * are handled, and the size is capped because this route is reachable by anyone
 * and a row is a few hundred bytes.
 */
async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  const raw = await new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024) {
        finish();
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", finish);
    req.on("error", finish);
    setTimeout(finish, 4000);
  });
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (await maintenanceGate(req, res)) return;

  const { route } = query(req);
  if (route === "board") return leaderboardRoute(req, res);

  if (req.method !== "GET") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const { fresh } = query(req);
  const { token, source, cached } = await resolveToken(fresh === "1");

  const probes = await Promise.all(PROBES.map((p) => probe({ ...p, token })));

  const signingWorks = probes
    .filter((p) => p.host !== "pw-api")
    .some((p) => p.ok && (p.looksLikeKey || p.bytes === 16));

  // Signing and entitlement are two different questions, and conflating them is
  // what made "no video" so hard to read. A guest token can sign any folder it
  // is told about — it just never gets told which folder, because the schedule
  // record only carries a `videoUrl` for tokens that hold the batch. So ask the
  // catalogue directly: do the lectures in a live batch carry a stream URL?
  const sample = await probeEntitlement(token);
  // …and then, for real, can a lecture be played? This is the only question a
  // viewer cares about, so the answer comes from actually fetching the bytes.
  const playback = sample.withVideoUrl ? await probePlayback(sample.sampleVideoUrl) : { ok: false, step: "resolve", reason: "no stream URL" };

  return json(
    res,
    200,
    {
      success: true,
      token: {
        value: redact(token),
        source,
        cached,
        state: redactState(tokenState()),
        isBuiltInFallback: token === FALLBACK_TOKEN,
        sources: TOKEN_SOURCES,
        pinnedByEnv: source.startsWith("env:"),
      },
      probes,
      entitlement: sample,
      // The headline answer: can this deployment fetch a signed lecture file?
      lectureSigning: signingWorks ? "working" : "unavailable",
      // …and can it find out *which* file a lecture is?
      lecturePlayback:
        sample.withVideoUrl > 0 ? "working" : signingWorks ? "metadata-only" : "unavailable",
      // The end-to-end answer: master → rendition → segment, fetched for real.
      playbackProbe: playback,
      explain: playback.ok
        ? "A lecture was played end to end just now: master playlist, rendition playlist and a segment all relayed, so playback works."
        : sample.withVideoUrl > 0
          ? `A stream URL is visible, but playback breaks at the ${playback.step} step: ${playback.reason || "unknown"}.`
          : signingWorks
            ? `The token can sign files, but the API returns no stream URL for these lectures (${sample.sampleTitle || "sample"}), so every lecture resolves as 'not published'. Set PW_TOKEN to a bearer that holds the batch to play them.`
            : "No signer accepted the token. Set PW_TOKEN to a valid PW bearer to restore lecture signing.",
      checkedAt: new Date().toISOString(),
    },
    0
  );
}
