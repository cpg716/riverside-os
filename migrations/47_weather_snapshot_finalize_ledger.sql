-- Ledger so we run end-of-day weather snapshot refresh at most once per store-local calendar day.

CREATE TABLE IF NOT EXISTS weather_snapshot_finalize_ledger (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_completed_store_date DATE NOT NULL DEFAULT '1970-01-01'
);

INSERT INTO weather_snapshot_finalize_ledger (id, last_completed_store_date)
VALUES (1, '1970-01-01'::date)
ON CONFLICT (id) DO NOTHING;
