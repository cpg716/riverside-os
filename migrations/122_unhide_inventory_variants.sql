-- Zero stock is not a reason to hide a catalog variation.
-- Parent products that qualify for sale/search must expose the full matrix so POS staff can
-- select the requested size/style even when that variation has no current on-hand quantity.

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS hidden_from_inventory boolean NOT NULL DEFAULT false;

UPDATE product_variants
SET hidden_from_inventory = false
WHERE hidden_from_inventory IS TRUE;
