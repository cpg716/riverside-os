-- Full Wedding Manager parity fields (legacy SQLite app) on PostgreSQL.
-- Uses IF NOT EXISTS for safe application on mixed migration histories.

-- Party-level (contact, merchandising, soft delete)
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS party_type TEXT NOT NULL DEFAULT 'Wedding';
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS sign_up_date DATE;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS salesperson TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS style_info TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS price_info TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS groom_phone TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS groom_email TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS bride_name TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS bride_phone TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS bride_email TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS accessories JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS groom_phone_clean TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS bride_phone_clean TEXT;
ALTER TABLE wedding_parties ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- Member lifecycle + sizing (ties to ROS customers; POS uses wedding_member_id)
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS member_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS oot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS suit TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS waist TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS vest TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS shirt TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS shoe TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS measured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS suit_ordered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS received BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS fitting BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS pickup_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS measure_date DATE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS ordered_date DATE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS received_date DATE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS fitting_date DATE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS pickup_date DATE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS ordered_items JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS member_accessories JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS contact_history JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS pin_note BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS ordered_po TEXT;
ALTER TABLE wedding_members ADD COLUMN IF NOT EXISTS stock_info JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_wedding_parties_event_date ON wedding_parties (event_date);
CREATE INDEX IF NOT EXISTS idx_wedding_parties_salesperson ON wedding_parties (salesperson);
CREATE INDEX IF NOT EXISTS idx_wedding_parties_deleted ON wedding_parties (is_deleted);
CREATE INDEX IF NOT EXISTS idx_wedding_members_party_index ON wedding_members (wedding_party_id, member_index);

-- Appointments (scheduler parity with legacy app)
CREATE TABLE IF NOT EXISTS wedding_appointments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wedding_party_id UUID NOT NULL REFERENCES wedding_parties(id) ON DELETE CASCADE,
    wedding_member_id UUID NOT NULL REFERENCES wedding_members(id) ON DELETE CASCADE,
    customer_display_name TEXT,
    phone TEXT,
    appointment_type TEXT NOT NULL DEFAULT 'Measurement',
    starts_at TIMESTAMPTZ NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Scheduled',
    salesperson TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wedding_appts_starts ON wedding_appointments (starts_at);
CREATE INDEX IF NOT EXISTS idx_wedding_appts_party_member ON wedding_appointments (wedding_party_id, wedding_member_id);
