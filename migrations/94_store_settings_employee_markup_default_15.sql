-- Default employee sale price: cost × (1 + markup%). Product default is 15% (was 25% in legacy bootstrap).
-- Existing stores left at 25.0 are nudged to 15.0; customized values unchanged.

ALTER TABLE store_settings
    ALTER COLUMN employee_markup_percent SET DEFAULT 15.0;

UPDATE store_settings
SET employee_markup_percent = 15.0
WHERE id = 1
  AND employee_markup_percent = 25.0;

COMMENT ON COLUMN store_settings.employee_markup_percent IS
    'Default whole percent added to cost for employee sale unit price (cost × (1 + pct/100)); per-product may override.';
