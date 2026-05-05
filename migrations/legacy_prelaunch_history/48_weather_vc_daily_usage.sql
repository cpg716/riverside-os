-- Tracks Visual Crossing Timeline HTTP calls per UTC calendar day (enforced in app; default cap 850, max 900).

CREATE TABLE IF NOT EXISTS weather_vc_daily_usage (
    usage_date DATE NOT NULL PRIMARY KEY,
    pull_count INTEGER NOT NULL DEFAULT 0 CHECK (pull_count >= 0)
);
