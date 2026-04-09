-- Counterpoint bridge: variant lineage + sync run bookkeeping (migration 29).

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS counterpoint_item_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_counterpoint_item_key_uidx
    ON product_variants (counterpoint_item_key)
    WHERE counterpoint_item_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS counterpoint_sync_runs (
    id          BIGSERIAL PRIMARY KEY,
    entity      TEXT NOT NULL,
    cursor_value TEXT,
    last_ok_at  TIMESTAMPTZ,
    last_error  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS counterpoint_sync_runs_entity_uidx
    ON counterpoint_sync_runs (entity);
