-- Wedding Manager integration bridge for ROS.
-- Adds normalized party/member/measurement tables and transactional linkage.

CREATE TABLE IF NOT EXISTS wedding_parties (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    party_name TEXT,
    groom_name TEXT NOT NULL,
    event_date DATE NOT NULL,
    venue TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wedding_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wedding_party_id UUID NOT NULL REFERENCES wedding_parties(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'prospect',
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (wedding_party_id, customer_id)
);

CREATE TABLE IF NOT EXISTS customer_measurements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    neck NUMERIC(5,2),
    sleeve NUMERIC(5,2),
    chest NUMERIC(5,2),
    waist NUMERIC(5,2),
    seat NUMERIC(5,2),
    inseam NUMERIC(5,2),
    outseam NUMERIC(5,2),
    shoulder NUMERIC(5,2),
    measured_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    measured_by UUID REFERENCES staff(id),
    notes TEXT,
    UNIQUE (customer_id)
);

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS wedding_member_id UUID REFERENCES wedding_members(id) ON DELETE SET NULL;

ALTER TABLE payment_transactions
    ADD COLUMN IF NOT EXISTS wedding_member_id UUID REFERENCES wedding_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wedding_members_party ON wedding_members (wedding_party_id);
CREATE INDEX IF NOT EXISTS idx_wedding_members_customer ON wedding_members (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_wedding_member_id ON orders (wedding_member_id);
CREATE INDEX IF NOT EXISTS idx_payment_tx_wedding_member_id ON payment_transactions (wedding_member_id);
