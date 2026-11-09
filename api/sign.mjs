/**
 * `GET /api/sign?videoKey=&key=` — mount only.
 *
 * The behaviour lives in `lib/sign.mjs`, and this file exists so the route keeps
 * its own URL. It is deliberately a mount and nothing else: it once kept a copy
 * of the relay's logic, which is how the two drifted.
 */

import signHandler from "../lib/sign.mjs";

export default async function handler(req, res) {
  return signHandler(req, res);
}
