// Gift item inventory — the store's own product list, read from D1.
//
// Direct mapping to the Product Page (owner decision, 2026-11-13):
// the wizard's inventory IS the minshop catalog — the active
// products, in the Product Page's own order (products ORDER BY id
// ASC, the order src/features/storefront/keepsakes.ts renders). The
// wizard and the page can therefore never disagree, and "Pick N"
// maps by construction. There is no feed file and no fallback pool
// anymore: the retired R2 inventory.json held the surface and
// treatment facts that now live on the product row (migration 0047),
// and prices always came from D1.
//
// Item shape (what the wizard consumes):
//   id            the product's public id (prod_…) — the gift_item_id
//   name          the product name, as on the page
//   surface       print_surface: full | condensed | short (null until set)
//   treatment     how the pitch is applied, e.g. engraved / printed
//   lead_time_days  the item's Lead_Time (Stage 8 delivery estimate)
//   store.slug    the product slug (internal mapping to the D1 row)

export async function loadInventory(env) {
  if (!env?.DB) return { source: "unavailable", items: [] };
  const { results } = await env.DB.prepare(
    `SELECT public_id, name, slug, print_surface, treatment, lead_time_days
       FROM products
      WHERE active = 1
      ORDER BY id ASC`,
  ).all();
  const items = (results ?? []).map((p) => ({
    id: p.public_id,
    name: p.name,
    surface: p.print_surface ?? null,
    treatment: p.treatment ?? null,
    lead_time_days: p.lead_time_days ?? null,
    store: { slug: p.slug },
  }));
  return { source: "d1-products", items };
}
