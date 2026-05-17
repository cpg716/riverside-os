-- QBO daily journal support for non-sale inventory receiving activity.
INSERT INTO ledger_mappings (internal_key, internal_description)
VALUES ('INV_RECEIVING_CLEARING', 'Clearing account for received inventory before vendor bill/AP posting')
ON CONFLICT (internal_key) DO NOTHING;
