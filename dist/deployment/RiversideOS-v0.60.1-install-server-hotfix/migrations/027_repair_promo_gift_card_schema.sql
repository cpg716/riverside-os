-- Repair promo gift-card schema drift.
--
-- Some launch databases have 009_promo_gift_cards.sql recorded in
-- ros_schema_migrations while the physical enum value/column are missing.
-- Keep this forward-only and idempotent so healthy databases no-op.

ALTER TYPE public.gift_card_kind ADD VALUE IF NOT EXISTS 'promo_gift_card';

ALTER TABLE public.gift_cards
    ADD COLUMN IF NOT EXISTS promo_event_name text;

COMMENT ON COLUMN public.gift_cards.promo_event_name IS
    'Optional event or giveaway name for promo gift cards.';

COMMENT ON COLUMN public.gift_cards.is_liability IS
    'True for purchased cards (liability at issue). False for loyalty_reward/donated_giveaway/promo_gift_card (expensed at redemption).';
