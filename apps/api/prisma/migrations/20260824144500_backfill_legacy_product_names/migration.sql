-- Legacy drafts predate the required product-name field. Give each blank product a
-- stable, human-readable name so future package/config projections can be updated.
UPDATE "effect_import_products"
SET "name" = '商品资料包 ' || lpad(("sortOrder" + 1)::text, 2, '0')
WHERE btrim("name") = '';
