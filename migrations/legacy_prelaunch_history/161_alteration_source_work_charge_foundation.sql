-- Phase 1 foundation for Register-linked alteration intake.
-- Additive only: existing standalone alteration jobs remain valid.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alteration_source_type') THEN
        CREATE TYPE alteration_source_type AS ENUM (
            'current_cart_item',
            'past_transaction_line',
            'catalog_item',
            'custom_item'
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alteration_intake_channel') THEN
        CREATE TYPE alteration_intake_channel AS ENUM (
            'standalone',
            'pos_register'
        );
    END IF;
END $$;

ALTER TABLE alteration_orders
    ADD COLUMN IF NOT EXISTS source_type alteration_source_type,
    ADD COLUMN IF NOT EXISTS item_description text,
    ADD COLUMN IF NOT EXISTS work_requested text,
    ADD COLUMN IF NOT EXISTS source_product_id uuid REFERENCES products(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_sku text,
    ADD COLUMN IF NOT EXISTS source_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_transaction_line_id uuid REFERENCES transaction_lines(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS charge_amount numeric(14,2),
    ADD COLUMN IF NOT EXISTS charge_transaction_line_id uuid REFERENCES transaction_lines(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS intake_channel alteration_intake_channel NOT NULL DEFAULT 'standalone',
    ADD COLUMN IF NOT EXISTS source_snapshot jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'alteration_orders_charge_amount_non_negative'
    ) THEN
        ALTER TABLE alteration_orders
            ADD CONSTRAINT alteration_orders_charge_amount_non_negative
            CHECK (charge_amount IS NULL OR charge_amount >= 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_alteration_orders_source_transaction_line_id
    ON alteration_orders(source_transaction_line_id);

CREATE INDEX IF NOT EXISTS idx_alteration_orders_charge_transaction_line_id
    ON alteration_orders(charge_transaction_line_id);

CREATE INDEX IF NOT EXISTS idx_alteration_orders_source_type_due_at
    ON alteration_orders(source_type, due_at);
