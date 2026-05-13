-- First-class ordered-item lifecycle and NTBO workflow foundation.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_item_lifecycle_status') THEN
        CREATE TYPE order_item_lifecycle_status AS ENUM (
            'ntbo',
            'ordered',
            'received',
            'ready_for_pickup',
            'picked_up'
        );
    END IF;
END $$;

ALTER TABLE transaction_lines
    ADD COLUMN IF NOT EXISTS order_lifecycle_status order_item_lifecycle_status NOT NULL DEFAULT 'ntbo',
    ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ordered_by UUID,
    ADD COLUMN IF NOT EXISTS po_id UUID,
    ADD COLUMN IF NOT EXISTS po_line_id UUID,
    ADD COLUMN IF NOT EXISTS vendor_id UUID,
    ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS received_by UUID,
    ADD COLUMN IF NOT EXISTS ready_for_pickup_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ready_for_pickup_by UUID,
    ADD COLUMN IF NOT EXISTS picked_up_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS picked_up_by UUID,
    ADD COLUMN IF NOT EXISTS wedding_id UUID,
    ADD COLUMN IF NOT EXISTS wedding_date DATE,
    ADD COLUMN IF NOT EXISTS vendor_eta DATE,
    ADD COLUMN IF NOT EXISTS vendor_reference TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_ordered_by_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_ordered_by_fkey
            FOREIGN KEY (ordered_by) REFERENCES staff(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_po_id_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_po_id_fkey
            FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_po_line_id_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_po_line_id_fkey
            FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_vendor_id_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_vendor_id_fkey
            FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_received_by_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_received_by_fkey
            FOREIGN KEY (received_by) REFERENCES staff(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_ready_for_pickup_by_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_ready_for_pickup_by_fkey
            FOREIGN KEY (ready_for_pickup_by) REFERENCES staff(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_picked_up_by_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_picked_up_by_fkey
            FOREIGN KEY (picked_up_by) REFERENCES staff(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transaction_lines_wedding_id_fkey'
    ) THEN
        ALTER TABLE transaction_lines
            ADD CONSTRAINT transaction_lines_wedding_id_fkey
            FOREIGN KEY (wedding_id) REFERENCES wedding_parties(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS transaction_line_lifecycle_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_line_id UUID NOT NULL REFERENCES transaction_lines(id) ON DELETE CASCADE,
    old_status order_item_lifecycle_status,
    new_status order_item_lifecycle_status NOT NULL,
    actor_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
    source_workflow TEXT NOT NULL,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

UPDATE transaction_lines tl
SET
    wedding_id = wm.wedding_party_id,
    wedding_date = wp.event_date
FROM transactions t
JOIN wedding_members wm ON wm.id = t.wedding_member_id
JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
WHERE tl.transaction_id = t.id
  AND (tl.wedding_id IS NULL OR tl.wedding_date IS NULL);

UPDATE transaction_lines tl
SET
    order_lifecycle_status = CASE
        WHEN tl.is_fulfilled = TRUE THEN 'picked_up'::order_item_lifecycle_status
        WHEN EXISTS (
            SELECT 1
            FROM fulfillment_orders fo
            WHERE fo.id = tl.fulfillment_order_id
              AND fo.status = 'ready'
        ) THEN 'ready_for_pickup'::order_item_lifecycle_status
        WHEN tl.fulfillment::text <> 'takeaway' THEN 'ntbo'::order_item_lifecycle_status
        ELSE 'picked_up'::order_item_lifecycle_status
    END,
    picked_up_at = CASE
        WHEN tl.is_fulfilled = TRUE THEN COALESCE(tl.fulfilled_at, tl.picked_up_at)
        ELSE tl.picked_up_at
    END
FROM transactions t
WHERE tl.transaction_id = t.id
  AND (
      tl.order_lifecycle_status = 'ntbo'
      OR tl.is_fulfilled = TRUE
      OR EXISTS (
          SELECT 1
          FROM fulfillment_orders fo
          WHERE fo.id = tl.fulfillment_order_id
            AND fo.status = 'ready'
      )
      OR tl.fulfillment::text = 'takeaway'
  );

INSERT INTO transaction_line_lifecycle_events (
    transaction_line_id,
    old_status,
    new_status,
    source_workflow,
    reason,
    metadata,
    created_at
)
SELECT
    tl.id,
    NULL,
    tl.order_lifecycle_status,
    'migration_backfill',
    'Conservative lifecycle initialization',
    jsonb_build_object('migration', '018_order_item_lifecycle'),
    CURRENT_TIMESTAMP
FROM transaction_lines tl
WHERE tl.fulfillment::text <> 'takeaway'
  AND NOT EXISTS (
      SELECT 1
      FROM transaction_line_lifecycle_events e
      WHERE e.transaction_line_id = tl.id
        AND e.source_workflow = 'migration_backfill'
  );

CREATE INDEX IF NOT EXISTS idx_transaction_lines_lifecycle_status
    ON transaction_lines(order_lifecycle_status, need_by_date, id)
    WHERE fulfillment <> 'takeaway'::fulfillment_type;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_lifecycle_vendor
    ON transaction_lines(vendor_id, order_lifecycle_status, need_by_date, id)
    WHERE fulfillment <> 'takeaway'::fulfillment_type;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_lifecycle_po_line
    ON transaction_lines(po_line_id)
    WHERE po_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_lines_lifecycle_wedding
    ON transaction_lines(wedding_id, order_lifecycle_status, need_by_date, id)
    WHERE wedding_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_line_lifecycle_events_line_created
    ON transaction_line_lifecycle_events(transaction_line_id, created_at DESC);

INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'orders.lifecycle_manage', true),
    ('sales_support', 'orders.lifecycle_manage', true),
    ('salesperson', 'orders.lifecycle_manage', false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;
