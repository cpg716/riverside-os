-- Keep loyalty reward readiness aligned with the Elite Rewards rule:
-- 5000 points is the minimum threshold for issuing one reward gift card.
ALTER TABLE store_settings
    ALTER COLUMN loyalty_point_threshold SET DEFAULT 5000;

UPDATE store_settings
SET loyalty_point_threshold = 5000
WHERE loyalty_point_threshold IS NULL
   OR loyalty_point_threshold < 5000;

COMMENT ON COLUMN public.store_settings.loyalty_point_threshold IS
    'Minimum 5000 points = 1 reward';
