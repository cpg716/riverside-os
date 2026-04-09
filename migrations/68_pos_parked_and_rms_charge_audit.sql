-- Server-backed register parked sales (auditable) + RMS / RMS90 charge ledger for R2S follow-up and reporting.

CREATE TYPE pos_parked_sale_status AS ENUM ('parked', 'recalled', 'deleted');

CREATE TABLE pos_parked_sale (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    register_session_id UUID NOT NULL REFERENCES register_sessions (id) ON DELETE CASCADE,
    parked_by_staff_id UUID NOT NULL REFERENCES staff (id),
    customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
    label TEXT NOT NULL DEFAULT '',
    payload_json JSONB NOT NULL,
    status pos_parked_sale_status NOT NULL DEFAULT 'parked',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    recalled_at TIMESTAMPTZ,
    recalled_by_staff_id UUID REFERENCES staff (id),
    deleted_at TIMESTAMPTZ,
    deleted_by_staff_id UUID REFERENCES staff (id)
);

CREATE INDEX idx_pos_parked_sale_session_parked
    ON pos_parked_sale (register_session_id, status)
    WHERE status = 'parked';

CREATE INDEX idx_pos_parked_sale_customer_parked
    ON pos_parked_sale (customer_id)
    WHERE status = 'parked';

CREATE TABLE pos_parked_sale_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    register_session_id UUID NOT NULL,
    parked_sale_id UUID REFERENCES pos_parked_sale (id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    actor_staff_id UUID NOT NULL REFERENCES staff (id),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pos_parked_sale_audit_session_created
    ON pos_parked_sale_audit (register_session_id, created_at DESC);

CREATE INDEX idx_pos_parked_sale_audit_sale
    ON pos_parked_sale_audit (parked_sale_id, created_at DESC);

CREATE TABLE pos_rms_charge_record (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    register_session_id UUID NOT NULL REFERENCES register_sessions (id),
    customer_id UUID REFERENCES customers (id) ON DELETE SET NULL,
    payment_method TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL,
    operator_staff_id UUID REFERENCES staff (id) ON DELETE SET NULL,
    payment_transaction_id UUID REFERENCES payment_transactions (id) ON DELETE SET NULL,
    customer_display TEXT,
    order_short_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pos_rms_charge_record_pay_tx_uq
    ON pos_rms_charge_record (payment_transaction_id)
    WHERE payment_transaction_id IS NOT NULL;

CREATE INDEX idx_pos_rms_charge_record_created
    ON pos_rms_charge_record (created_at DESC);

CREATE INDEX idx_pos_rms_charge_record_method
    ON pos_rms_charge_record (payment_method);

CREATE INDEX idx_pos_rms_charge_record_customer
    ON pos_rms_charge_record (customer_id);

COMMENT ON TABLE pos_parked_sale IS 'Register parked cart snapshots; scoped to open register_session_id.';
COMMENT ON TABLE pos_parked_sale_audit IS 'Append-style audit for park / recall / delete; register_session_id retained if parked row is removed.';
COMMENT ON TABLE pos_rms_charge_record IS 'RMS and RMS90 tender lines for R2S charge workflow and insights reporting.';
