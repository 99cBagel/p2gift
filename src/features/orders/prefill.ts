/**
 * Agent-prefilled carts (migration 0041). The MCP prepare_checkout
 * module builds the cart from the wizard session's locked row and
 * writes a prefill_carts row. The human opens /cart/prefill/<token>;
 * that route sets the cart cookie from the row and this module
 * supplies the rest of the handoff: the shipping address the
 * checkout page pre-fills (null when the session locked none — the
 * flex-menu dialog collects no address; Stripe collects it at
 * payment instead), and the artwork file that is attached to the
 * order item when checkout settles.
 */
import type { D1Database } from '@cloudflare/workers-types';
import type { ReservationItem } from './reservations.ts';

export interface PrefillLine {
  product_public_id: string;
  variant_public_id: string | null;
  qty: number;
  product_id?: number;
}

export interface PrefillShipping {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal: string;
  country: string;
}

export interface PrefillRecord {
  token: string;
  lines: PrefillLine[];
  artworkKey: string | null;
  artworkName: string | null;
  artworkSize: number | null;
  shipping: PrefillShipping | null;
  totalCents: number;
  status: string;
  expiresAt: string;
}

interface PrefillRow {
  token: string;
  lines: string;
  artwork_key: string | null;
  artwork_name: string | null;
  artwork_size: number | null;
  shipping: string | null;
  total_cents: number;
  status: string;
  expires_at: string;
}

/** An open, unexpired prefill by token — anything else reads as none. */
export async function getOpenPrefill(db: D1Database, token: string): Promise<PrefillRecord | null> {
  if (!token || typeof token !== 'string') return null;
  const row = await db
    .prepare(
      `SELECT token, lines, artwork_key, artwork_name, artwork_size, shipping, total_cents, status, expires_at
         FROM prefill_carts
        WHERE token = ? AND status = 'open' AND expires_at > datetime('now')`,
    )
    .bind(token)
    .first<PrefillRow>();
  if (!row) return null;
  try {
    return {
      token: row.token,
      lines: JSON.parse(row.lines) as PrefillLine[],
      artworkKey: row.artwork_key,
      artworkName: row.artwork_name,
      artworkSize: row.artwork_size,
      shipping: row.shipping ? (JSON.parse(row.shipping) as PrefillShipping) : null,
      totalCents: row.total_cents,
      status: row.status,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

/** Mark a prefill consumed (idempotent; only from open). */
export async function consumePrefill(db: D1Database, token: string): Promise<void> {
  await db
    .prepare(
      `UPDATE prefill_carts SET status = 'consumed', consumed_at = datetime('now')
        WHERE token = ? AND status = 'open'`,
    )
    .bind(token)
    .run();
}

/**
 * Load the open prefill for a token, attach its artwork to the items,
 * and consume it — the one-call form used by the checkout handlers.
 * A consumed or expired token reads as no prefill, so applying twice
 * in one request is a no-op the second time.
 */
export async function applyPrefillByToken(
  db: D1Database,
  token: string | undefined | null,
  items: ReservationItem[],
): Promise<ReservationItem[]> {
  if (!token) return items;
  const rec = await getOpenPrefill(db, token);
  if (!rec) return items;
  const out = applyPrefillArtwork(items, rec);
  if (out.applied) await consumePrefill(db, rec.token);
  return out.items;
}

/**
 * Attach the prefill's artwork file to the matching reservation item
 * (the gift line), so settlement writes it onto the order item.
 * Returns the items unchanged when no line matches.
 */
export function applyPrefillArtwork(
  items: ReservationItem[],
  prefill: PrefillRecord,
): { items: ReservationItem[]; applied: boolean } {
  if (!prefill.artworkKey) return { items, applied: false };
  const line = prefill.lines.find((l) => typeof l.product_id === 'number');
  if (!line) return { items, applied: false };
  let applied = false;
  const out = items.map((it) => {
    if (!applied && it.productId === line.product_id) {
      applied = true;
      return {
        ...it,
        fileKey: prefill.artworkKey,
        fileName: prefill.artworkName ?? 'final-print-artwork.png',
        fileMime: 'image/png',
        fileSizeBytes: prefill.artworkSize ?? null,
      };
    }
    return it;
  });
  return { items: out, applied };
}
