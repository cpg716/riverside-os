-- Add promo flag for "Buy 5, Get 1 Free" rule
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS is_free_suit_promo BOOLEAN DEFAULT FALSE;

-- Analytics view for Wedding Party Economics
CREATE OR REPLACE VIEW reporting.wedding_party_economics AS
SELECT
    wm.wedding_party_id,
    COUNT(DISTINCT wm.id) AS member_count,
    COUNT(DISTINCT o.id) AS order_count,
    SUM(oi.quantity * oi.unit_price) AS total_revenue,
    SUM(oi.quantity * oi.unit_cost) AS total_cost,
    SUM(oi.quantity * (oi.unit_price - oi.unit_cost)) AS total_profit,
    SUM(CASE WHEN wm.is_free_suit_promo THEN 1 ELSE 0 END) AS free_suits_marked,
    -- Margin Calculation
    CASE 
        WHEN SUM(oi.quantity * oi.unit_price) > 0 
        THEN (SUM(oi.quantity * (oi.unit_price - oi.unit_cost)) / SUM(oi.quantity * oi.unit_price)) * 100
        ELSE 0 
    END AS margin_percent
FROM wedding_members wm
LEFT JOIN orders o ON o.wedding_member_id = wm.id AND o.status <> 'cancelled'
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY wm.wedding_party_id;

GRANT SELECT ON reporting.wedding_party_economics TO metabase_ro;

INSERT INTO ros_schema_migrations (version) VALUES ('126_wedding_promo_and_analytics.sql')
ON CONFLICT (version) DO NOTHING;
