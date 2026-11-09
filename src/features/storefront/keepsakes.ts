import type { D1Database } from '@cloudflare/workers-types';
import type { Product } from '../products/db';
import { listProductImages } from '../products/db';
import { listVariants } from '../products/variants';
import { requirePublicId } from '../catalog/serialize';
import { productImageSources, productImageUrl, type ImageDelivery } from '../products/image';
import { stockState } from '../products/stock';
import { formatMoney } from '../../money';
import { renderMarkdown } from '../pages/markdown';
import { buildStorefrontImage } from './productCard';
import type {
  KeepsakeGalleryImage,
  KeepsakeItemModel,
  KeepsakePageModel,
} from './models';

/**
 * The Keepsake Items loader (`/`).
 *
 * Everything the template must not do lives here: reading D1, parsing the
 * `catalog_data` JSON (never throws — a malformed value renders the core
 * fields only), resolving image URLs, and formatting money. The template
 * receives a finished model and decides only how it looks.
 *
 * Order is creation order (id ASC): the page is a fixed list of keepsakes,
 * not a sortable catalog, so newest-first would shuffle the pick numbers
 * every time a product is added.
 */

const HERO_SIZES = '(min-width: 768px) 528px, calc(100vw - 48px)';
const MAX_GALLERY = 8;
const MAX_FEATURES = 8;
const MAX_INSIGHTS = 5;

/** The `catalog_data` facts a keepsake section renders. Null = not catalog-fed. */
export interface CatalogFacts {
  brand: string | null;
  rating: number | null;
  reviewCount: number | null;
  ratingBreakdown: { stars: number; percent: number }[];
  images: string[];
  features: string[];
  reviewInsights: { label: string; summary: string; mentions: number; mentionPercent: number }[];
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asNonEmptyString(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function asHttpUrl(v: unknown): string | null {
  const s = asNonEmptyString(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Parse the stored `catalog_data` JSON into the facts the page renders.
 * Returns null when there is no catalog data or it is not valid JSON, so a
 * bad row degrades to the core fields instead of breaking the page.
 */
export function parseCatalogFacts(raw: string | null): CatalogFacts | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  const ratingRaw = asFiniteNumber(o.rating);
  const rating = ratingRaw !== null && ratingRaw >= 0 && ratingRaw <= 5 ? ratingRaw : null;
  const reviewCountRaw = asFiniteNumber(o.review_count);
  const reviewCount =
    reviewCountRaw !== null && reviewCountRaw >= 0 ? Math.round(reviewCountRaw) : null;

  // rating_breakdown is a {1..5: fraction} map; render 5 → 1 as whole percents.
  const ratingBreakdown: { stars: number; percent: number }[] = [];
  const rb = o.rating_breakdown;
  if (rb && typeof rb === 'object') {
    for (let stars = 5; stars >= 1; stars--) {
      const f = asFiniteNumber((rb as Record<string, unknown>)[String(stars)]);
      if (f !== null && f >= 0 && f <= 1) ratingBreakdown.push({ stars, percent: Math.round(f * 100) });
    }
  }

  const images: string[] = [];
  if (Array.isArray(o.images)) {
    for (const item of o.images) {
      const u = asHttpUrl(item);
      if (u && !images.includes(u)) images.push(u);
      if (images.length >= MAX_GALLERY) break;
    }
  }

  const reviewInsights: CatalogFacts['reviewInsights'] = [];
  if (Array.isArray(o.review_insights)) {
    for (const item of o.review_insights) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const label = asNonEmptyString(it.label);
      const summary = asNonEmptyString(it.summary);
      if (!label || !summary) continue;
      const mentions = asFiniteNumber(it.mentions);
      const pct = asFiniteNumber(it.mention_percent);
      reviewInsights.push({
        label,
        summary,
        mentions: mentions !== null ? Math.round(mentions) : 0,
        mentionPercent: pct !== null ? Math.round(pct) : 0,
      });
      if (reviewInsights.length >= MAX_INSIGHTS) break;
    }
  }

  return {
    brand: asNonEmptyString(o.brand),
    rating,
    reviewCount,
    ratingBreakdown,
    images,
    features: asStringArray(o.features, MAX_FEATURES),
    reviewInsights,
  };
}

export interface KeepsakePageOptions {
  imageBaseUrl: string;
  /** The site's public origin (see features/http/origin), used to make the
   *  pick message's image link absolute — the message is pasted into chat,
   *  where a root-relative path would be a dead link. */
  siteOrigin: string;
  delivery: ImageDelivery | undefined;
  /** The store's configured currency, for price display. */
  currency: string;
}

/**
 * Load every active product as a keepsake section, in creation order, with
 * its variants and its catalog facts. No pagination: the page is capped by
 * the keepsake pool, not by the catalog size.
 */
export async function loadKeepsakePage(
  db: D1Database,
  options: KeepsakePageOptions,
): Promise<KeepsakePageModel> {
  const { results } = await db
    .prepare('SELECT * FROM products WHERE active = 1 ORDER BY id ASC')
    .all<Product>();
  const products = results ?? [];

  const items = await Promise.all(
    products.map(async (product, index): Promise<KeepsakeItemModel> => {
      const [variants, galleryRows] = await Promise.all([
        listVariants(db, product.id),
        listProductImages(db, product.id),
      ]);
      const facts = parseCatalogFacts(product.catalog_data);

      // Gallery: the catalog's own photos first (absolute URLs), then the
      // product's uploaded gallery, then the single primary image.
      let gallery: KeepsakeGalleryImage[] = [];
      if (facts && facts.images.length > 0) {
        gallery = facts.images.map((src) => ({ src, alt: product.name }));
      } else if (galleryRows.length > 0) {
        gallery = galleryRows.map((row) => {
          const s = productImageSources(row.image_key, {
            baseUrl: options.imageBaseUrl,
            delivery: options.delivery,
            usage: 'detail',
            sizes: HERO_SIZES,
          });
          return {
            src: s.src,
            ...(s.srcset ? { srcset: s.srcset } : {}),
            ...(s.sizes ? { sizes: s.sizes } : {}),
            alt: row.alt || product.name,
          };
        });
      }
      if (gallery.length === 0) {
        const primary = buildStorefrontImage(product.image_key, product.name, {
          baseUrl: options.imageBaseUrl,
          delivery: options.delivery,
          sizes: HERO_SIZES,
          priority: index === 0,
        });
        gallery = [
          {
            src: primary.src,
            ...(primary.srcset ? { srcset: primary.srcset } : {}),
            ...(primary.sizes ? { sizes: primary.sizes } : {}),
            alt: product.name,
          },
        ];
      }

      const hasVariants = variants.length > 0;
      const variantPrices = variants.map((v) => v.price_cents);
      const displayPriceCents = hasVariants ? Math.min(...variantPrices) : product.price_cents;
      const priceVaries = hasVariants && Math.min(...variantPrices) !== Math.max(...variantPrices);
      // With variants the inventory unit is the variant, so availability
      // comes from them; otherwise from the product's own stock.
      const inStock = hasVariants
        ? variants.some((v) => v.stock > 0)
        : stockState(product.stock) !== 'out';

      return {
        id: requirePublicId(product.public_id, product.id, 'product'),
        position: index + 1,
        name: product.name,
        brand: facts?.brand ?? null,
        formattedPrice: formatMoney(displayPriceCents, options.currency),
        priceVaries,
        inStock,
        descriptionHtml: product.description
          ? renderMarkdown(product.description, { baseUrl: options.imageBaseUrl })
          : null,
        // The pick message's image link: the product's OWN stored image as
        // an absolute URL (same resolution the catalog API uses). Null when
        // there is no image_key — productImageUrl would substitute the
        // placeholder, and the message must never link a placeholder.
        imageUrl: product.image_key
          ? new URL(
              productImageUrl(product.image_key, options.imageBaseUrl),
              options.siteOrigin,
            ).href
          : null,
        gallery,
        rating: facts?.rating ?? null,
        reviewCount: facts?.reviewCount ?? null,
        ratingBreakdown: facts?.ratingBreakdown ?? [],
        features: facts?.features ?? [],
        reviewInsights: facts?.reviewInsights ?? [],
        variantLabel: product.variant_label,
        variants: variants.map((v) => ({
          label: v.label,
          formattedPrice: formatMoney(v.price_cents, options.currency),
          soldOut: v.stock <= 0,
        })),
      };
    }),
  );

  return { heading: 'Keepsake Items', items };
}
