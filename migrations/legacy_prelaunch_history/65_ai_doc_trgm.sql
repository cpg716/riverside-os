-- Hybrid lexical retrieval for staff help: PostgreSQL pg_trgm + existing FTS on ai_doc_chunk.
-- Complements migration 62 (vector column optional for future dense embeddings).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_ai_doc_chunk_content_trgm
    ON ai_doc_chunk USING gin (content gin_trgm_ops);

COMMENT ON INDEX idx_ai_doc_chunk_content_trgm IS 'Trigram similarity for ROS-AI help when FTS misses (docs/staff corpus).';
