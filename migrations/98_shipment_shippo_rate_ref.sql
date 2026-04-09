-- Persist Shippo rate object id on shipment so staff can buy a label after quotes are consumed.
-- POS checkout and apply-quote both copy from store_shipping_rate_quote before DELETE.

ALTER TABLE shipment
    ADD COLUMN IF NOT EXISTS shippo_rate_object_id TEXT;

COMMENT ON COLUMN shipment.shippo_rate_object_id IS 'Shippo Rate object_id for POST /transactions/ label purchase; set from quote row when quote is applied or at POS checkout.';
