-- Add Counterpoint tender aliases observed in live Riverside 2024+ history probes.
INSERT INTO public.counterpoint_payment_method_map (cp_pmt_typ, ros_method)
VALUES
  ('RMS 90 DAY', 'on_account_rms90'),
  ('STORE CRED', 'store_credit'),
  ('LOYALTY', 'gift_card'),
  ('DONATION', 'gift_card'),
  ('PROM GC', 'gift_card')
ON CONFLICT (cp_pmt_typ) DO UPDATE
SET ros_method = EXCLUDED.ros_method;
