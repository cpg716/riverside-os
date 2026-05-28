-- Customer notification queue for Ready for Pickup messages
-- Supports scheduled batch sending (9:30AM, 3:00PM Mon-Sat) and immediate "Send Now" override

CREATE TABLE IF NOT EXISTS customer_notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Target entity (order or alteration)
    entity_type TEXT NOT NULL CHECK (entity_type IN ('order', 'alteration')),
    entity_id UUID NOT NULL,

    -- Customer who should receive notification
    customer_id UUID NOT NULL REFERENCES customers(id),

    -- Notification kind
    kind TEXT NOT NULL CHECK (kind IN ('ready_for_pickup')),

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'sent', 'skipped', 'failed')),

    -- Scheduling
    scheduled_for TIMESTAMP WITH TIME ZONE,
    sent_at TIMESTAMP WITH TIME ZONE,

    -- Override flags
    send_immediately BOOLEAN DEFAULT FALSE,
    override_reason TEXT,

    -- Delivery tracking
    delivery_method TEXT CHECK (delivery_method IN ('sms', 'email', 'both')),
    delivery_status TEXT CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
    delivery_error TEXT,

    -- Metadata
    metadata JSONB DEFAULT '{}',

    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by_staff_id UUID REFERENCES staff(id)
);

-- Indexes for efficient queries
CREATE INDEX idx_notification_queue_status ON customer_notification_queue(status);
CREATE INDEX idx_notification_queue_scheduled_for ON customer_notification_queue(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX idx_notification_queue_customer ON customer_notification_queue(customer_id);
CREATE INDEX idx_notification_queue_entity ON customer_notification_queue(entity_type, entity_id);

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_notification_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_notification_queue_updated_at
    BEFORE UPDATE ON customer_notification_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_notification_queue_updated_at();

-- Function to queue a notification when an order line is marked ready
CREATE OR REPLACE FUNCTION queue_order_ready_notification(
    p_transaction_id UUID,
    p_customer_id UUID,
    p_staff_id UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_notification_id UUID;
BEGIN
    -- Check if notification already exists and not sent
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
    DO NOTHING
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;

-- Function to queue a notification when alteration is marked ready
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
    DO NOTHING
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql;

-- Function to mark notification as sent
CREATE OR REPLACE FUNCTION mark_notification_sent(
    p_notification_id UUID,
    p_delivery_method TEXT,
    p_delivery_status TEXT DEFAULT 'delivered',
    p_error TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE customer_notification_queue
    SET status = 'sent',
        sent_at = NOW(),
        delivery_method = p_delivery_method,
        delivery_status = p_delivery_status,
        delivery_error = p_error,
        updated_at = NOW()
    WHERE id = p_notification_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Function to schedule pending notifications for next batch
CREATE OR REPLACE FUNCTION schedule_pending_notifications(p_target_time TIMESTAMP WITH TIME ZONE) RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    UPDATE customer_notification_queue
    SET status = 'scheduled',
        scheduled_for = p_target_time,
        updated_at = NOW()
    WHERE status = 'pending'
      AND send_immediately = FALSE;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get pending notifications ready for sending
CREATE OR REPLACE FUNCTION get_notifications_to_send(p_current_time TIMESTAMP WITH TIME ZONE DEFAULT NOW())
RETURNS TABLE (
    id UUID,
    entity_type TEXT,
    entity_id UUID,
    customer_id UUID,
    kind TEXT,
    delivery_method TEXT,
    metadata JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cnq.id,
        cnq.entity_type,
        cnq.entity_id,
        cnq.customer_id,
        cnq.kind,
        cnq.delivery_method,
        cnq.metadata
    FROM customer_notification_queue cnq
    WHERE cnq.status = 'scheduled'
      AND cnq.scheduled_for <= p_current_time
    ORDER BY cnq.scheduled_for ASC;
END;
$$ LANGUAGE plpgsql;

-- Function to override and send immediately
CREATE OR REPLACE FUNCTION override_send_immediately(
    p_notification_id UUID,
    p_reason TEXT,
    p_staff_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE customer_notification_queue
    SET send_immediately = TRUE,
        override_reason = p_reason,
        status = 'pending',
        scheduled_for = NULL,
        updated_at = NOW(),
        created_by_staff_id = p_staff_id
    WHERE id = p_notification_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;
