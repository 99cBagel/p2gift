-- 0040: catalog_data on products — the full normalized Crawlora item as JSON.
-- The core columns (slug, name, description, price_cents, image_key, active)
-- stay the queryable/sortable fields; catalog_data carries the Amazon-style
-- extras the Product Page renders (brand, rating + review count, rating
-- breakdown, list price, image gallery, features, availability, ETA, review
-- insights). Additive; never edited after it runs.

ALTER TABLE products ADD COLUMN catalog_data TEXT;
