-- 0047: gift print surface + treatment on products.
-- The wizard's gift inventory is now the store's own product list
-- (direct mapping to the Product Page), so the two facts that used
-- to live only in the R2 inventory feed move onto the product row:
--   print_surface — full | condensed | short: what pitch form the
--     item's print surface can bear (the pitch rail fits against it)
--   treatment — how the pitch is applied, e.g. "Pitch Text engraved
--     on the cups" (fed to the agent by the MCP service)
-- Backfilled for the two live products from the retired feed.
-- Additive only.

ALTER TABLE products ADD COLUMN print_surface TEXT;
ALTER TABLE products ADD COLUMN treatment TEXT;

UPDATE products SET print_surface = 'condensed', treatment = 'Pitch Text printed on the tumbler'
 WHERE slug = 'b0fjlskf6v';
UPDATE products SET print_surface = 'short', treatment = 'Pitch Text engraved on the cups'
 WHERE slug = 'b0gtzp2ddw';
