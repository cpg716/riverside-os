-- AI platform: pgvector (forward-compat embeddings), staff doc chunks (FTS + optional vector), saved NL report specs, duplicate review queue, RBAC.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ai_doc_chunk (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_path TEXT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
    embedding vector(384),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_ai_doc_chunk_tsv ON ai_doc_chunk USING GIN (content_tsv);

COMMENT ON TABLE ai_doc_chunk IS 'Staff help corpus chunks for POST /api/ai/help; retrieve via FTS (embedding optional).';

CREATE TABLE IF NOT EXISTS ai_saved_report (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    spec_version INT NOT NULL DEFAULT 1,
    spec JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_saved_report_staff ON ai_saved_report (staff_id, updated_at DESC);

COMMENT ON TABLE ai_saved_report IS 'Per-staff saved NL report specs (metadata only); execute via whitelisted /api/ai/reports/execute.';

CREATE TABLE IF NOT EXISTS customer_duplicate_review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    customer_a_id UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    customer_b_id UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    score NUMERIC NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed', 'merged')),
    CONSTRAINT customer_duplicate_pair_order CHECK (customer_a_id < customer_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_duplicate_review_queue_pair_uq
    ON customer_duplicate_review_queue (customer_a_id, customer_b_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS customer_duplicate_review_queue_pending
    ON customer_duplicate_review_queue (created_at DESC)
    WHERE status = 'pending';

COMMENT ON TABLE customer_duplicate_review_queue IS 'Staff duplicate review queue (Pillar 5b); merge executes via existing /api/customers/merge.';

-- RBAC: ai_assist (help/chat surface), ai_reports (NL reporting umbrella + /api/ai/reports/*), customers_duplicate_review
INSERT INTO staff_role_permission (role, permission_key, allowed) VALUES
    ('admin', 'ai_assist', true),
    ('admin', 'ai_reports', true),
    ('admin', 'customers_duplicate_review', true),
    ('salesperson', 'ai_assist', true),
    ('salesperson', 'ai_reports', false),
    ('salesperson', 'customers_duplicate_review', false),
    ('sales_support', 'ai_assist', true),
    ('sales_support', 'ai_reports', false),
    ('sales_support', 'customers_duplicate_review', false)
ON CONFLICT (role, permission_key) DO NOTHING;
