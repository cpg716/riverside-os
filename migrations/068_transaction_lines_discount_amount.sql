-- Repair schema drift for line-level discount reporting.
-- Customer Hub, reports, and storefront queries expect transaction line discounts
-- to be represented separately from unit price.

ALTER TABLE public.transaction_lines
    ADD COLUMN IF NOT EXISTS discount_amount numeric(12, 2) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.transaction_lines.discount_amount IS
    'Line-level discount amount applied per unit before quantity extension; defaults to 0 for historical lines.';
