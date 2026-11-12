import { describe, it, expect } from 'vitest';
import { parseAdminEmails, isAdminEmail } from './adminEmails';

describe('parseAdminEmails', () => {
  it('parses a CSV into lowercase addresses', () => {
    expect(parseAdminEmails('Owner@Example.com, Second@Example.com')).toEqual([
      'owner@example.com',
      'second@example.com',
    ]);
  });

  it('drops blanks, duplicates, and non-addresses', () => {
    expect(parseAdminEmails(' a@b.com,,a@b.com , not-an-email, ')).toEqual(['a@b.com']);
  });

  it('treats absent or empty as no allowlist', () => {
    expect(parseAdminEmails(null)).toEqual([]);
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails('')).toEqual([]);
  });
});

describe('isAdminEmail', () => {
  const raw = 'owner@example.com, second@example.com';

  it('matches case-insensitively and trims padding', () => {
    expect(isAdminEmail(raw, ' Owner@Example.COM ')).toBe(true);
  });

  it('rejects addresses not on the list', () => {
    expect(isAdminEmail(raw, 'stranger@example.com')).toBe(false);
  });

  it('rejects everything when the list is empty or the email is missing', () => {
    expect(isAdminEmail('', 'owner@example.com')).toBe(false);
    expect(isAdminEmail(null, 'owner@example.com')).toBe(false);
    expect(isAdminEmail(raw, null)).toBe(false);
    expect(isAdminEmail(raw, '')).toBe(false);
  });
});
