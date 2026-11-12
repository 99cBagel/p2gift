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
