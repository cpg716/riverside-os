-- 050: Inventory Migration Workbench
-- Adds step-gated migration state and Counterpoint CSV reference tables.

-- ── Workbench step state ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS counterpoint_workbench_state (
    id integer PRIMARY KEY DEFAULT 1,

    step_data_sources_status   text NOT NULL DEFAULT 'pending',
    step_data_sources_approved_at   timestamptz,
    step_data_sources_approved_by   uuid REFERENCES staff(id),

    step_categories_status     text NOT NULL DEFAULT 'locked',
    step_categories_approved_at     timestamptz,
    step_categories_approved_by     uuid REFERENCES staff(id),

    step_vendors_status        text NOT NULL DEFAULT 'locked',
    step_vendors_approved_at        timestamptz,
    step_vendors_approved_by        uuid REFERENCES staff(id),

    step_catalog_status        text NOT NULL DEFAULT 'locked',
    step_catalog_approved_at        timestamptz,
    step_catalog_approved_by        uuid REFERENCES staff(id),

    step_sku_gaps_status       text NOT NULL DEFAULT 'locked',
    step_sku_gaps_approved_at       timestamptz,
    step_sku_gaps_approved_by       uuid REFERENCES staff(id),

    step_verification_status   text NOT NULL DEFAULT 'locked',
    step_verification_approved_at   timestamptz,
    step_verification_approved_by   uuid REFERENCES staff(id),

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT workbench_singleton CHECK (id = 1),
    CONSTRAINT workbench_step_data_sources_chk CHECK (step_data_sources_status IN ('pending','in_progress','complete')),
    CONSTRAINT workbench_step_categories_chk   CHECK (step_categories_status   IN ('locked','pending','in_progress','complete')),
    CONSTRAINT workbench_step_vendors_chk      CHECK (step_vendors_status      IN ('locked','pending','in_progress','complete')),
    CONSTRAINT workbench_step_catalog_chk      CHECK (step_catalog_status      IN ('locked','pending','in_progress','complete')),
    CONSTRAINT workbench_step_sku_gaps_chk     CHECK (step_sku_gaps_status     IN ('locked','pending','in_progress','complete')),
    CONSTRAINT workbench_step_verification_chk CHECK (step_verification_status IN ('locked','pending','in_progress','complete'))
);

INSERT INTO counterpoint_workbench_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Counterpoint CSV reference (uploaded from desktop export) ─────────────────

CREATE TABLE IF NOT EXISTS counterpoint_csv_reference_batches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file_name text NOT NULL,
    source_file_hash text NOT NULL,
    row_count       integer NOT NULL DEFAULT 0,
    status          text NOT NULL DEFAULT 'active',
    imported_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cp_csv_batch_status_chk CHECK (status IN ('active','replaced','discarded'))
);

CREATE TABLE IF NOT EXISTS counterpoint_csv_reference_rows (
    id                bigserial PRIMARY KEY,
    batch_id          uuid NOT NULL REFERENCES counterpoint_csv_reference_batches(id) ON DELETE CASCADE,
    source_row_number integer NOT NULL CHECK (source_row_number > 0),
    item_no           text NOT NULL,
    description       text,
    long_description  text,
    category_code     text,
    barcode           text,
    retail_price      numeric,
    unit_cost         numeric,
    qty_on_hand       integer,
    vendor_no         text,
    is_grid           boolean DEFAULT false,
    raw_row           jsonb NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cp_csv_ref_rows_batch ON counterpoint_csv_reference_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_cp_csv_ref_rows_item  ON counterpoint_csv_reference_rows(item_no);
