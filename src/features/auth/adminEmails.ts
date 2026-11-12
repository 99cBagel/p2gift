/**
 * The Google admin allowlist: a CSV of email addresses in the
 * `admin_google_emails` setting. Only these Google accounts may turn a
 * Google sign-in into an admin session — anyone else's Google identity
 * is just a customer identity (see checkoutGate.ts). Pure string logic,
 * kept apart from the OAuth flow so it stays unit-testable.
 */

/** Normalize the stored CSV into a deduped list of lowercase addresses. */
export function parseAdminEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email.includes('@')) seen.add(email);
  }
  return [...seen];
}

/** True when `email` (any case, padded or not) is on the allowlist. */
export function isAdminEmail(raw: string | null | undefined, email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  return parseAdminEmails(raw).includes(normalized);
}
