-- Gift Cards & Loyalty — full schema extension
-- Depends on: 01_initial_schema (gift_cards, store_settings, customers), 17_staff_authority (staff_access_log)

-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Card-kind enum
-- ──────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE gift_card_kind AS ENUM ('purchased', 'loyalty_reward', 'donated_giveaway'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    DO $$ BEGIN CREATE TYPE gift_card_status AS ENUM ('active', 'depleted', 'void'); EXCEPTION WHEN duplicate_object THEN null; END $$;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2) Extend gift_cards table
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE gift_cards
    ADD COLUMN IF NOT EXISTS card_kind gift_card_kind NOT NULL DEFAULT 'purchased',
    ADD COLUMN IF NOT EXISTS card_status gift_card_status NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS original_value NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS issued_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS issued_session_id UUID REFERENCES register_sessions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- Backfill original_value for existing rows
UPDATE gift_cards SET original_value = current_balance WHERE original_value IS NULL;

-- Ensure current_balance cannot go negative
ALTER TABLE gift_cards
    ADD CONSTRAINT gift_cards_balance_non_negative CHECK (current_balance >= 0);

CREATE INDEX IF NOT EXISTS idx_gift_cards_customer ON gift_cards(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(card_status);
CREATE INDEX IF NOT EXISTS idx_gift_cards_kind ON gift_cards(card_kind);
CREATE INDEX IF NOT EXISTS idx_gift_cards_expires ON gift_cards(expires_at);

COMMENT ON TABLE gift_cards IS
    'Preprinted physical gift cards. Purchased cards carry liability (is_liability=true); loyalty/donated carry no liability until redeemed.';
COMMENT ON COLUMN gift_cards.is_liability IS
    'True for purchased cards (liability at issue). False for loyalty_reward/donated_giveaway (expensed at redemption).';

-- ──────────────────────────────────────────────────────────────────────────────
-- 3) Gift card events (audit trail)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_card_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gift_card_id UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
    event_kind TEXT NOT NULL,       -- 'issued' | 'redeemed' | 'loaded' | 'voided' | 'adjusted'
    amount NUMERIC(14,2) NOT NULL,  -- positive = load, negative = redeem/reduce
    balance_after NUMERIC(14,2) NOT NULL,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    session_id UUID REFERENCES register_sessions(id) ON DELETE SET NULL,
    staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gc_events_card ON gift_card_events(gift_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gc_events_order ON gift_card_events(order_id) WHERE order_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4) Loyalty — point ledger (append-only)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_point_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    delta_points INTEGER NOT NULL,      -- positive = earn, negative = deduct
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL,               -- 'order_earn' | 'reward_redemption' | 'manual_adjust' | ...
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lpl_customer ON loyalty_point_ledger(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lpl_order ON loyalty_point_ledger(order_id) WHERE order_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5) Order loyalty accrual — prevents double-counting
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_loyalty_accrual (
    order_id UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    points_earned INTEGER NOT NULL,
    product_subtotal NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────────────────────
-- 6) Loyalty reward issuance log (for monthly cycle tracking)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loyalty_reward_issuances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    points_deducted INTEGER NOT NULL DEFAULT 5000,
    reward_amount NUMERIC(14,2) NOT NULL DEFAULT 50.00,
    applied_to_sale NUMERIC(14,2) NOT NULL DEFAULT 0,   -- amount applied directly
    remainder_card_id UUID REFERENCES gift_cards(id),   -- card loaded with remainder
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    issued_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lri_customer ON loyalty_reward_issuances(customer_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- 7) Exclude-from-loyalty flag on products
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS excludes_from_loyalty BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN products.excludes_from_loyalty IS
    'When true, order lines for this product do NOT earn loyalty points (gift card SKUs, fees).';

-- Mark existing gift card activation SKU as excluded
UPDATE products SET excludes_from_loyalty = true
WHERE name ILIKE '%gift card%' OR catalog_handle ILIKE '%gift%';

-- ──────────────────────────────────────────────────────────────────────────────
-- 8) Receipt configuration
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS receipt_config JSONB NOT NULL DEFAULT '{
        "store_name": "Riverside OS",
        "show_address": true,
        "show_phone": true,
        "show_email": false,
        "show_loyalty_earned": true,
        "show_loyalty_balance": true,
        "show_barcode": false,
        "header_lines": [],
        "footer_lines": ["Thank you for shopping with us!", "Visit us again soon."]
    }'::jsonb;

-- ──────────────────────────────────────────────────────────────────────────────
-- 9) Align store_settings loyalty defaults to business rules
-- ──────────────────────────────────────────────────────────────────────────────
UPDATE store_settings
SET
    loyalty_point_threshold = 5000,
    loyalty_reward_amount   = 50.00
WHERE id = 1;

COMMENT ON COLUMN store_settings.loyalty_point_threshold IS '5000 points = 1 reward';
COMMENT ON COLUMN store_settings.loyalty_reward_amount IS '$50.00 reward per threshold';
