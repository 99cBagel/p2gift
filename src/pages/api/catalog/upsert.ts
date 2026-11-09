import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { upsertCatalogProduct } from '../../../features/products/db';

export const prerender = false;

const json = (body: object, status: number): Response =>
  Response.json(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });

/** Constant-time byte comparison for the shared secret (avoids timing leaks). */
function secretsEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Minimal shape of one normalized catalog item from crawlora_extracted.json. */
interface CatalogItem {
  asin?: unknown;
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  price?: unknown;
  price_cents?: unknown;
  currency?: unknown;
  image_key?: unknown;
  ok?: unknown;
}

/**
 * POST /api/catalog/upsert — load the extracted Crawlora catalog into D1
 * products. Reads `crawlora_extracted.json` from P2GIFT_BUCKET and upserts
 * each ok:true item by slug (ASIN lowercase). Only the caller holding the
 * shared secret (header `x-catalog-upsert-key`, env CATALOG_UPSERT_KEY) may
 * call it; without the secret configured the endpoint is disabled
 * (fail-closed). No price is ever invented: an item without a usable price
 * is skipped and reported.
 *
 * Returns { upserted, skipped, errors } where `upserted` counts inserted +
 * updated rows and `skipped` lists ASINs left out with a reason.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = env.CATALOG_UPSERT_KEY;
  if (!secret) return json({ error: 'Catalog upsert is not configured.' }, 503);

  const provided = request.headers.get('x-catalog-upsert-key');
  if (!provided || !secretsEqual(provided, secret)) {
    return json({ error: 'Unauthorized.' }, 401);
  }

  const obj = await env.P2GIFT_BUCKET.get('crawlora_extracted.json');
  if (!obj) return json({ error: 'crawlora_extracted.json not found in bucket.' }, 404);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await obj.text());
  } catch {
    return json({ error: 'crawlora_extracted.json is not valid JSON.' }, 500);
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    return json({ error: 'crawlora_extracted.json has no items array.' }, 500);
  }

  let upserted = 0;
  const skipped: { asin: string; reason: string }[] = [];
  const errors: { asin: string; reason: string }[] = [];

  for (const raw of items as CatalogItem[]) {
    const asin = typeof raw.asin === 'string' ? raw.asin : '';
    if (raw.ok !== true || !asin) {
      skipped.push({ asin: asin || '(missing)', reason: 'not ok or no ASIN' });
      continue;
    }
    const slug = (typeof raw.slug === 'string' && raw.slug ? raw.slug : asin).toLowerCase();
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name) {
      skipped.push({ asin, reason: 'no name' });
      continue;
    }
    // price_cents is authoritative when present; else derive from price.
    // Never invent a price: without a usable number the item is skipped.
    let priceCents: number | null = null;
    if (typeof raw.price_cents === 'number' && Number.isFinite(raw.price_cents)) {
      priceCents = Math.round(raw.price_cents);
    } else if (typeof raw.price === 'number' && Number.isFinite(raw.price)) {
      priceCents = Math.round(raw.price * 100);
    }
    if (priceCents === null || priceCents < 0) {
      skipped.push({ asin, reason: 'no usable price' });
      continue;
    }
    try {
      await upsertCatalogProduct(env.DB, {
        slug,
        name,
        description: typeof raw.description === 'string' ? raw.description : null,
        price_cents: priceCents,
        currency: 'usd',
        image_key: typeof raw.image_key === 'string' ? raw.image_key : null,
        active: 1,
        catalog_data: JSON.stringify(raw),
      });
      upserted += 1;
    } catch (err) {
      errors.push({ asin, reason: err instanceof Error ? err.message : 'upsert failed' });
    }
  }

  return json({ ok: errors.length === 0, upserted, skipped, errors }, 200);
};
