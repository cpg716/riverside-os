-- Expand customer notification tracking into a reviewable customer notification center.

ALTER TABLE customer_notification_queue
    DROP CONSTRAINT IF EXISTS customer_notification_queue_entity_type_check,
    DROP CONSTRAINT IF EXISTS customer_notification_queue_kind_check;

DROP INDEX IF EXISTS idx_notification_queue_entity_kind_status_unique;

ALTER TABLE customer_notification_queue
    ADD CONSTRAINT customer_notification_queue_entity_type_check
        CHECK (entity_type IN ('order', 'alteration', 'appointment', 'transaction', 'customer')),
    ADD CONSTRAINT customer_notification_queue_kind_check
        CHECK (kind IN (
            'ready_for_pickup',
            'alteration_ready',
            'appointment_confirmation',
            'appointment_reminder',
            'receipt',
            'unknown_sender_welcome',
            'review_invite'
        ));

ALTER TABLE customer_notification_queue
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS reviewed_by_staff_id UUID REFERENCES staff(id),
    ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE INDEX IF NOT EXISTS idx_notification_queue_reviewed_at
    ON customer_notification_queue(reviewed_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_queue_pending_unique
    ON customer_notification_queue(entity_type, entity_id, kind, status)
    WHERE status IN ('pending', 'scheduled');

CREATE OR REPLACE FUNCTION queue_appointment_confirmation_notification(
    p_appointment_id UUID,
    p_customer_id UUID,
    p_staff_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'
) RETURNS UUID AS $$
DECLARE
    v_notification_id UUID;
BEGIN
    INSERT INTO customer_notification_queue (
        entity_type,
        entity_id,
        customer_id,
        kind,
        status,
        delivery_method,
        created_by_staff_id,
        metadata
    ) VALUES (
        'appointment',
        p_appointment_id,
        p_customer_id,
        'appointment_confirmation',
        'pending',
        'both',
        p_staff_id,
        COALESCE(p_metadata, '{}') || jsonb_build_object('auto_queued', true)
    )
    ON CONFLICT (entity_type, entity_id, kind, status)
    DO NOTHING
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;
