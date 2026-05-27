-- Migration 048: Constant Contact Integration

-- 1. Create table for customer marketing email events
CREATE TABLE IF NOT EXISTS customer_marketing_email_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES public.customers(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'constant_contact',
    event_type TEXT NOT NULL, -- sent, bounced, unsubscribed, opened, clicked
    occurred_at TIMESTAMPTZ NOT NULL,
    campaign_id TEXT,
    campaign_name TEXT,
    message_id TEXT,
    payload_digest TEXT,
    external_event_id TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for timeline fetching
CREATE INDEX IF NOT EXISTS idx_customer_marketing_email_event_customer ON customer_marketing_email_event(customer_id, occurred_at DESC);

-- 2. Create table for Constant Contact sync logs
CREATE TABLE IF NOT EXISTS constant_contact_sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    sync_type TEXT NOT NULL, -- contacts_push, activity_pull, etc.
    status TEXT NOT NULL, -- running, success, failed
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT
);
