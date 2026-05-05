-- Loyalty Analytics Reporting Views for Metabase
-- Snapshot of current loyalty standing per customer
CREATE OR REPLACE VIEW view_loyalty_customer_snapshot AS
SELECT
    c.id as customer_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    c.loyalty_points as current_balance,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.delta_points > 0 AND lpl.reason = 'order_earn'), 0) as lifetime_earned_from_orders,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.delta_points < 0 AND lpl.reason = 'reward_redemption'), 0) * -1 as lifetime_points_redeemed,
    COALESCE(SUM(lpl.delta_points) FILTER (WHERE lpl.reason = 'manual_adjust'), 0) as net_manual_adjustments,
    COALESCE(COUNT(lri.id), 0) as rewards_issued_count,
    COALESCE(SUM(lri.reward_amount), 0) as total_reward_dollars_issued
FROM customers c
LEFT JOIN loyalty_point_ledger lpl ON c.id = lpl.customer_id
LEFT JOIN loyalty_reward_issuances lri ON c.id = lri.customer_id
GROUP BY c.id, c.customer_code, c.first_name, c.last_name, c.loyalty_points;

COMMENT ON VIEW view_loyalty_customer_snapshot IS 'High-level snapshot of loyalty metrics per customer for Metabase.';

-- Daily velocity: Earn vs Burn
CREATE OR REPLACE VIEW view_loyalty_daily_velocity AS
WITH daily_earn AS (
    SELECT
        (created_at AT TIME ZONE 'UTC')::date as event_date,
        SUM(delta_points) as points_earned
    FROM loyalty_point_ledger
    WHERE delta_points > 0
    GROUP BY 1
),
daily_burn AS (
    SELECT
        (created_at AT TIME ZONE 'UTC')::date as event_date,
        SUM(delta_points) * -1 as points_burned
    FROM loyalty_point_ledger
    WHERE delta_points < 0
    GROUP BY 1
),
all_dates AS (
    SELECT event_date FROM daily_earn
    UNION
    SELECT event_date FROM daily_burn
)
SELECT
    ad.event_date,
    COALESCE(de.points_earned, 0) as points_earned,
    COALESCE(db.points_burned, 0) as points_burned,
    COALESCE(de.points_earned, 0) - COALESCE(db.points_burned, 0) as net_velocity
FROM all_dates ad
LEFT JOIN daily_earn de ON ad.event_date = de.event_date
LEFT JOIN daily_burn db ON ad.event_date = db.event_date
ORDER BY ad.event_date DESC;

COMMENT ON VIEW view_loyalty_daily_velocity IS 'Daily time-series of loyalty points earned vs burned for Metabase line charts.';
