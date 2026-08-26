-- Migration 207 was already applied before this historical repair-audit table
-- was designed. Keep the applied 207 bytes immutable and add the later schema
-- through this separate migration.

CREATE TABLE IF NOT EXISTS public.inventory_average_cost_line_repair_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_line_id uuid NOT NULL UNIQUE,
    transaction_id uuid NOT NULL,
    product_id uuid NOT NULL,
    variant_id uuid,
    catalog_handle text NOT NULL,
    prior_unit_cost numeric(12, 2) NOT NULL,
    corrected_unit_cost numeric(12, 2) NOT NULL,
    quantity integer NOT NULL,
    returned_quantity integer NOT NULL DEFAULT 0,
    effective_quantity integer NOT NULL,
    booked_at timestamptz NOT NULL,
    recognition_date date,
    cost_basis text NOT NULL,
    basis_event_date date,
    catalog_manifest_sha256 text NOT NULL,
    cost_event_manifest_sha256 text NOT NULL,
    line_manifest_sha256 text NOT NULL,
    repaired_by_staff_id uuid NOT NULL,
    repaired_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT inventory_average_cost_line_repair_costs_nonnegative
        CHECK (prior_unit_cost >= 0 AND corrected_unit_cost >= 0),
    CONSTRAINT inventory_average_cost_line_repair_quantities_valid
        CHECK (
            quantity > 0
            AND returned_quantity >= 0
            AND effective_quantity >= 0
            AND effective_quantity <= quantity
        )
);

COMMENT ON TABLE public.inventory_average_cost_line_repair_audit IS
    'Immutable evidence for exact ROS transaction-line repairs from Counterpoint historical AVG_COST changes; ambiguous lines are excluded.';
