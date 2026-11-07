// Mini inventory — load available keepsakes from R2, not from code.
// Source of truth: R2 bucket "p2gift", object inventory/inventory.json,
// synced from this repo's inventory/inventory.json by the Sync to R2
// workflow. Only items with available=true are offered.
// If R2 is missing, unreadable, or empty, fall back to the hardcoded
// KI_POOL and say so (source: "fallback-pool") — never show nothing.
import { KI_POOL } from "./keepsakes.js";

export async function loadInventory(env) {
  const bucket = env?.P2GIFT_BUCKET;
  if (!bucket) return { source: "fallback-pool", items: KI_POOL };
  try {
    const obj = await bucket.get("inventory/inventory.json");
    if (!obj) return { source: "fallback-pool", items: KI_POOL };
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
      }));
    if (items.length === 0) return { source: "fallback-pool", items: KI_POOL };
    return { source: "r2-inventory", items };
  } catch {
    return { source: "fallback-pool", items: KI_POOL };
  }
}
