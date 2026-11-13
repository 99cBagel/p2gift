-- 0045: wizard fields on the product record.
-- Additive.
--
-- The lock-stage wizard reads three per-gift facts from the product
-- row (server-side, from D1 — never from the Agent):
--   lead_time_days: days after order confirmation; the Stage 8
--     expected delivery date is [order date + Lead_Time]. NULL =
--     not set yet (the operator sets it per item in Admin).
--   layout_options: the Print Layout Designs offered for this
--     item, as display text. The A/B/C letters are stable keys —
--     picks, locks and ARTWORK_SPECS refer to the letter.
--   artwork_specs: the print specs handed to the Assistant at the
--     layout lock. Advisory text: there are NO automated guardrails
--     on the uploaded artwork (owner decision, 2026-11-13) — the
--     operator reviews the parked file and addresses any issue
--     with the customer manually.
-- The two text columns carry the generic defaults, so existing
-- products gain them from this migration; the same texts live in
-- src/features/products/wizardDefaults.ts for new-product forms.
ALTER TABLE products ADD COLUMN lead_time_days INTEGER;
ALTER TABLE products ADD COLUMN layout_options TEXT DEFAULT 'A — Centered, 3 lines, large
B — Hierarchy, small top line + rule + large name
C — 2 lines, with the em dash kept';
ALTER TABLE products ADD COLUMN artwork_specs TEXT DEFAULT 'Print artwork for this item — render to these specs:
- File: PNG only, under 15 MB
- Background: transparent
- Color: single color
- Content: text only (no logo, no images)
- Font size: any';
