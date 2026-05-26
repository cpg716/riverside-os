-- Migration 047: Phase 4 Resiliency Hardening

-- 1. Add 'processing' status to order_status enum
-- To execute this safely without blocking transactions, we check if it already exists.
-- PostgreSQL allows adding values to enums. Since ALTER TYPE ADD VALUE cannot run inside a multi-statement transaction in older Postgres versions, we do it carefully.
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'processing';

-- 2. Add checkout_client_id column to payment_provider_attempts table
ALTER TABLE payment_provider_attempts ADD COLUMN IF NOT EXISTS checkout_client_id UUID;

-- 3. Create qbo_sync_outbox table
CREATE TABLE IF NOT EXISTS qbo_sync_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, synced, failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for outbox status polling
CREATE INDEX IF NOT EXISTS idx_qbo_sync_outbox_status ON qbo_sync_outbox(status);
