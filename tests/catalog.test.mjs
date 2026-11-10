/**
 * Catalogue filter and sort tests.
 *
 * The sort dropdown used to carry `value="free"` for "Price: high to low",
 * which is also a value the price filter uses. `?price=free&sort=free` was
 * ambiguous, and the sort was silently dropped — a request for high-to-low
 * came back sorted by nothing. These tests pin the separation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("the price filter and the price sort are separate controls", async () => {
  // The sort dropdown used to carry value="free" for "Price: high to low",
  // which is also a price-filter value. `?price=free&sort=free` was therefore
  // ambiguous, and the encoded sort was silently dropped: a request for a
  // high-to-low price sort came back with sort:"default".
  const { normaliseSort, CATALOG_SORTS } = await import("../lib/catalog.mjs");

  assert.equal(normaliseSort("price-asc"), "price-asc");
  assert.equal(normaliseSort("price-desc"), "price-desc");

  // Legacy links keep working, and map to the sort they always meant.
  assert.equal(normaliseSort("price"), "price-asc", "an old ?sort=price meant ascending");
  assert.equal(normaliseSort("free"), "price-desc", "an old ?sort=free meant descending");

  // No sort key may collide with a price-filter value.
  for (const key of CATALOG_SORTS) {
    assert.ok(!["free", "paid", "all"].includes(key), `sort "${key}" collides with a price filter`);
  }
  assert.ok(CATALOG_SORTS.has("price-asc") && CATALOG_SORTS.has("price-desc"));
});
