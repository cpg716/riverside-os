-- Migration 145: Schema Repair for RMS and Podium
-- 1. Rename order_id to transaction_id in pos_rms_charge_record
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'pos_rms_charge_record' AND column_name = 'order_id') THEN
        ALTER TABLE pos_rms_charge_record RENAME COLUMN order_id TO transaction_id;
    END IF;
END $$;

-- 2. Backfill missing transaction display_ids (for rows created before the trigger/v0.2.0)
-- We use a simple loop or a CTE to assign TXN-IDs.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM transactions WHERE display_id IS NULL ORDER BY booked_at ASC LOOP
        UPDATE transactions 
        SET display_id = 'TXN-' || nextval('transaction_display_id_seq')::text
        WHERE id = r.id;
    END LOOP;
END $$;

-- 3. Ensure Podium list logic is robust against missing data
-- (The Rust logic is being updated, but database constraints help)
ALTER TABLE transactions ALTER COLUMN display_id SET NOT NULL;

INSERT INTO ros_schema_migrations (version) VALUES ('145_schema_repair_rms_and_podium.sql')
ON CONFLICT (version) DO NOTHING;
