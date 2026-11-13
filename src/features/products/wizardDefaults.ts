/**
 * Generic wizard texts for a gift item, used when the product row
 * carries none. The same strings are the column defaults in
 * migration 0045; these constants serve the admin form (prefill for
 * new products) and any reader that needs the effective value.
 *
 * Layout letters are stable keys: picks, locks and ARTWORK_SPECS
 * refer to the letter (A/B/C), never to the description text.
 */
export const DEFAULT_LAYOUT_OPTIONS = `A — Centered, 3 lines, large
B — Hierarchy, small top line + rule + large name
C — 2 lines, with the em dash kept`;

/**
 * The print specs handed to the Assistant at the layout lock.
 * Advisory only — no automated guardrails run on the uploaded
 * artwork; the operator reviews it and addresses any issue with
 * the customer manually (owner decision, 2026-11-13).
 */
export const DEFAULT_ARTWORK_SPECS = `Print artwork for this item — render to these specs:
- File: PNG only, under 15 MB
- Background: transparent
- Color: single color
- Content: text only (no logo, no images)
- Font size: any`;
