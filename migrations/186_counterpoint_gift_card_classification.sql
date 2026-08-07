-- Classify the live Counterpoint SY_GFC programs without overriding any
-- manager-reviewed mappings already stored in Riverside OS.
INSERT INTO public.counterpoint_gift_reason_map (cp_reason_cod, ros_card_kind)
VALUES
  ('GC', 'purchased'),
  ('GC DONATE', 'donated_giveaway'),
  ('PROMO GC', 'promo_gift_card'),
  ('LOYALTY', 'loyalty_reward'),
  ('LOYALTY REWARD', 'loyalty_reward'),
  ('REWARD', 'loyalty_reward'),
  ('DONATION', 'donated_giveaway'),
  ('DONATED', 'donated_giveaway'),
  ('GIVEAWAY', 'donated_giveaway'),
  ('PROMO', 'promo_gift_card'),
  ('PROMOTION', 'promo_gift_card'),
  ('MARKETING', 'promo_gift_card'),
  ('PURCHASED', 'purchased'),
  ('SALE', 'purchased')
ON CONFLICT (cp_reason_cod) DO NOTHING;
