-- Per-role maximum line discount (% off standard retail) enforced at checkout for price overrides.

CREATE TABLE IF NOT EXISTS staff_role_pricing_limits (
    role staff_role PRIMARY KEY,
    max_discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 30.00,
    CONSTRAINT staff_role_pricing_limits_pct
        CHECK (max_discount_percent >= 0::numeric AND max_discount_percent <= 100::numeric)
);

COMMENT ON TABLE staff_role_pricing_limits IS 'POS price-override discount cap vs catalog retail per staff_role; admin row typically 100.';

INSERT INTO staff_role_pricing_limits (role, max_discount_percent) VALUES
    ('admin', 100.00),
    ('salesperson', 30.00),
    ('sales_support', 30.00)
ON CONFLICT (role) DO NOTHING;
