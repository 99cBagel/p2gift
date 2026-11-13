// Live gift item inventory — load available gift items from R2, not
// from code. Source of truth: R2 bucket "p2gift", object
// examples/inventory/inventory.json, synced from this repo's
// examples/inventory/inventory.json by the Sync to R2 workflow (the
// examples/ directory is the MCP feed tree). Only items with
// available=true are offered. The pre-move key inventory/inventory.json
// is read as a fallback while old copies remain in the bucket.
// If R2 is missing, unreadable, or empty, fall back to the hardcoded
// GIFT_POOL and say so (source: "fallback-pool") — never show nothing.

// Gift item pool — the FALLBACK pool, the original 6 items. Used only
// when the live R2 inventory (examples/inventory/inventory.json) is
// missing or empty; at run time the items come from R2, never from
// this list directly. No prices here: pricing is confirmed per order,
// never invented.
export const GIFT_POOL = [
  { id: "tote-bag", name: "Tote Bag", surface: "full", note: "Printed pitch or presentation-inspired artwork on a reusable tote." },
  { id: "leather-notebook-set", name: "Leather Notebook Set", surface: "full", note: "Embossed or printed Pitch Text on a leather notebook set." },
  { id: "stainless-cups-5pack-12oz", name: "5-Pack Stainless Cups (12 oz)", surface: "short", note: "Food-grade 304 stainless steel, poly-coated finish, engraved pitch." },
  { id: "stainless-tumbler-20oz", name: "Stainless Tumbler (20 oz)", surface: "condensed", note: "Engraved or printed pitch on a wrap surface, best for a condensed pitch." },
  { id: "custom-pint-glass-16oz", name: "Custom Pint Glass (16 oz)", surface: "full", note: "Printed full-colour wraparound pitch around the glass." },
  { id: "walnut-peanut-plate", name: "Walnut Peanut Plate", surface: "short", note: "Engraved short phrase, name, or monogram on walnut wood; best for a short pitch message." },
];

const INVENTORY_KEYS = ["examples/inventory/inventory.json", "inventory/inventory.json"];

// Catalog reads are the hot path of the open (token-free) MCP service,
// so a successful R2 read is cached in-isolate for a minute: high
// enough to absorb agent bursts, low enough that a catalog update is
// visible almost immediately. Fallback-pool results are NOT cached —
// a recovered bucket should be picked up on the very next call.
const CACHE_TTL_MS = 60_000;
let cache = { at: 0, value: null };

export async function loadInventory(env) {
  const bucket = env?.P2GIFT_BUCKET;
  if (!bucket) return { source: "fallback-pool", items: GIFT_POOL };
  if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    let obj = null;
    for (const key of INVENTORY_KEYS) {
      obj = await bucket.get(key);
      if (obj) break;
    }
    if (!obj) return { source: "fallback-pool", items: GIFT_POOL };
    const data = JSON.parse(await obj.text());
    const items = (data.items ?? [])
      .filter((i) => i.available === true)
      .map((i) => ({
        id: i.id,
        name: i.name,
        surface: i.surface,
        size: i.size ?? null,
        treatment: i.treatment ?? null,
        note: i.treatment ?? i.note ?? null,
        store: i.store ?? null,
        artwork_rules: i.artwork_rules ?? null,
      }));
    if (items.length === 0) return { source: "fallback-pool", items: GIFT_POOL };
    const value = { source: "r2-inventory", items };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return { source: "fallback-pool", items: GIFT_POOL };
  }
}
