-- Counterpoint: optional IM_PRC retail tiers on variants + category master ingest support (bridge POST).
-- Category rows + counterpoint_category_map are populated by /api/sync/counterpoint/category-masters (not this file).

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS counterpoint_prc_2 NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS counterpoint_prc_3 NUMERIC(12, 2);

COMMENT ON COLUMN product_variants.counterpoint_prc_2 IS
    'Counterpoint IM_PRC.PRC_2 when synced (optional retail tier reference). Independent of ROS employee sale pricing (cost-plus).';
COMMENT ON COLUMN product_variants.counterpoint_prc_3 IS
    'Counterpoint IM_PRC.PRC_3 when synced (optional retail tier reference).';

INSERT INTO ros_schema_migrations (version) VALUES ('92_counterpoint_category_masters_prc_tiers.sql')
ON CONFLICT (version) DO NOTHING;
