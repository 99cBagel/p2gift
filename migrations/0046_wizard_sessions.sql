-- 0046: lock-stage wizard sessions (p2gift MCP).
-- One row per wizard run. The server is the referee: state + locked
-- fields live here, never in an Agent-carried object. Each wizard tool
-- reads its preconditions from this row and advances exactly one
-- transition. Locks are forward-only; the row persists past checkout
-- so the Stage 8 confirmation can be fetched after the fact.
-- Additive only.

CREATE TABLE IF NOT EXISTS wizard_sessions (
  id               TEXT PRIMARY KEY,          -- ses_<10 Crockford chars>
  state            TEXT NOT NULL DEFAULT 'SOURCE_LOADED',
  -- SOURCE_LOADED -> PITCH_LOCKED -> GIFT_LOCKED -> LAYOUT_LOCKED
  --   -> ARTWORK_LOCKED -> DETAILS_LOCKED -> CHECKOUT_ISSUED
  --   -> ORDER_CONFIRMED
  pitch_candidates TEXT,                      -- JSON array, as submitted at intake
  pitch_text       TEXT,                      -- locked at approve_pitch, prints exactly
  pitch_form       TEXT,                      -- full | condensed | short (locked with the pitch)
  gift_item_id     TEXT,                      -- feed inventory id, locked at select_gift
  product_id       INTEGER,                   -- D1 products.id the gift maps to
  variant_label    TEXT,                      -- variant picked on the product page, if any
  layout           TEXT,                      -- layout key (A/B/C...), locked at approve_layout
  artwork_key      TEXT,                      -- FILES bucket key of the parked artwork
  artwork_name     TEXT,
  artwork_size     INTEGER,
  quantity         INTEGER,                   -- locked at set_order_details
  shipping         TEXT,                      -- JSON address, locked at set_order_details
  prefill_token    TEXT,                      -- current prefill_carts token, if issued
  order_public_id  TEXT,                      -- set once the settled order is linked
  customer         TEXT,                      -- JSON OAuth identity when the caller is signed in
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wizard_sessions_prefill ON wizard_sessions (prefill_token);
CREATE INDEX IF NOT EXISTS idx_wizard_sessions_state ON wizard_sessions (state);
