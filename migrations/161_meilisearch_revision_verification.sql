-- Persist revision-based authority proof for derived Meilisearch indexes.
-- PostgreSQL remains authoritative whenever an index has not been recently verified.

ALTER TABLE meilisearch_sync_status
    ADD COLUMN IF NOT EXISTS source_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS indexed_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS verified_revision BIGINT,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verification_state TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS verification_detail TEXT,
    ADD COLUMN IF NOT EXISTS verified_source_count BIGINT,
    ADD COLUMN IF NOT EXISTS verified_document_count BIGINT;

UPDATE meilisearch_sync_status
SET source_revision = CASE WHEN is_success THEN 1 ELSE 0 END,
    indexed_revision = CASE WHEN is_success THEN 1 ELSE 0 END,
    verification_state = CASE WHEN is_success THEN 'pending' ELSE 'failed' END
WHERE source_revision = 0
  AND indexed_revision = 0;
