/**
 * Prefixed public IDs — the external identity for records whose row IDs must
 * never cross an application boundary. Format: `<prefix>_<10 lowercase
 * Crockford base32 chars>` (50 random bits). Pure (no bindings) so it's
 * unit-testable and shared by server routes, DTOs, and the backfill script.
 *
 * Public IDs are identifiers, not credentials — guest order access uses the
 * separate `otk_` access token (see token.ts). Input is normalized to
 * lowercase before strict validation so a hand-typed reference still resolves;
 * storage and output are lowercase only.
 */

/** One entry per externally addressable record type. Prefixes are permanent. */
export const PUBLIC_ID_PREFIXES = {
  product: 'prod',
  variant: 'var',
  extra: 'xtra',
  category: 'cat',
  page: 'page',
  order: 'ord',
  media: 'med',
  productImage: 'pimg',
  navItem: 'nav',
  refund: 'rfnd',
  orderItem: 'itm',
  inventoryException: 'iexc',
  orderItemFile: 'file',
  wizardSession: 'ses',
} as const;

export type PublicIdKind = keyof typeof PUBLIC_ID_PREFIXES;

/** Lowercase Crockford base32 — no i, l, o, u. */
export const PUBLIC_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const PUBLIC_ID_TOKEN_LENGTH = 10;

const TOKEN_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{10}$/;

/** 256 is divisible by 32, so masking a random byte to 5 bits stays uniform. */
export function generatePublicId(kind: PublicIdKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PUBLIC_ID_TOKEN_LENGTH));
  let token = '';
  for (const b of bytes) token += PUBLIC_ID_ALPHABET[b & 0x1f];
  return `${PUBLIC_ID_PREFIXES[kind]}_${token}`;
}

/**
 * All-digit numbers (owner decision 2026-11-14): order numbers and wizard
 * session ids are 10 digits, first digit non-zero — one number per wizard
 * run, because a wizard order claims its session's number as its order
 * number (see claimOrderIdentity). Digits only, for ease of use: read,
 * typed, and spoken references never mix letters in. Prefixed IDs minted
 * earlier (ord_…, ses_…) stay valid for the records that carry them.
 */
export const NUMERIC_ID_RE = /^[1-9][0-9]{9}$/;

export function isNumericId(value: unknown): value is string {
  return typeof value === 'string' && NUMERIC_ID_RE.test(value.trim());
}

/** A fresh 10-digit numeric ID (uniform digits; no leading zero). */
export function generateNumericId(): string {
  let out = '';
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let i = 0;
  while (out.length < 10) {
    if (i >= buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    const b = buf[i++];
    if (b >= 250) continue; // 250 = 25 × 10 keeps b % 10 uniform
    const d = b % 10;
    if (out.length === 0 && d === 0) continue;
    out += String(d);
  }
  return out;
}

/**
 * Normalize + strictly validate a public ID of the expected kind.
 * Returns the canonical lowercase form, or null when the prefix, length, or
 * alphabet is wrong — a variant ID can never pass where a product ID is
 * expected.
 */
export function parsePublicId(value: unknown, kind: PublicIdKind): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  const prefix = `${PUBLIC_ID_PREFIXES[kind]}_`;
  if (!normalized.startsWith(prefix)) return null;
  const token = normalized.slice(prefix.length);
  if (!TOKEN_RE.test(token)) return null;
  return normalized;
}

/** The bare 10-char token — the customer-facing order reference. */
export function publicIdToken(publicId: string, kind: PublicIdKind): string | null {
  // A numeric order number is already the whole reference — no prefix to strip.
  if (kind === 'order' && isNumericId(publicId)) return publicId.trim();
  const parsed = parsePublicId(publicId, kind);
  return parsed ? parsed.slice(PUBLIC_ID_PREFIXES[kind].length + 1) : null;
}

/**
 * Legacy order/refund public-ID shapes that predate prefixes and are preserved
 * indefinitely: 32-char lowercase hex (migration 0005 backfill) and UUIDv4
 * (crypto.randomUUID creation paths).
 */
const LEGACY_HEX32_RE = /^[0-9a-f]{32}$/;
const LEGACY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLegacyPublicId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return LEGACY_HEX32_RE.test(v) || LEGACY_UUID_RE.test(v);
}

/** Accepts the prefixed form, a preserved legacy shape, or (orders only) the all-digit number. */
export function parseOrderOrLegacyPublicId(value: unknown, kind: 'order' | 'refund'): string | null {
  const prefixed = parsePublicId(value, kind);
  if (prefixed) return prefixed;
  if (kind === 'order' && isNumericId(value)) return (value as string).trim();
  if (isLegacyPublicId(value)) return (value as string).trim().toLowerCase();
  return null;
}

/**
 * Current-format order identity: a prefixed ord_… ID or an all-digit order
 * number. Both are claimed in the guest-access registry at checkout, so both
 * carry a revocable access token. Legacy shapes are NOT current — a legacy
 * order's public ID is itself its guest link, with no token to rotate.
 */
export function isCurrentOrderId(value: unknown): value is string {
  return parsePublicId(value, 'order') !== null || isNumericId(value);
}

/** Rendered width of a current-format ID: prefix + separator + token. */
export function publicIdDisplayLength(kind: PublicIdKind): number {
  return PUBLIC_ID_PREFIXES[kind].length + 1 + PUBLIC_ID_TOKEN_LENGTH;
}

/**
 * Fit a public ID into the width a current-format one occupies.
 *
 * Current IDs are already exactly that long and pass through untouched. The
 * preserved legacy shapes (32-char hex, 36-char UUID) are more than twice as
 * wide and would otherwise stretch a column that is uniform for every order
 * placed since. The ellipsis is counted INSIDE the budget, so truncated and
 * full IDs still align in a monospace column.
 *
 * Display only — the full value remains the identifier for links and lookups.
 */
export function truncatePublicId(value: string, kind: PublicIdKind): string {
  const width = publicIdDisplayLength(kind);
  if (value.length <= width) return value;
  return `${value.slice(0, width - 1)}\u2026`;
}

/** True when an insert failed on a public_id unique index (retry with a fresh ID). */
export function isPublicIdConflict(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message) && /public_id|access_token/i.test(err.message);
}

/**
 * Run an insert with a freshly generated public ID, regenerating on a unique
 * conflict. The unique index is the collision authority; at 50 bits a retry is
 * a freak event, so three attempts is generous.
 */
export async function withPublicId<T>(
  kind: PublicIdKind,
  insert: (publicId: string) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await insert(generatePublicId(kind));
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
