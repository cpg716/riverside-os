-- Seed ledger mapping keys needed for QBO inventory and freight journal lines.
-- INV_ASSET: the inventory asset account (Debit on receive, Credit on COGS recognition).
-- COGS_DEFAULT: default cost-of-goods-sold account when category-specific COGS is not mapped.
-- COGS_FREIGHT: inbound freight / shipping cost (separate from COGS — posts to its own expense account).
INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES
    ('INV_ASSET', 'Inventory asset account (merchandise on hand)'),
    ('COGS_DEFAULT', 'Default cost of goods sold account (fallback when category COGS is not mapped)'),
    ('COGS_FREIGHT', 'Inbound freight / shipping cost expense (not part of COGS — separate QBO account)')
ON CONFLICT (internal_key) DO NOTHING;
