-- Allow commission combo requirements to target exact SKUs / variants.

ALTER TABLE commission_combo_rule_items
  DROP CONSTRAINT IF EXISTS commission_combo_rule_items_match_type_check;

ALTER TABLE commission_combo_rule_items
  ADD CONSTRAINT commission_combo_rule_items_match_type_check
  CHECK (match_type = ANY (ARRAY['category'::text, 'product'::text, 'variant'::text]));
