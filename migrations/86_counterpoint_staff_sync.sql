-- Counterpoint staff sync: mapping table, provenance on staff, customer preferred rep.

-- 1) Mapping table: CP USR_ID / SLS_REP → ROS staff.id
-- Both SY_USR and PS_SLS_REP may share a code or be separate people.
-- cp_source: 'user' or 'sales_rep' (or 'buyer').
CREATE TABLE IF NOT EXISTS counterpoint_staff_map (
    id              BIGSERIAL PRIMARY KEY,
    cp_code         TEXT NOT NULL,
    cp_source       TEXT NOT NULL DEFAULT 'user',
    ros_staff_id    UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cp_code, cp_source)
);

CREATE INDEX IF NOT EXISTS counterpoint_staff_map_code_idx
    ON counterpoint_staff_map (cp_code);

-- 2) Provenance columns on staff (optional; NULL = ROS-native).
ALTER TABLE staff ADD COLUMN IF NOT EXISTS data_source TEXT;
COMMENT ON COLUMN staff.data_source IS
    'NULL = created in ROS; ''counterpoint'' = imported from Counterpoint sync.';

ALTER TABLE staff ADD COLUMN IF NOT EXISTS counterpoint_user_id TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS counterpoint_sls_rep TEXT;

-- 3) Customer preferred salesperson (AR_CUST.SLS_REP → home rep).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_salesperson_id UUID REFERENCES staff(id) ON DELETE SET NULL;

-- 4) Orders: who rang up the sale (USR_ID → cashier/processed-by).
-- primary_salesperson_id already exists for commission recipient (SLS_REP).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS processed_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL;
COMMENT ON COLUMN orders.processed_by_staff_id IS
    'Staff who processed/rang up the sale (Counterpoint USR_ID or ROS cashier).';

-- 5) Track in ledger.
INSERT INTO ros_schema_migrations (version) VALUES ('86_counterpoint_staff_sync.sql')
ON CONFLICT (version) DO NOTHING;
