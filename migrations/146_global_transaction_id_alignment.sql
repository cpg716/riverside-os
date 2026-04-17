-- Migration 146: Global Transaction ID and Table Alignment
-- This migration completes the v0.2.0 "Order" -> "Transaction" refactor across all audit and ledger tables.

DO $$ 
BEGIN
    -- 1. Table Renames (order_* -> transaction_*)
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'order_attribution_audit') THEN
        ALTER TABLE order_attribution_audit RENAME TO transaction_attribution_audit;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'order_coupon_redemptions') THEN
        ALTER TABLE order_coupon_redemptions RENAME TO transaction_coupon_redemptions;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'order_loyalty_accrual') THEN
        ALTER TABLE order_loyalty_accrual RENAME TO transaction_loyalty_accrual;
    END IF;

    -- 2. Column Renames (order_id -> transaction_id)
    -- discount_event_usage
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'discount_event_usage' AND column_name = 'order_id') THEN
        ALTER TABLE discount_event_usage RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- customer_open_deposit_ledger
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'customer_open_deposit_ledger' AND column_name = 'order_id') THEN
        ALTER TABLE customer_open_deposit_ledger RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- layaway_activity_log
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'layaway_activity_log' AND column_name = 'order_id') THEN
        ALTER TABLE layaway_activity_log RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- loyalty_point_ledger
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'loyalty_point_ledger' AND column_name = 'order_id') THEN
        ALTER TABLE loyalty_point_ledger RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- loyalty_reward_issuances
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'loyalty_reward_issuances' AND column_name = 'order_id') THEN
        ALTER TABLE loyalty_reward_issuances RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- transaction_attribution_audit (renamed above)
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_attribution_audit' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_attribution_audit RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- transaction_coupon_redemptions (renamed above)
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_coupon_redemptions' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_coupon_redemptions RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- store_credit_ledger
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'store_credit_ledger' AND column_name = 'order_id') THEN
        ALTER TABLE store_credit_ledger RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- suit_component_swap_events
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'suit_component_swap_events' AND column_name = 'order_id') THEN
        ALTER TABLE suit_component_swap_events RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- transaction_loyalty_accrual (renamed above)
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transaction_loyalty_accrual' AND column_name = 'order_id') THEN
        ALTER TABLE transaction_loyalty_accrual RENAME COLUMN order_id TO transaction_id;
    END IF;
    -- gift_card_events
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'gift_card_events' AND column_name = 'order_id') THEN
        ALTER TABLE gift_card_events RENAME COLUMN order_id TO transaction_id;
    END IF;

END $$;

INSERT INTO ros_schema_migrations (version) VALUES ('146_global_transaction_id_alignment.sql')
ON CONFLICT (version) DO NOTHING;
