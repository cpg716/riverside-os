-- Migration 176: Alterations Smart Scheduler Foundation
-- Adds structured units, fitting dates, and unifies appointments for alterations.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alteration_bucket') THEN
        CREATE TYPE alteration_bucket AS ENUM ('jacket', 'pant', 'other');
    END IF;
END $$;

-- 1. Generalize wedding_appointments to support standalone fittings
ALTER TABLE wedding_appointments 
    ALTER COLUMN wedding_party_id DROP NOT NULL,
    ALTER COLUMN wedding_member_id DROP NOT NULL;

-- 2. Enhance alteration_orders for scheduling
ALTER TABLE alteration_orders
    ADD COLUMN IF NOT EXISTS fitting_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES wedding_appointments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS total_units_jacket INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_units_pant INTEGER DEFAULT 0;

-- 3. Structured work items for garments
CREATE TABLE IF NOT EXISTS alteration_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alteration_order_id UUID NOT NULL REFERENCES alteration_orders(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    capacity_bucket alteration_bucket NOT NULL DEFAULT 'other',
    units INTEGER NOT NULL DEFAULT 1,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alteration_order_items_order_id ON alteration_order_items(alteration_order_id);
CREATE INDEX IF NOT EXISTS idx_alteration_orders_fitting_at ON alteration_orders(fitting_at);
CREATE INDEX IF NOT EXISTS idx_alteration_orders_appointment_id ON alteration_orders(appointment_id);

-- 4. Audit trail for scheduling actions
-- Activity actions will include 'schedule_fitting', 'add_work_item', 'complete_work_item'
