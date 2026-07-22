-- Restore notification queue idempotency after migration 067 replaced the
-- full unique index with a partial unique index for active queue rows.

CREATE OR REPLACE FUNCTION queue_order_ready_notification(
    p_transaction_id UUID,
    p_customer_id UUID,
    p_staff_id UUID DEFAULT NULL
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
        'order',
        p_transaction_id,
        p_customer_id,
        'ready_for_pickup',
        'pending',
        'both',
        p_staff_id,
        jsonb_build_object('auto_queued', true)
    )
    ON CONFLICT (entity_type, entity_id, kind, status)
        WHERE status IN ('pending', 'scheduled')
    DO NOTHING
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION queue_alteration_ready_notification(
    p_alteration_id UUID,
    p_customer_id UUID,
    p_staff_id UUID DEFAULT NULL
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
        'alteration',
        p_alteration_id,
        p_customer_id,
        'ready_for_pickup',
        'pending',
        'both',
        p_staff_id,
        jsonb_build_object('auto_queued', true)
    )
    ON CONFLICT (entity_type, entity_id, kind, status)
        WHERE status IN ('pending', 'scheduled')
    DO NOTHING
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;

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
        WHERE status IN ('pending', 'scheduled')
    DO NOTHING
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;
