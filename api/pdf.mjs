import { cors, json, query, badRequest } from "../lib/http.mjs";
import { resolvePdfUrl } from "../lib/api-data.mjs";

/**
 * GET /api/pdf?batch=&subject=&pdf=&attachment=
 * Resolves the real PW PDF location from the upstream API and redirects the
 * browser to our own /api/media relay (so the PDF viewer can read it).
 */
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.end();

  const { batch, subject, pdf, attachment, url } = query(req);

  try {
    let target = url || "";

    if (!target) {
      if (!batch || !subject || !pdf || !attachment) {
        return badRequest(res, "Provide url, or batch + subject + pdf + attachment");
      }
      target = await resolvePdfUrl(batch, subject, pdf, attachment);
    }

    if (!target) {
      return json(res, 404, { success: false, error: "PDF is not available for this item" });
    }

    const proxied = `/api/media?url=${encodeURIComponent(target)}`;
    res.statusCode = 302;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", proxied);
    return res.end();
  } catch (err) {
    return json(res, 500, { success: false, error: err?.message || "PDF resolution failed" });
  }
}
