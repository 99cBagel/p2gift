import { describe, it, expect } from 'vitest';
import {
  PUBLIC_ID_PREFIXES,
  PUBLIC_ID_ALPHABET,
  generatePublicId,
  parsePublicId,
  publicIdToken,
  isLegacyPublicId,
  parseOrderOrLegacyPublicId,
  generateNumericId,
  isNumericId,
  isCurrentOrderId,
  type PublicIdKind,
} from './publicId';

const KINDS = Object.keys(PUBLIC_ID_PREFIXES) as PublicIdKind[];

describe('generatePublicId', () => {
  it('emits the requested prefix plus exactly 10 allowed characters', () => {
    for (const kind of KINDS) {
      const id = generatePublicId(kind);
      const prefix = `${PUBLIC_ID_PREFIXES[kind]}_`;
      expect(id.startsWith(prefix)).toBe(true);
      const token = id.slice(prefix.length);
      expect(token).toHaveLength(10);
      for (const ch of token) expect(PUBLIC_ID_ALPHABET).toContain(ch);
    }
  });

  it('does not repeat across a batch (50-bit space, mocked-free sanity check)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generatePublicId('product'));
    expect(seen.size).toBe(1000);
  });

  it('never emits the excluded Crockford letters i, l, o, u in the token', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId('order').slice('ord_'.length)).not.toMatch(/[ilou]/);
    }
  });
});

describe('parsePublicId', () => {
  it('normalizes uppercase input to lowercase before validating', () => {
    expect(parsePublicId('PROD_K7M2QX8VN6', 'product')).toBe('prod_k7m2qx8vn6');
    expect(parsePublicId('  prod_k7m2qx8vn6  ', 'product')).toBe('prod_k7m2qx8vn6');
  });

  it('rejects wrong prefixes so a variant cannot pass as a product', () => {
    expect(parsePublicId('var_k7m2qx8vn6', 'product')).toBeNull();
    expect(parsePublicId('prod_k7m2qx8vn6', 'variant')).toBeNull();
  });

  it('rejects wrong lengths and invalid characters', () => {
    expect(parsePublicId('prod_k7m2qx8vn', 'product')).toBeNull(); // 9
    expect(parsePublicId('prod_k7m2qx8vn6t', 'product')).toBeNull(); // 11
    expect(parsePublicId('prod_k7m2qxlvn6', 'product')).toBeNull(); // 'l' excluded
    expect(parsePublicId('prod_k7m2qx8vni', 'product')).toBeNull(); // 'i' excluded
    expect(parsePublicId(42 as unknown, 'product')).toBeNull();
    expect(parsePublicId('42', 'product')).toBeNull();
  });
});

describe('publicIdToken', () => {
  it('strips the validated prefix for the customer reference', () => {
    expect(publicIdToken('ord_h5tm8qp3vn', 'order')).toBe('h5tm8qp3vn');
    expect(publicIdToken('prod_h5tm8qp3vn', 'order')).toBeNull();
  });
});

describe('legacy shapes', () => {
  const hex32 = 'a'.repeat(32);
  const uuid = '123e4567-e89b-42d3-a456-426614174000';

  it('recognizes hex32 and uuid, rejects everything else', () => {
    expect(isLegacyPublicId(hex32)).toBe(true);
    expect(isLegacyPublicId(uuid)).toBe(true);
    expect(isLegacyPublicId('ord_h5tm8qp3vn')).toBe(false);
    expect(isLegacyPublicId('42')).toBe(false);
  });

  it('parseOrderOrLegacyPublicId accepts both shapes for orders', () => {
    expect(parseOrderOrLegacyPublicId('ord_h5tm8qp3vn', 'order')).toBe('ord_h5tm8qp3vn');
    expect(parseOrderOrLegacyPublicId(hex32, 'order')).toBe(hex32);
    expect(parseOrderOrLegacyPublicId(uuid, 'refund')).toBe(uuid);
    expect(parseOrderOrLegacyPublicId('42', 'order')).toBeNull();
  });
});

describe('numeric ids (order numbers / wizard session ids)', () => {
  it('generateNumericId emits exactly 10 digits, first non-zero', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateNumericId()).toMatch(/^[1-9][0-9]{9}$/);
    }
  });

  it('does not repeat across a batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateNumericId());
    expect(seen.size).toBe(1000);
  });

  it('isNumericId accepts the shape and rejects lookalikes', () => {
    expect(isNumericId('1234567890')).toBe(true);
    expect(isNumericId('0123456789')).toBe(false); // leading zero
    expect(isNumericId('123456789')).toBe(false); // too short
    expect(isNumericId('12345678901')).toBe(false); // too long
    expect(isNumericId('12345abcde')).toBe(false);
    expect(isNumericId('ord_h5tm8qp3vn')).toBe(false);
    expect(isNumericId(1234567890)).toBe(false);
    expect(isNumericId(null)).toBe(false);
  });

  it('parseOrderOrLegacyPublicId accepts numeric order numbers, not for refunds', () => {
    expect(parseOrderOrLegacyPublicId('1234567890', 'order')).toBe('1234567890');
    expect(parseOrderOrLegacyPublicId('1234567890', 'refund')).toBeNull();
  });

  it('publicIdToken returns a numeric order number whole', () => {
    expect(publicIdToken('1234567890', 'order')).toBe('1234567890');
    expect(publicIdToken('1234567890', 'product')).toBeNull();
  });

  it('isCurrentOrderId covers both current formats, not legacy shapes', () => {
    expect(isCurrentOrderId('ord_h5tm8qp3vn')).toBe(true);
    expect(isCurrentOrderId('1234567890')).toBe(true);
    expect(isCurrentOrderId('a'.repeat(32))).toBe(false);
    expect(isCurrentOrderId('123e4567-e89b-42d3-a456-426614174000')).toBe(false);
    expect(isCurrentOrderId(null)).toBe(false);
  });
});
