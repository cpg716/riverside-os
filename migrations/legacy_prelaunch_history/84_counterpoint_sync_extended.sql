-- Counterpoint sync extended: heartbeat, ticket idempotency, mapping tables,
-- sync requests/issues, gift-card reason map (migration 84).
-- Depends on: 29_counterpoint_sync, 23_gift_cards_and_loyalty, 01_initial_schema.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1) Bridge heartbeat singleton
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counterpoint_bridge_heartbeat (
    id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bridge_phase TEXT NOT NULL DEFAULT 'idle',
    current_entity TEXT,
    bridge_version TEXT,
    bridge_hostname TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO counterpoint_bridge_heartbeat (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2) Ticket idempotency on orders
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS counterpoint_ticket_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_counterpoint_ticket_ref_uidx
    ON orders (counterpoint_ticket_ref)
    WHERE counterpoint_ticket_ref IS NOT NULL;

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS is_counterpoint_import BOOLEAN NOT NULL DEFAULT FALSE;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3) Sync request queue (admin can request a run; bridge polls)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counterpoint_sync_request (
    id          BIGSERIAL PRIMARY KEY,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requested_by UUID REFERENCES staff(id) ON DELETE SET NULL,
    entity      TEXT,
    acked_at    TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4) Sync issues (per-row problems surfaced in the Settings console)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counterpoint_sync_issue (
    id          BIGSERIAL PRIMARY KEY,
    entity      TEXT NOT NULL,
    external_key TEXT,
    severity    TEXT NOT NULL DEFAULT 'warning',
    message     TEXT NOT NULL,
    resolved    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS counterpoint_sync_issue_unresolved_idx
    ON counterpoint_sync_issue (entity, created_at DESC)
    WHERE NOT resolved;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5) Mapping tables (category, payment method, gift-card reason)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counterpoint_category_map (
    id              BIGSERIAL PRIMARY KEY,
    cp_category     TEXT NOT NULL UNIQUE,
    ros_category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS counterpoint_payment_method_map (
    id             BIGSERIAL PRIMARY KEY,
    cp_pmt_typ     TEXT NOT NULL UNIQUE,
    ros_method     TEXT NOT NULL DEFAULT 'cash',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO counterpoint_payment_method_map (cp_pmt_typ, ros_method) VALUES
    ('CASH', 'cash'),
    ('CHECK', 'check'),
    ('CREDIT CARD', 'credit_card'),
    ('DEBIT', 'credit_card'),
    ('GIFT CERT', 'gift_card'),
    ('ON ACCOUNT', 'on_account')
ON CONFLICT (cp_pmt_typ) DO NOTHING;

CREATE TABLE IF NOT EXISTS counterpoint_gift_reason_map (
    id             BIGSERIAL PRIMARY KEY,
    cp_reason_cod  TEXT NOT NULL UNIQUE,
    ros_card_kind  TEXT NOT NULL DEFAULT 'purchased',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────────────────────
-- 6) Track migration in ledger
-- ──────────────────────────────────────────────────────────────────────────────
INSERT INTO ros_schema_migrations (version) VALUES ('84_counterpoint_sync_extended.sql')
ON CONFLICT (version) DO NOTHING;
