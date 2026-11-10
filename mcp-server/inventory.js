// Live gift item inventory — load available gift items from R2, not
// from code. Source of truth: R2 bucket "p2gift", object
// examples/inventory/inventory.json, synced from this repo's
// examples/inventory/inventory.json by the Sync to R2 workflow (the
// examples/ directory is the MCP feed tree). Only items with
// available=true are offered. The pre-move key inventory/inventory.json
// is read as a fallback while old copies remain in the bucket.
// If R2 is missing, unreadable, or empty, fall back to the hardcoded
// GIFT_POOL and say so (source: "fallback-pool") — never show nothing.
import { GIFT_POOL } from "./gifts.js";

const INVENTORY_KEYS = ["examples/inventory/inventory.json", "inventory/inventory.json"];

export async function loadInventory(env) {
  const bucket = env?.P2GIFT_BUCKET;
  if (!bucket) return { source: "fallback-pool", items: GIFT_POOL };
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
    return { source: "r2-inventory", items };
  } catch {
    return { source: "fallback-pool", items: GIFT_POOL };
  }
}
