import { json, cors, query, badRequest, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchSchedule, fetchAnnouncements } from "../lib/api-data.mjs";

/**
 * GET /api/lecture?batch=&subject=&id=      → lecture detail + attached notes/DPPs
 * GET /api/lecture?batch=&announcements=1   → batch announcements
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { batch, subject, id, announcements } = query(req);
  if (!batch) return badRequest(res, "batch is required");

  try {
    if (announcements) {
      const out = await fetchAnnouncements(batch);
      if (!out.ok) return proxyFallback(res, out, "items");
      return json(res, 200, { success: true, ...out }, 120);
    }

    if (!subject || !id) return badRequest(res, "subject and id are required");
    const out = await fetchSchedule(batch, subject, id);
    if (!out.ok) return proxyFallback(res, out, "lecture");
    return json(res, 200, { success: true, ...out }, 120);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}
