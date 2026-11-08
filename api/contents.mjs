import { json, cors, query, badRequest, methodNotAllowed, proxyFallback } from "../lib/http.mjs";
import { fetchChapters, fetchChapterContents } from "../lib/api-data.mjs";

/**
 * GET /api/contents?batch=<id>&subject=<subjectSlug>            → chapters
 * GET /api/contents?batch=&subject=&topic=&type=videos|notes|DppNotes → chapter contents
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "GET") return methodNotAllowed(res);

  const { batch, subject, topic, type } = query(req);
  if (!batch || !subject) return badRequest(res, "batch and subject are required");

  try {
    if (topic) {
      const contentType = (type || "videos").trim();
      const out = await fetchChapterContents(batch, subject, topic, contentType);
      if (!out.ok) return proxyFallback(res, out, "items");
      return json(res, 200, { success: true, ...out }, 120);
    }

    const out = await fetchChapters(batch, subject);
    if (!out.ok) return proxyFallback(res, out, "chapters");
    return json(res, 200, { success: true, ...out }, 300);
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "Unexpected error" });
  }
}
