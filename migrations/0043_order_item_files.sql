-- 0043: multiple files per order item (multi-file list).
-- Additive.
--
-- Until now an order item carried exactly one deliverable file inline
-- (order_items.file_key, written at settlement from the checkout
-- reservation). The operator needs a real parking place on the order:
-- the Final Print Artwork the agent submitted, a corrected version, a
-- maker proof — listed, previewable, and downloadable from the admin
-- order page. One row per parked file; is_current flags the one file
-- that counts as the item's print file, and order_items.file_* keeps
-- mirroring that current file so every existing reader (the customer
-- download route above all) keeps working unchanged.
--
-- The files themselves stay in the private FILES bucket; this table
-- only holds pointers, like order_items always did. Backfill: every
-- item that already carries a file gets its first list entry, marked
-- current, credited to the agent flow that submitted it.
CREATE TABLE order_item_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id       TEXT UNIQUE,
  order_item_id   INTEGER NOT NULL REFERENCES order_items(id),
  file_key        TEXT NOT NULL,
  file_name       TEXT,
  file_mime       TEXT,
  file_size_bytes INTEGER,
  kind            TEXT NOT NULL DEFAULT 'artwork',
  is_current      INTEGER NOT NULL DEFAULT 0,
  downloads       INTEGER NOT NULL DEFAULT 0,
  uploaded_by     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_order_item_files_item ON order_item_files(order_item_id);

INSERT INTO order_item_files (
  public_id, order_item_id, file_key, file_name, file_mime,
  file_size_bytes, kind, is_current, downloads, uploaded_by, created_at
)
SELECT
  'file_' || lower(hex(randomblob(5))),
  oi.id, oi.file_key, oi.file_name, oi.file_mime, oi.file_size_bytes,
  'artwork', 1, oi.downloads, 'agent', o.created_at
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.file_key IS NOT NULL;
