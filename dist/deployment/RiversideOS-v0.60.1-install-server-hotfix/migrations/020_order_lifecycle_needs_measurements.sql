-- Add a pre-NTBO lifecycle state for wedding/order placeholders that need measurements.

ALTER TYPE order_item_lifecycle_status
    ADD VALUE IF NOT EXISTS 'needs_measurements' BEFORE 'ntbo';
