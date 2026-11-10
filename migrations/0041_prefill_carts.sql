-- 0041: agent-prefilled carts for the MCP checkout handoff. Additive.
--
-- prepare_checkout (the MCP-side checkout preparation) validates the
-- order's shape — cart contents against the live catalog, and the Final
-- Print Artwork against the 2-layer artwork rules — and only then writes
-- one of these rows. The human opens /cart/prefill/<token>, which sets
-- their cart cookie from `lines`, carries the artwork reference into
-- checkout, and the artwork file (already stored in the FILES bucket)
-- is attached to the order item when the order settles.
--
-- lines: JSON array, one line for the pilot:
--   [{ product_public_id, variant_public_id|null, qty }]
-- shipping: JSON object with the checkout address fields
--   { name, line1, line2, city, state, postal, country }
-- The price snapshot is what prepare_checkout verified against D1 at
-- preparation time; checkout itself re-prices from the cart as usual —
-- this column is the audit record of what the agent quoted.

CREATE TABLE IF NOT EXISTS prefill_carts (
  token           TEXT PRIMARY KEY,
  lines           TEXT NOT NULL,
  artwork_key     TEXT,
  artwork_name    TEXT,
  artwork_size    INTEGER,
  shipping        TEXT NOT NULL,
  total_cents     INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'usd',
  agent_user_id   TEXT,
  session_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_prefill_carts_status
  ON prefill_carts (status, expires_at);
