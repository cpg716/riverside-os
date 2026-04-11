-- Migration 128: Commission Rules and SPIFF Program Infrastructure
-- This migration adds support for granular commission overrides (Variant > Product > Category)
-- and multi-item "Combo" SPIFF rewards (e.g. Suit + Tie + Shirt bundles).

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'is_internal') THEN
        ALTER TABLE order_items ADD COLUMN is_internal BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- 1) Line-Item Commission Rules (Overrides and Flat SPIFFs)
CREATE TABLE IF NOT EXISTS commission_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- specificity: variant > product > category
    match_type TEXT NOT NULL CHECK (match_type IN ('category', 'product', 'variant')),
    match_id UUID NOT NULL,
    -- Rate override (e.g. 0.10 for 10% instead of staff base)
    override_rate DECIMAL(14, 4),
    -- Flat bonus on top of rate
    fixed_spiff_amount DECIMAL(14, 2) DEFAULT 0,
    label TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_rules_match ON commission_rules (match_type, match_id) WHERE is_active = TRUE;

-- 2) Combo Rewards (Set-based incentives)
CREATE TABLE IF NOT EXISTS commission_combo_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL,
    reward_amount DECIMAL(14, 2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3) Combo Rule Requirements
CREATE TABLE IF NOT EXISTS commission_combo_rule_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID REFERENCES commission_combo_rules(id) ON DELETE CASCADE,
    match_type TEXT NOT NULL CHECK (match_type IN ('category', 'product')),
    match_id UUID NOT NULL,
    qty_required INT NOT NULL DEFAULT 1
);

INSERT INTO ros_schema_migrations (version) VALUES ('128_commission_spiff_program.sql') ON CONFLICT (version) DO NOTHING;
